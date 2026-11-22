pub mod fixture;
pub mod forms;
pub mod signature;
pub mod trust;

use lopdf::{Document, Object};
use orb_ir::{Diagnostic, DiagnosticSeverity};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use forms::{
    FormFieldType, FormFieldUpdate, FormFieldValue, PdfFormField, PdfPageMetrics,
    apply_form_updates,
};
pub use signature::{
    CertificateInfo, CoverageStatus, IntegrityStatus, PdfSignatureReport,
};
pub use trust::{CertificateTrustProvider, TrustEvaluation, TrustStatus, WebTrustProvider};

#[derive(Debug, Error)]
pub enum PdfError {
    #[error("failed to parse PDF structure: {0}")]
    Parse(String),
    #[error("PDF is encrypted; password-protected PDFs are not yet supported for form/signature inspection")]
    Encrypted,
    #[error("no AcroForm dictionary found in PDF")]
    NoAcroForm,
    #[error("failed to locate PDF cross-reference table for incremental update")]
    MissingXref,
    #[error("PDF form update error: {0}")]
    FormUpdate(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfOutlineItem {
    pub id: String,
    pub title: String,
    pub page_index: Option<usize>,
    pub level: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfInspection {
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub pdf_version: String,
    pub page_count: usize,
    pub pages: Vec<PdfPageMetrics>,
    pub outline: Vec<PdfOutlineItem>,
    pub form_fields: Vec<PdfFormField>,
    pub signatures: Vec<PdfSignatureReport>,
    pub has_signatures: bool,
    pub has_forms: bool,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn inspect_pdf(
    raw_bytes: &[u8],
    filename: Option<&str>,
    trust_provider: &dyn CertificateTrustProvider,
) -> Result<PdfInspection, PdfError> {
    let doc = Document::load_mem(raw_bytes).map_err(|e| PdfError::Parse(e.to_string()))?;

    let mut diagnostics = Vec::new();
    if doc.is_encrypted() {
        return Err(PdfError::Encrypted);
    }

    let (title, author, subject) = extract_info_metadata(&doc);
    let fallback_title = filename.map(|f| {
        f.rsplit_once('.')
            .map(|(stem, _)| stem.to_string())
            .unwrap_or_else(|| f.to_string())
    });

    let pages = forms::extract_page_metrics(&doc);
    let outline = extract_outline(&doc);
    let form_fields = forms::extract_form_fields(&doc, &pages);
    let signatures = signature::inspect_signatures(raw_bytes, &doc, &pages, trust_provider);

    if !signatures.is_empty() && !form_fields.is_empty() {
        let fillable = form_fields
            .iter()
            .any(|f| f.field_type != FormFieldType::Signature && !f.read_only);
        if fillable {
            diagnostics.push(Diagnostic {
                severity: DiagnosticSeverity::Warning,
                code: "PDF_SIGNED_WITH_FORMS".into(),
                message: "This PDF contains digital signatures. Exporting filled form fields appends an incremental update, which preserves prior revisions but may mark signatures as having post-signing modifications.".into(),
            });
        }
    }

    let has_signatures = !signatures.is_empty();
    let has_forms = form_fields
        .iter()
        .any(|f| f.field_type != FormFieldType::Signature);

    Ok(PdfInspection {
        title: title.or(fallback_title),
        author,
        subject,
        pdf_version: doc.version.clone(),
        page_count: pages.len(),
        pages,
        outline,
        form_fields,
        signatures,
        has_signatures,
        has_forms,
        diagnostics,
    })
}

fn extract_info_metadata(doc: &Document) -> (Option<String>, Option<String>, Option<String>) {
    let Ok(info_ref) = doc.trailer.get(b"Info") else {
        return (None, None, None);
    };
    let info_dict = match info_ref {
        Object::Reference(id) => doc.get_dictionary(*id).ok(),
        Object::Dictionary(d) => Some(d),
        _ => None,
    };
    let Some(dict) = info_dict else {
        return (None, None, None);
    };
    (
        read_pdf_string(dict, b"Title"),
        read_pdf_string(dict, b"Author"),
        read_pdf_string(dict, b"Subject"),
    )
}

pub(crate) fn read_pdf_string(dict: &lopdf::Dictionary, key: &[u8]) -> Option<String> {
    let obj = dict.get(key).ok()?;
    pdf_object_to_string(obj)
}

pub(crate) fn pdf_object_to_string(obj: &Object) -> Option<String> {
    match obj {
        Object::String(bytes, _) => Some(decode_pdf_text_string(bytes)),
        Object::Name(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        _ => None,
    }
}

pub(crate) fn decode_pdf_text_string(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else if let Ok(s) = std::str::from_utf8(bytes) {
        s.to_string()
    } else {
        bytes.iter().map(|&b| char::from(b)).collect()
    }
}

fn extract_outline(doc: &Document) -> Vec<PdfOutlineItem> {
    let mut items = Vec::new();
    let page_id_to_index: std::collections::HashMap<lopdf::ObjectId, usize> = doc
        .get_pages()
        .into_iter()
        .enumerate()
        .map(|(idx, (_num, id))| (id, idx))
        .collect();

    let Ok(catalog) = doc.catalog() else {
        return items;
    };
    let Ok(outlines_obj) = catalog.get(b"Outlines") else {
        return items;
    };
    let outlines_dict = match outlines_obj {
        Object::Reference(id) => doc.get_dictionary(*id).ok(),
        Object::Dictionary(d) => Some(d),
        _ => None,
    };
    let Some(root) = outlines_dict else {
        return items;
    };
    if let Ok(Object::Reference(first_id)) = root.get(b"First") {
        let mut next_num = 1usize;
        walk_outline_siblings(
            doc,
            *first_id,
            1,
            &page_id_to_index,
            &mut items,
            &mut next_num,
            0,
        );
    }
    items
}

fn walk_outline_siblings(
    doc: &Document,
    mut current_id: lopdf::ObjectId,
    level: u8,
    page_map: &std::collections::HashMap<lopdf::ObjectId, usize>,
    out: &mut Vec<PdfOutlineItem>,
    next_num: &mut usize,
    depth: usize,
) {
    if depth > 12 {
        return;
    }
    let mut visited = std::collections::HashSet::new();
    while visited.insert(current_id) {
        let Ok(dict) = doc.get_dictionary(current_id) else {
            break;
        };
        if let Some(title) = read_pdf_string(dict, b"Title") {
            let page_index = resolve_outline_page(doc, dict, page_map);
            let id = format!("pdf-outline-{}", *next_num);
            *next_num += 1;
            out.push(PdfOutlineItem {
                id,
                title,
                page_index,
                level: level.clamp(1, 6),
            });
        }
        if let Ok(Object::Reference(child_id)) = dict.get(b"First") {
            walk_outline_siblings(
                doc,
                *child_id,
                level + 1,
                page_map,
                out,
                next_num,
                depth + 1,
            );
        }
        match dict.get(b"Next") {
            Ok(Object::Reference(next_id)) => current_id = *next_id,
            _ => break,
        }
    }
}

fn resolve_outline_page(
    doc: &Document,
    dict: &lopdf::Dictionary,
    page_map: &std::collections::HashMap<lopdf::ObjectId, usize>,
) -> Option<usize> {
    if let Ok(dest) = dict.get(b"Dest") {
        if let Some(idx) = dest_object_to_page(doc, dest, page_map) {
            return Some(idx);
        }
    }
    if let Ok(action) = dict.get(b"A") {
        let act_dict = match action {
            Object::Reference(id) => doc.get_dictionary(*id).ok(),
            Object::Dictionary(d) => Some(d),
            _ => None,
        };
        if let Some(ad) = act_dict {
            if let Ok(d) = ad.get(b"D") {
                return dest_object_to_page(doc, d, page_map);
            }
        }
    }
    None
}

fn dest_object_to_page(
    doc: &Document,
    dest: &Object,
    page_map: &std::collections::HashMap<lopdf::ObjectId, usize>,
) -> Option<usize> {
    let arr = match dest {
        Object::Array(a) => a,
        Object::Reference(id) => match doc.get_object(*id).ok()? {
            Object::Array(a) => a,
            _ => return None,
        },
        _ => return None,
    };
    match arr.first()? {
        Object::Reference(page_id) => page_map.get(page_id).copied(),
        Object::Integer(page_num) if *page_num >= 0 => Some(*page_num as usize),
        _ => None,
    }
}
