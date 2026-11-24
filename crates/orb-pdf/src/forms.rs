use std::collections::{BTreeMap, HashMap};

use lopdf::{Dictionary, Document, Object, ObjectId};
use serde::{Deserialize, Serialize};

use crate::{PdfError, pdf_object_to_string, read_pdf_string};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPageMetrics {
    pub page_index: usize,
    pub width: f32,
    pub height: f32,
    pub media_box: [f32; 4],
    pub crop_box: [f32; 4],
    pub rotation: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FormFieldType {
    Text,
    Checkbox,
    Radio,
    Dropdown,
    Listbox,
    Signature,
    Button,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum FormFieldValue {
    Text(String),
    Bool(bool),
    Choice(String),
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfFormField {
    pub id: String,
    pub object_id: (u32, u16),
    pub parent_object_id: Option<(u32, u16)>,
    pub name: String,
    pub field_type: FormFieldType,
    pub page_index: usize,
    /// PDF user-space [x1, y1, x2, y2] with origin at bottom-left
    pub rect: [f32; 4],
    pub value: FormFieldValue,
    pub options: Vec<String>,
    pub on_state: Option<String>,
    pub multiline: bool,
    pub password: bool,
    pub read_only: bool,
    pub required: bool,
    pub max_len: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormFieldUpdate {
    pub field_name: String,
    pub value: FormFieldValue,
}

pub fn extract_page_metrics(doc: &Document) -> Vec<PdfPageMetrics> {
    let mut result = Vec::new();
    for (idx, (_, page_id)) in doc.get_pages().into_iter().enumerate() {
        let media_box = resolve_inherited_box(doc, page_id, b"MediaBox")
            .unwrap_or([0.0, 0.0, 612.0, 792.0]);
        let crop_box = resolve_inherited_box(doc, page_id, b"CropBox").unwrap_or(media_box);
        let rotation = resolve_inherited_int(doc, page_id, b"Rotate").unwrap_or(0) as i32;

        let raw_w = (crop_box[2] - crop_box[0]).abs();
        let raw_h = (crop_box[3] - crop_box[1]).abs();
        let (width, height) = if rotation.rem_euclid(180) == 90 {
            (raw_h, raw_w)
        } else {
            (raw_w, raw_h)
        };

        result.push(PdfPageMetrics {
            page_index: idx,
            width,
            height,
            media_box,
            crop_box,
            rotation,
        });
    }
    result
}

fn resolve_inherited_box(doc: &Document, mut oid: ObjectId, key: &[u8]) -> Option<[f32; 4]> {
    for _ in 0..16 {
        let dict = doc.get_dictionary(oid).ok()?;
        if let Ok(obj) = dict.get(key) {
            let arr = match obj {
                Object::Array(a) => a,
                Object::Reference(r) => doc.get_object(*r).ok()?.as_array().ok()?,
                _ => return None,
            };
            if arr.len() >= 4 {
                return Some([
                    obj_to_f32(&arr[0])?,
                    obj_to_f32(&arr[1])?,
                    obj_to_f32(&arr[2])?,
                    obj_to_f32(&arr[3])?,
                ]);
            }
        }
        match dict.get(b"Parent").ok() {
            Some(Object::Reference(parent)) => oid = *parent,
            _ => break,
        }
    }
    None
}

fn resolve_inherited_int(doc: &Document, mut oid: ObjectId, key: &[u8]) -> Option<i64> {
    for _ in 0..16 {
        let dict = doc.get_dictionary(oid).ok()?;
        if let Ok(obj) = dict.get(key) {
            if let Ok(n) = obj.as_i64() {
                return Some(n);
            }
        }
        match dict.get(b"Parent").ok() {
            Some(Object::Reference(parent)) => oid = *parent,
            _ => break,
        }
    }
    None
}

fn obj_to_f32(o: &Object) -> Option<f32> {
    match o {
        Object::Real(r) => Some(*r),
        Object::Integer(i) => Some(*i as f32),
        _ => None,
    }
}

#[derive(Clone, Default)]
struct InheritedAttrs {
    ft: Option<Vec<u8>>,
    ff: u32,
    v: Option<Object>,
    opt: Vec<String>,
    max_len: Option<usize>,
    parent_id: Option<ObjectId>,
}

pub fn extract_form_fields(doc: &Document, _pages: &[PdfPageMetrics]) -> Vec<PdfFormField> {
    let mut fields = Vec::new();

    // Build reverse map: widget ObjectId -> page_index from each page's /Annots array
    let mut widget_to_page: HashMap<ObjectId, usize> = HashMap::new();
    let mut page_oid_to_index: HashMap<ObjectId, usize> = HashMap::new();
    for (page_idx, (_, page_id)) in doc.get_pages().into_iter().enumerate() {
        page_oid_to_index.insert(page_id, page_idx);
        let Ok(page_dict) = doc.get_dictionary(page_id) else {
            continue;
        };
        let Ok(annots_obj) = page_dict.get(b"Annots") else {
            continue;
        };
        let annots = match annots_obj {
            Object::Array(a) => a.as_slice(),
            Object::Reference(r) => match doc.get_object(*r).ok() {
                Some(Object::Array(a)) => a.as_slice(),
                _ => continue,
            },
            _ => continue,
        };
        for annot in annots {
            if let Object::Reference(aid) = annot {
                widget_to_page.insert(*aid, page_idx);
            }
        }
    }

    let Ok(catalog) = doc.catalog() else {
        return fields;
    };
    let Ok(af_obj) = catalog.get(b"AcroForm") else {
        return fields;
    };
    let af_dict = match af_obj {
        Object::Reference(id) => doc.get_dictionary(*id).ok(),
        Object::Dictionary(d) => Some(d),
        _ => None,
    };
    let Some(af) = af_dict else {
        return fields;
    };
    let Ok(fields_obj) = af.get(b"Fields") else {
        return fields;
    };
    let top_fields = match fields_obj {
        Object::Array(a) => a.as_slice(),
        Object::Reference(r) => match doc.get_object(*r).ok() {
            Some(Object::Array(a)) => a.as_slice(),
            _ => return fields,
        },
        _ => return fields,
    };

    for item in top_fields {
        if let Object::Reference(fid) = item {
            walk_field(
                doc,
                *fid,
                "",
                &InheritedAttrs::default(),
                &widget_to_page,
                &page_oid_to_index,
                &mut fields,
                0,
            );
        }
    }

    fields
}

#[allow(clippy::too_many_arguments)]
fn walk_field(
    doc: &Document,
    oid: ObjectId,
    prefix: &str,
    inherited: &InheritedAttrs,
    widget_to_page: &HashMap<ObjectId, usize>,
    page_oid_to_index: &HashMap<ObjectId, usize>,
    out: &mut Vec<PdfFormField>,
    depth: usize,
) {
    if depth > 12 {
        return;
    }
    let Ok(dict) = doc.get_dictionary(oid) else {
        return;
    };

    let partial_name = read_pdf_string(dict, b"T");
    let full_name = match (&partial_name, prefix.is_empty()) {
        (Some(t), true) => t.clone(),
        (Some(t), false) => format!("{prefix}.{t}"),
        (None, _) => prefix.to_string(),
    };

    let mut next_inh = inherited.clone();
    if let Ok(ft) = dict.get(b"FT").and_then(|o| o.as_name()) {
        next_inh.ft = Some(ft.to_vec());
    }
    if let Ok(ff) = dict.get(b"Ff").and_then(|o| o.as_i64()) {
        next_inh.ff = ff as u32;
    }
    if let Ok(v) = dict.get(b"V") {
        next_inh.v = Some(v.clone());
    } else if next_inh.v.is_none() {
        if let Ok(dv) = dict.get(b"DV") {
            next_inh.v = Some(dv.clone());
        }
    }
    if let Ok(opt_obj) = dict.get(b"Opt") {
        let parsed = parse_opt_array(doc, opt_obj);
        if !parsed.is_empty() {
            next_inh.opt = parsed;
        }
    }
    if let Ok(ml) = dict.get(b"MaxLen").and_then(|o| o.as_i64()) {
        if ml > 0 {
            next_inh.max_len = Some(ml as usize);
        }
    }

    // Recurse into /Kids if present
    if let Ok(kids_obj) = dict.get(b"Kids") {
        let kids = match kids_obj {
            Object::Array(a) => Some(a.as_slice()),
            Object::Reference(r) => match doc.get_object(*r).ok() {
                Some(Object::Array(a)) => Some(a.as_slice()),
                _ => None,
            },
            _ => None,
        };
        if let Some(arr) = kids {
            if !arr.is_empty() {
                let mut child_inh = next_inh.clone();
                child_inh.parent_id = Some(oid);
                for kid in arr {
                    if let Object::Reference(kid_oid) = kid {
                        walk_field(
                            doc,
                            *kid_oid,
                            &full_name,
                            &child_inh,
                            widget_to_page,
                            page_oid_to_index,
                            out,
                            depth + 1,
                        );
                    }
                }
                // Only emit this node itself if it is ALSO a widget with /Rect
                if !dict.has(b"Rect") {
                    return;
                }
            }
        }
    }

    // Must have a /Rect to be rendered as a widget overlay
    let Some(rect) = extract_rect(dict) else {
        return;
    };

    let page_index = widget_to_page
        .get(&oid)
        .copied()
        .or_else(|| {
            dict.get(b"P").ok().and_then(|o| match o {
                Object::Reference(pid) => page_oid_to_index.get(pid).copied(),
                _ => None,
            })
        })
        .unwrap_or(0);

    let ft = next_inh.ft.as_deref().unwrap_or(b"");
    let ff = next_inh.ff;
    let read_only = (ff & 1) != 0;
    let required = (ff & 2) != 0;
    let multiline = (ff & (1 << 12)) != 0;
    let password = (ff & (1 << 13)) != 0;

    let field_type = match ft {
        b"Tx" => FormFieldType::Text,
        b"Sig" => FormFieldType::Signature,
        b"Ch" => {
            if (ff & (1 << 17)) != 0 {
                FormFieldType::Dropdown
            } else {
                FormFieldType::Listbox
            }
        }
        b"Btn" => {
            if (ff & (1 << 16)) != 0 {
                FormFieldType::Button
            } else if (ff & (1 << 15)) != 0 {
                FormFieldType::Radio
            } else {
                FormFieldType::Checkbox
            }
        }
        _ => return,
    };

    let on_state = if matches!(field_type, FormFieldType::Checkbox | FormFieldType::Radio) {
        Some(detect_on_state(doc, dict).unwrap_or_else(|| "Yes".into()))
    } else {
        None
    };

    let value = match field_type {
        FormFieldType::Text => {
            let s = next_inh
                .v
                .as_ref()
                .and_then(pdf_object_to_string)
                .unwrap_or_default();
            FormFieldValue::Text(s)
        }
        FormFieldType::Dropdown | FormFieldType::Listbox => {
            let s = next_inh
                .v
                .as_ref()
                .and_then(pdf_object_to_string)
                .unwrap_or_default();
            FormFieldValue::Choice(s)
        }
        FormFieldType::Checkbox => {
            let current = dict
                .get(b"AS")
                .ok()
                .and_then(pdf_object_to_string)
                .or_else(|| next_inh.v.as_ref().and_then(pdf_object_to_string))
                .unwrap_or_else(|| "Off".into());
            FormFieldValue::Bool(current != "Off" && !current.is_empty())
        }
        FormFieldType::Radio => {
            let current = next_inh
                .v
                .as_ref()
                .and_then(pdf_object_to_string)
                .or_else(|| dict.get(b"AS").ok().and_then(pdf_object_to_string))
                .unwrap_or_else(|| "Off".into());
            FormFieldValue::Choice(current)
        }
        FormFieldType::Signature | FormFieldType::Button => FormFieldValue::None,
    };

    let id = format!("field-{}-{}-{}", oid.0, oid.1, out.len());
    out.push(PdfFormField {
        id,
        object_id: oid,
        parent_object_id: next_inh.parent_id,
        name: if full_name.is_empty() {
            format!("Field_{}", oid.0)
        } else {
            full_name
        },
        field_type,
        page_index,
        rect,
        value,
        options: next_inh.opt,
        on_state,
        multiline,
        password,
        read_only,
        required,
        max_len: next_inh.max_len,
    });
}

fn parse_opt_array(doc: &Document, obj: &Object) -> Vec<String> {
    let arr = match obj {
        Object::Array(a) => a,
        Object::Reference(r) => match doc.get_object(*r).ok() {
            Some(Object::Array(a)) => a,
            _ => return Vec::new(),
        },
        _ => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in arr {
        match entry {
            Object::Array(pair) => {
                // [exportVal, displayVal]
                if let Some(s) = pair
                    .get(1)
                    .or_else(|| pair.first())
                    .and_then(pdf_object_to_string)
                {
                    out.push(s);
                }
            }
            other => {
                if let Some(s) = pdf_object_to_string(other) {
                    out.push(s);
                }
            }
        }
    }
    out
}

fn detect_on_state(doc: &Document, widget_dict: &Dictionary) -> Option<String> {
    let ap_obj = widget_dict.get(b"AP").ok()?;
    let ap_dict = match ap_obj {
        Object::Dictionary(d) => d,
        Object::Reference(r) => doc.get_dictionary(*r).ok()?,
        _ => return None,
    };
    let n_obj = ap_dict.get(b"N").ok()?;
    let n_dict = match n_obj {
        Object::Dictionary(d) => d,
        Object::Reference(r) => doc.get_dictionary(*r).ok()?,
        _ => return None,
    };
    for (k, _) in n_dict.iter() {
        if k != b"Off" {
            return Some(String::from_utf8_lossy(k).into_owned());
        }
    }
    None
}

fn extract_rect(dict: &Dictionary) -> Option<[f32; 4]> {
    let arr = dict.get(b"Rect").ok()?.as_array().ok()?;
    if arr.len() < 4 {
        return None;
    }
    Some([
        obj_to_f32(&arr[0])?,
        obj_to_f32(&arr[1])?,
        obj_to_f32(&arr[2])?,
        obj_to_f32(&arr[3])?,
    ])
}

/// Applies AcroForm field updates as a spec-compliant PDF incremental update appended
/// after the original `%%EOF`. Preserves all original bytes untouched and regenerates
/// `/AP /N` appearance streams so filled values render reliably across all PDF viewers.
pub fn apply_form_updates(
    raw_pdf: &[u8],
    updates: &[FormFieldUpdate],
) -> Result<Vec<u8>, PdfError> {
    if updates.is_empty() {
        return Ok(raw_pdf.to_vec());
    }

    let doc = Document::load_mem(raw_pdf).map_err(|e| PdfError::Parse(e.to_string()))?;
    let pages = extract_page_metrics(&doc);
    let fields = extract_form_fields(&doc, &pages);

    let prev_startxref = find_last_startxref(raw_pdf).ok_or(PdfError::MissingXref)?;
    let prev_is_xref_stream = is_xref_stream_at(raw_pdf, prev_startxref);

    let root_ref = doc
        .trailer
        .get(b"Root")
        .ok()
        .and_then(|o| o.as_reference().ok())
        .ok_or_else(|| PdfError::FormUpdate("missing /Root in PDF trailer".into()))?;
    let info_ref = doc
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|o| o.as_reference().ok());

    let mut update_map: HashMap<&str, &FormFieldValue> = HashMap::new();
    for u in updates {
        update_map.insert(u.field_name.as_str(), &u.value);
    }

    let mut next_obj_num = doc.max_id.max(
        doc.objects.keys().map(|(id, _)| *id).max().unwrap_or(0),
    ) + 1;

    // Objects to emit in incremental update: obj_num -> serialized object body (without `N 0 obj ... endobj`)
    let mut new_objects: BTreeMap<u32, Vec<u8>> = BTreeMap::new();

    // Allocate standard Type1 Helvetica & ZapfDingbats fonts for generated appearance streams
    let helv_id = next_obj_num;
    next_obj_num += 1;
    new_objects.insert(
        helv_id,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            .to_vec(),
    );
    let zadb_id = next_obj_num;
    next_obj_num += 1;
    new_objects.insert(
        zadb_id,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>".to_vec(),
    );

    // Group radio buttons by parent_object_id so parent /V and each kid /AS update together
    let mut updated_parents: HashMap<ObjectId, Dictionary> = HashMap::new();

    for field in &fields {
        let Some(new_val) = update_map.get(field.name.as_str()) else {
            continue;
        };
        if field.read_only || field.field_type == FormFieldType::Signature {
            continue;
        }

        let Ok(mut widget_dict) = doc.get_dictionary(field.object_id).cloned() else {
            continue;
        };

        let width = (field.rect[2] - field.rect[0]).abs().max(8.0);
        let height = (field.rect[3] - field.rect[1]).abs().max(8.0);

        match (field.field_type, new_val) {
            (FormFieldType::Text, FormFieldValue::Text(s))
            | (FormFieldType::Dropdown, FormFieldValue::Choice(s))
            | (FormFieldType::Listbox, FormFieldValue::Choice(s)) => {
                let pdf_str = Object::String(s.as_bytes().to_vec(), lopdf::StringFormat::Literal);
                if let Some(pid) = field.parent_object_id {
                    let parent = updated_parents
                        .entry(pid)
                        .or_insert_with(|| doc.get_dictionary(pid).cloned().unwrap_or_default());
                    parent.set("V", pdf_str.clone());
                } else {
                    widget_dict.set("V", pdf_str);
                }

                // Generate crisp /AP /N appearance XObject stream
                let ap_id = next_obj_num;
                next_obj_num += 1;
                let stream_bytes = build_text_appearance_stream(
                    s,
                    width,
                    height,
                    field.multiline,
                    field.password,
                    helv_id,
                );
                new_objects.insert(ap_id, stream_bytes);

                let mut ap = Dictionary::new();
                ap.set("N", Object::Reference((ap_id, 0)));
                widget_dict.set("AP", Object::Dictionary(ap));
                new_objects.insert(field.object_id.0, serialize_dict(&widget_dict));
            }
            (FormFieldType::Checkbox, FormFieldValue::Bool(checked)) => {
                let on_name = field.on_state.as_deref().unwrap_or("Yes");
                let state_name = if *checked { on_name } else { "Off" };

                widget_dict.set("V", Object::Name(state_name.as_bytes().to_vec()));
                widget_dict.set("AS", Object::Name(state_name.as_bytes().to_vec()));

                let on_ap_id = next_obj_num;
                next_obj_num += 1;
                new_objects.insert(
                    on_ap_id,
                    build_checkbox_appearance_stream(true, width, height, zadb_id),
                );
                let off_ap_id = next_obj_num;
                next_obj_num += 1;
                new_objects.insert(
                    off_ap_id,
                    build_checkbox_appearance_stream(false, width, height, zadb_id),
                );

                let mut n_dict = Dictionary::new();
                n_dict.set(on_name.as_bytes(), Object::Reference((on_ap_id, 0)));
                n_dict.set(b"Off", Object::Reference((off_ap_id, 0)));
                let mut ap = Dictionary::new();
                ap.set("N", Object::Dictionary(n_dict));
                widget_dict.set("AP", Object::Dictionary(ap));

                new_objects.insert(field.object_id.0, serialize_dict(&widget_dict));
            }
            (FormFieldType::Radio, FormFieldValue::Choice(selected)) => {
                let on_name = field.on_state.as_deref().unwrap_or("Yes");
                let is_selected = selected == on_name;
                let state_name = if is_selected { on_name } else { "Off" };

                if let Some(pid) = field.parent_object_id {
                    let parent = updated_parents
                        .entry(pid)
                        .or_insert_with(|| doc.get_dictionary(pid).cloned().unwrap_or_default());
                    parent.set("V", Object::Name(selected.as_bytes().to_vec()));
                } else {
                    widget_dict.set("V", Object::Name(state_name.as_bytes().to_vec()));
                }
                widget_dict.set("AS", Object::Name(state_name.as_bytes().to_vec()));

                let on_ap_id = next_obj_num;
                next_obj_num += 1;
                new_objects.insert(
                    on_ap_id,
                    build_radio_appearance_stream(true, width, height),
                );
                let off_ap_id = next_obj_num;
                next_obj_num += 1;
                new_objects.insert(
                    off_ap_id,
                    build_radio_appearance_stream(false, width, height),
                );

                let mut n_dict = Dictionary::new();
                n_dict.set(on_name.as_bytes(), Object::Reference((on_ap_id, 0)));
                n_dict.set(b"Off", Object::Reference((off_ap_id, 0)));
                let mut ap = Dictionary::new();
                ap.set("N", Object::Dictionary(n_dict));
                widget_dict.set("AP", Object::Dictionary(ap));

                new_objects.insert(field.object_id.0, serialize_dict(&widget_dict));
            }
            _ => {}
        }
    }

    for (pid, pdict) in updated_parents {
        new_objects.insert(pid.0, serialize_dict(&pdict));
    }

    // Update AcroForm with NeedAppearances = false (since we emit real /AP streams!) + /DR fonts
    if let Ok(catalog) = doc.catalog() {
        if let Ok(Object::Reference(af_id)) = catalog.get(b"AcroForm") {
            if let Ok(mut af_dict) = doc.get_dictionary(*af_id).cloned() {
                af_dict.set("NeedAppearances", Object::Boolean(false));
                let mut font_dict = Dictionary::new();
                font_dict.set("Helv", Object::Reference((helv_id, 0)));
                font_dict.set("ZaDb", Object::Reference((zadb_id, 0)));
                let mut dr = Dictionary::new();
                dr.set("Font", Object::Dictionary(font_dict));
                af_dict.set("DR", Object::Dictionary(dr));
                new_objects.insert(af_id.0, serialize_dict(&af_dict));
            }
        }
    }

    // Assemble incremental update appended cleanly onto exact original bytes
    let mut out = raw_pdf.to_vec();
    if !out.ends_with(b"\n") {
        out.push(b'\n');
    }

    let mut offsets: BTreeMap<u32, usize> = BTreeMap::new();
    for (&obj_num, body) in &new_objects {
        offsets.insert(obj_num, out.len());
        out.extend_from_slice(format!("{obj_num} 0 obj\n").as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }

    if prev_is_xref_stream {
        // ISO 32000-1 Section 7.5.8.4: incremental update onto an XRef-stream PDF must emit an XRef stream
        let xref_obj_num = next_obj_num;
        let xref_offset = out.len();
        offsets.insert(xref_obj_num, xref_offset);
        let new_size = xref_obj_num + 1;

        let (index_arr, stream_data) = build_xref_stream_entries(&offsets);
        let mut dict_str = format!(
            "<< /Type /XRef /Size {new_size} /Root {} {} R /Prev {prev_startxref} /W [1 4 2] /Index [{index_arr}] /Length {} ",
            root_ref.0,
            root_ref.1,
            stream_data.len()
        );
        if let Some(ir) = info_ref {
            dict_str.push_str(&format!("/Info {} {} R ", ir.0, ir.1));
        }
        dict_str.push_str(">>");

        out.extend_from_slice(format!("{xref_obj_num} 0 obj\n{dict_str}\nstream\n").as_bytes());
        out.extend_from_slice(&stream_data);
        out.extend_from_slice(b"\nendstream\nendobj\n");
        out.extend_from_slice(format!("startxref\n{xref_offset}\n%%EOF\n").as_bytes());
    } else {
        // Classic cross-reference table + trailer
        let xref_offset = out.len();
        let new_size = next_obj_num.max(
            offsets.keys().copied().max().unwrap_or(0) + 1,
        );

        out.extend_from_slice(b"xref\n");
        // Emit contiguous subsections
        let keys: Vec<u32> = offsets.keys().copied().collect();
        let mut i = 0;
        while i < keys.len() {
            let start = keys[i];
            let mut end = i + 1;
            while end < keys.len() && keys[end] == keys[end - 1] + 1 {
                end += 1;
            }
            let count = end - i;
            out.extend_from_slice(format!("{start} {count}\n").as_bytes());
            for &k in &keys[i..end] {
                let off = offsets[&k];
                out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
            }
            i = end;
        }

        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {new_size} /Root {} {} R /Prev {prev_startxref}",
                root_ref.0, root_ref.1
            )
            .as_bytes(),
        );
        if let Some(ir) = info_ref {
            out.extend_from_slice(format!(" /Info {} {} R", ir.0, ir.1).as_bytes());
        }
        out.extend_from_slice(format!(" >>\nstartxref\n{xref_offset}\n%%EOF\n").as_bytes());
    }

    Ok(out)
}

fn build_xref_stream_entries(offsets: &BTreeMap<u32, usize>) -> (String, Vec<u8>) {
    let keys: Vec<u32> = offsets.keys().copied().collect();
    let mut index_parts = Vec::new();
    let mut stream_data = Vec::new();

    let mut i = 0;
    while i < keys.len() {
        let start = keys[i];
        let mut end = i + 1;
        while end < keys.len() && keys[end] == keys[end - 1] + 1 {
            end += 1;
        }
        let count = end - i;
        index_parts.push(format!("{start} {count}"));
        for &k in &keys[i..end] {
            let off = offsets[&k] as u32;
            stream_data.push(1u8); // type 1 = in-use indirect object
            stream_data.extend_from_slice(&off.to_be_bytes());
            stream_data.extend_from_slice(&0u16.to_be_bytes());
        }
        i = end;
    }

    (index_parts.join(" "), stream_data)
}

fn find_last_startxref(raw: &[u8]) -> Option<usize> {
    let needle = b"startxref";
    let pos = raw
        .windows(needle.len())
        .rposition(|w| w == needle)?;
    let after = &raw[pos + needle.len()..];
    let s = std::str::from_utf8(after).ok()?;
    let token = s.split_whitespace().next()?;
    token.parse::<usize>().ok()
}

fn is_xref_stream_at(raw: &[u8], offset: usize) -> bool {
    let Some(slice) = raw.get(offset..) else {
        return false;
    };
    let trimmed = slice
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .map(|i| &slice[i..])
        .unwrap_or(slice);
    !trimmed.starts_with(b"xref")
}

fn build_text_appearance_stream(
    text: &str,
    width: f32,
    height: f32,
    multiline: bool,
    password: bool,
    helv_obj_num: u32,
) -> Vec<u8> {
    let display = if password {
        "*".repeat(text.chars().count())
    } else {
        text.to_string()
    };

    let font_size: f32 = if multiline {
        10.0
    } else {
        (height * 0.58).clamp(8.0, 12.0)
    };
    let line_height = font_size * 1.3;

    let mut content = String::new();
    content.push_str("q\n");
    content.push_str(&format!("0 0 {width:.2} {height:.2} re W n\n"));
    content.push_str("BT\n");
    content.push_str(&format!("/Helv {font_size:.1} Tf\n"));
    content.push_str("0.11 0.12 0.14 rg\n");

    if multiline {
        let mut y = height - font_size - 4.0;
        for line in display.lines() {
            if y < 2.0 {
                break;
            }
            content.push_str(&format!(
                "1 0 0 1 4.00 {y:.2} Tm ({}) Tj\n",
                escape_pdf_literal(line)
            ));
            y -= line_height;
        }
    } else {
        let y = ((height - font_size) * 0.5 + font_size * 0.16).max(2.0);
        content.push_str(&format!(
            "1 0 0 1 4.00 {y:.2} Tm ({}) Tj\n",
            escape_pdf_literal(&display)
        ));
    }

    content.push_str("ET\nQ\n");

    format!(
        "<< /Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 {width:.2} {height:.2}] \
         /Resources << /Font << /Helv {helv_obj_num} 0 R >> >> /Length {} >>\n\
         stream\n{content}endstream",
        content.len()
    )
    .into_bytes()
}

fn build_checkbox_appearance_stream(
    checked: bool,
    width: f32,
    height: f32,
    zadb_obj_num: u32,
) -> Vec<u8> {
    let mut content = String::new();
    content.push_str("q\n");
    content.push_str("0.98 0.98 0.99 rg\n");
    content.push_str(&format!("0.5 0.5 {:.2} {:.2} re f\n", width - 1.0, height - 1.0));
    content.push_str("0.25 0.28 0.34 RG 0.8 w\n");
    content.push_str(&format!("0.5 0.5 {:.2} {:.2} re S\n", width - 1.0, height - 1.0));
    if checked {
        let fs = (width.min(height) * 0.78).clamp(8.0, 16.0);
        let x = ((width - fs * 0.72) * 0.5).max(1.5);
        let y = ((height - fs * 0.78) * 0.5).max(1.5);
        content.push_str("BT\n");
        content.push_str(&format!("/ZaDb {fs:.1} Tf\n"));
        content.push_str("0.12 0.35 0.78 rg\n");
        content.push_str(&format!("1 0 0 1 {x:.2} {y:.2} Tm (4) Tj\n"));
        content.push_str("ET\n");
    }
    content.push_str("Q\n");

    format!(
        "<< /Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 {width:.2} {height:.2}] \
         /Resources << /Font << /ZaDb {zadb_obj_num} 0 R >> >> /Length {} >>\n\
         stream\n{content}endstream",
        content.len()
    )
    .into_bytes()
}

fn build_radio_appearance_stream(selected: bool, width: f32, height: f32) -> Vec<u8> {
    let cx = width / 2.0;
    let cy = height / 2.0;
    let r = (width.min(height) / 2.0 - 1.0).max(2.0);
    let k = r * 0.5522847;
    let mut content = String::new();
    content.push_str("q\n0.25 0.28 0.34 RG 0.9 w\n");
    content.push_str(&circle_path(cx, cy, r, k));
    content.push_str("S\n");
    if selected {
        let ir = (r * 0.52).max(1.2);
        let ik = ir * 0.5522847;
        content.push_str("0.12 0.35 0.78 rg\n");
        content.push_str(&circle_path(cx, cy, ir, ik));
        content.push_str("f\n");
    }
    content.push_str("Q\n");

    format!(
        "<< /Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 {width:.2} {height:.2}] \
         /Length {} >>\nstream\n{content}endstream",
        content.len()
    )
    .into_bytes()
}

fn circle_path(cx: f32, cy: f32, r: f32, k: f32) -> String {
    format!(
        "{:.2} {:.2} m\n\
         {:.2} {:.2} {:.2} {:.2} {:.2} {:.2} c\n\
         {:.2} {:.2} {:.2} {:.2} {:.2} {:.2} c\n\
         {:.2} {:.2} {:.2} {:.2} {:.2} {:.2} c\n\
         {:.2} {:.2} {:.2} {:.2} {:.2} {:.2} c\n",
        cx + r, cy,
        cx + r, cy + k, cx + k, cy + r, cx, cy + r,
        cx - k, cy + r, cx - r, cy + k, cx - r, cy,
        cx - r, cy - k, cx - k, cy - r, cx, cy - r,
        cx + k, cy - r, cx + r, cy - k, cx + r, cy,
    )
}

fn escape_pdf_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '(' => out.push_str("\\("),
            ')' => out.push_str("\\)"),
            c if c.is_ascii() && !c.is_ascii_control() => out.push(c),
            _ => out.push(' '),
        }
    }
    out
}

fn serialize_dict(dict: &Dictionary) -> Vec<u8> {
    let mut out = Vec::new();
    write_object(&Object::Dictionary(dict.clone()), &mut out);
    out
}

fn write_object(obj: &Object, out: &mut Vec<u8>) {
    match obj {
        Object::Null => out.extend_from_slice(b"null"),
        Object::Boolean(b) => out.extend_from_slice(if *b { b"true" } else { b"false" }),
        Object::Integer(i) => out.extend_from_slice(i.to_string().as_bytes()),
        Object::Real(r) => out.extend_from_slice(format!("{r:.4}").as_bytes()),
        Object::Name(n) => {
            out.push(b'/');
            for &b in n {
                if b <= 32 || b >= 127 || b == b'#' || b == b'/' || b == b'(' || b == b')' {
                    out.extend_from_slice(format!("#{b:02X}").as_bytes());
                } else {
                    out.push(b);
                }
            }
        }
        Object::String(bytes, lopdf::StringFormat::Hexadecimal) => {
            out.push(b'<');
            for &b in bytes {
                out.extend_from_slice(format!("{b:02X}").as_bytes());
            }
            out.push(b'>');
        }
        Object::String(bytes, lopdf::StringFormat::Literal) => {
            out.push(b'(');
            for &b in bytes {
                match b {
                    b'\\' => out.extend_from_slice(b"\\\\"),
                    b'(' => out.extend_from_slice(b"\\("),
                    b')' => out.extend_from_slice(b"\\)"),
                    b'\n' => out.extend_from_slice(b"\\n"),
                    b'\r' => out.extend_from_slice(b"\\r"),
                    _ => out.push(b),
                }
            }
            out.push(b')');
        }
        Object::Array(arr) => {
            out.push(b'[');
            for (i, item) in arr.iter().enumerate() {
                if i > 0 {
                    out.push(b' ');
                }
                write_object(item, out);
            }
            out.push(b']');
        }
        Object::Dictionary(dict) => {
            out.extend_from_slice(b"<< ");
            for (k, v) in dict.iter() {
                write_object(&Object::Name(k.clone()), out);
                out.push(b' ');
                write_object(v, out);
                out.push(b' ');
            }
            out.extend_from_slice(b">>");
        }
        Object::Reference((id, gen_num)) => {
            out.extend_from_slice(format!("{id} {gen_num} R").as_bytes());
        }
        Object::Stream(stream) => {
            write_object(&Object::Dictionary(stream.dict.clone()), out);
            out.extend_from_slice(b"\nstream\n");
            out.extend_from_slice(&stream.content);
            out.extend_from_slice(b"\nendstream");
        }
    }
}
