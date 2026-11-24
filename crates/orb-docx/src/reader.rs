use std::collections::HashMap;
use std::io::{Cursor, Read};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use orb_ir::{
    Block, BlockKind, DiagnosticSeverity, DocumentFormat, DocumentIr, InlineRun, ListItem,
    MediaAsset, TableCell, TableRow, TextAlign, TextStyle, merge_adjacent_runs,
};
use quick_xml::{Reader, XmlVersion};
use quick_xml::events::{BytesRef, BytesStart, Event};
use zip::ZipArchive;

use crate::DocxError;

#[derive(Debug, Clone, Default)]
struct StyleInfo {
    name: String,
    heading_level: Option<u8>,
    is_quote: bool,
    is_code: bool,
    based_on: Option<String>,
}

#[derive(Debug, Clone)]
struct RelEntry {
    target: String,
}

#[derive(Debug, Clone, Default)]
struct NumberingMap {
    /// numId -> abstractNumId
    num_to_abstract: HashMap<String, String>,
    /// (abstractNumId, ilvl) -> ordered (true for decimal/roman/letter, false for bullet)
    level_ordered: HashMap<(String, u8), bool>,
}

impl NumberingMap {
    fn is_ordered(&self, num_id: &str, ilvl: u8) -> bool {
        if let Some(abs_id) = self.num_to_abstract.get(num_id) {
            if let Some(&ordered) = self.level_ordered.get(&(abs_id.clone(), ilvl)) {
                return ordered;
            }
            if let Some(&ordered) = self.level_ordered.get(&(abs_id.clone(), 0)) {
                return ordered;
            }
        }
        false
    }
}

pub fn parse_docx(bytes: &[u8], filename: Option<&str>) -> Result<DocumentIr, DocxError> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))?;

    let fallback_title = filename.map(|f| {
        f.rsplit_once('.')
            .map(|(stem, _)| stem.to_string())
            .unwrap_or_else(|| f.to_string())
    });
    let mut doc = DocumentIr::new(DocumentFormat::Docx, None);

    // Inspect archive entries for compatibility diagnostics (macros, SmartArt)
    let mut has_vba = false;
    let mut has_smartart = false;
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            if let Ok(name) = entry.name() {
                if name.ends_with("vbaProject.bin") {
                    has_vba = true;
                } else if name.starts_with("word/diagrams/") {
                    has_smartart = true;
                }
            }
        }
    }
    if has_vba {
        doc.add_diagnostic(
            DiagnosticSeverity::Warning,
            "DOCX_MACROS_IGNORED",
            "Document contains VBA macros (vbaProject.bin); macros are never executed by Orb.",
        );
    }
    if has_smartart {
        doc.add_diagnostic(
            DiagnosticSeverity::Info,
            "DOCX_SMARTART_SIMPLIFIED",
            "Document contains SmartArt diagrams; diagram visual layouts are omitted in canonical view.",
        );
    }

    // Core metadata (docProps/core.xml)
    if let Some(core_xml) = read_zip_string(&mut archive, "docProps/core.xml")? {
        parse_core_properties(&core_xml, &mut doc);
    }

    // Relationships (word/_rels/document.xml.rels)
    let rels =
        if let Some(rels_xml) = read_zip_string(&mut archive, "word/_rels/document.xml.rels")? {
            parse_relationships(&rels_xml)?
        } else {
            HashMap::new()
        };

    // Styles (word/styles.xml)
    let styles = if let Some(styles_xml) = read_zip_string(&mut archive, "word/styles.xml")? {
        parse_styles(&styles_xml)?
    } else {
        HashMap::new()
    };

    // Numbering (word/numbering.xml)
    let numbering = if let Some(num_xml) = read_zip_string(&mut archive, "word/numbering.xml")? {
        parse_numbering(&num_xml)?
    } else {
        NumberingMap::default()
    };

    // Main document XML
    let document_xml = read_zip_string(&mut archive, "word/document.xml")?
        .ok_or(DocxError::MissingPart("word/document.xml"))?;

    let mut ctx = ParseCtx {
        archive: &mut archive,
        rels: &rels,
        styles: &styles,
        numbering: &numbering,
        assets: Vec::new(),
        asset_by_rel: HashMap::new(),
        next_id: 1,
        saw_tracked_changes: false,
    };

    let mut blocks = parse_body_xml(&document_xml, &mut ctx)?;

    // Optional footnotes
    if let Some(fn_xml) = read_zip_string(ctx.archive, "word/footnotes.xml")? {
        let mut footnotes = parse_footnotes(&fn_xml, &mut ctx)?;
        blocks.append(&mut footnotes);
    }

    if ctx.saw_tracked_changes {
        doc.add_diagnostic(
            DiagnosticSeverity::Info,
            "DOCX_TRACKED_CHANGES",
            "Document contains tracked changes; inserted text is shown and deletions are omitted.",
        );
    }

    doc.blocks = blocks;
    doc.assets = ctx.assets;
    if doc.title.is_none() {
        doc.title = fallback_title;
    }
    doc.finalize();
    Ok(doc)
}

fn read_zip_string(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    path: &str,
) -> Result<Option<String>, DocxError> {
    match archive.by_name(path) {
        Ok(mut file) => {
            let mut s = String::new();
            file.read_to_string(&mut s)?;
            Ok(Some(s))
        }
        Err(zip::result::ZipError::FileNotFound) => Ok(None),
        Err(e) => Err(DocxError::Zip(e)),
    }
}

fn read_zip_bytes(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    path: &str,
) -> Result<Option<Vec<u8>>, DocxError> {
    match archive.by_name(path) {
        Ok(mut file) => {
            let mut buf = Vec::new();
            file.read_to_end(&mut buf)?;
            Ok(Some(buf))
        }
        Err(zip::result::ZipError::FileNotFound) => Ok(None),
        Err(e) => Err(DocxError::Zip(e)),
    }
}

fn local_name(raw: &str) -> &str {
    raw.rsplit_once(':').map_or(raw, |(_, local)| local)
}

fn resolve_general_ref(r: &BytesRef<'_>) -> String {
    if let Ok(Some(ch)) = r.resolve_char_ref() {
        return ch.to_string();
    }
    match r.as_ref() {
        "lt" => "<".to_string(),
        "gt" => ">".to_string(),
        "amp" => "&".to_string(),
        "apos" => "'".to_string(),
        "quot" => "\"".to_string(),
        other => format!("&{other};"),
    }
}

fn attr_value(e: &BytesStart<'_>, target_local: &str) -> Option<String> {
    for attr in e.attributes().flatten() {
        if local_name(attr.key.as_ref()) == target_local {
            return Some(
                attr.normalized_value(XmlVersion::Implicit1_0)
                    .unwrap_or(attr.value)
                    .into_owned(),
            );
        }
    }
    None
}

fn parse_core_properties(xml: &str, doc: &mut DocumentIr) {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut depth: usize = 0;
    let mut active_tag: Option<String> = None;
    let mut cur_text = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                depth += 1;
                if depth == 2 {
                    let qname = e.name();
                    let name = local_name(qname.as_ref());
                    if matches!(
                        name,
                        "title" | "creator" | "subject" | "created" | "modified"
                    ) {
                        active_tag = Some(name.to_string());
                        cur_text.clear();
                    }
                }
            }
            Ok(Event::End(_)) => {
                if depth == 2 {
                    if let Some(tag) = active_tag.take() {
                        let val = cur_text.trim();
                        if !val.is_empty() {
                            match tag.as_str() {
                                "title" => doc.title = Some(val.to_string()),
                                "creator" => doc.metadata.author = Some(val.to_string()),
                                "subject" => doc.metadata.subject = Some(val.to_string()),
                                "created" => doc.metadata.created = Some(val.to_string()),
                                "modified" => doc.metadata.modified = Some(val.to_string()),
                                _ => {}
                            }
                        }
                    }
                    cur_text.clear();
                }
                depth = depth.saturating_sub(1);
            }
            Ok(Event::Text(t)) => {
                if active_tag.is_some() {
                    cur_text.push_str(&t.xml10_content());
                }
            }
            Ok(Event::CData(c)) => {
                if active_tag.is_some() {
                    cur_text.push_str(&c.xml10_content());
                }
            }
            Ok(Event::GeneralRef(r)) => {
                if active_tag.is_some() {
                    cur_text.push_str(&resolve_general_ref(&r));
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
}

fn parse_relationships(xml: &str) -> Result<HashMap<String, RelEntry>, DocxError> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut map = HashMap::new();

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Empty(e) | Event::Start(e)
                if local_name(e.name().as_ref()) == "Relationship" =>
            {
                if let (Some(id), Some(target)) = (attr_value(&e, "Id"), attr_value(&e, "Target")) {
                    map.insert(id, RelEntry { target });
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(map)
}

fn parse_styles(xml: &str) -> Result<HashMap<String, StyleInfo>, DocxError> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut map: HashMap<String, StyleInfo> = HashMap::new();
    let mut cur_id: Option<String> = None;
    let mut cur = StyleInfo::default();

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => match local_name(e.name().as_ref()) {
                "style" => {
                    cur_id = attr_value(&e, "styleId");
                    cur = StyleInfo::default();
                }
                "name" if cur_id.is_some() => {
                    if let Some(val) = attr_value(&e, "val") {
                        cur.name = val;
                    }
                }
                "basedOn" if cur_id.is_some() => {
                    cur.based_on = attr_value(&e, "val");
                }
                "outlineLvl" if cur_id.is_some() => {
                    if let Some(val) = attr_value(&e, "val").and_then(|v| v.parse::<u8>().ok()) {
                        if val < 6 {
                            cur.heading_level = Some(val + 1);
                        }
                    }
                }
                _ => {}
            },
            Event::Empty(e) if cur_id.is_some() => match local_name(e.name().as_ref()) {
                "name" => {
                    if let Some(val) = attr_value(&e, "val") {
                        cur.name = val;
                    }
                }
                "basedOn" => {
                    cur.based_on = attr_value(&e, "val");
                }
                "outlineLvl" => {
                    if let Some(val) = attr_value(&e, "val").and_then(|v| v.parse::<u8>().ok()) {
                        if val < 6 {
                            cur.heading_level = Some(val + 1);
                        }
                    }
                }
                _ => {}
            },
            Event::End(e) if local_name(e.name().as_ref()) == "style" => {
                if let Some(id) = cur_id.take() {
                    let lower_name = cur.name.to_ascii_lowercase();
                    let lower_id = id.to_ascii_lowercase();
                    if cur.heading_level.is_none() {
                        cur.heading_level = infer_heading_level(&lower_name)
                            .or_else(|| infer_heading_level(&lower_id));
                    }
                    if lower_name.contains("quote") || lower_id.contains("quote") {
                        cur.is_quote = true;
                    }
                    if lower_name.contains("code") || lower_id.contains("code") {
                        cur.is_code = true;
                    }
                    map.insert(id, std::mem::take(&mut cur));
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    // Resolve one-level basedOn inheritance for heading levels
    let snapshot = map.clone();
    for info in map.values_mut() {
        if info.heading_level.is_none() {
            if let Some(parent_id) = &info.based_on {
                if let Some(parent) = snapshot.get(parent_id) {
                    info.heading_level = parent.heading_level;
                }
            }
        }
    }

    Ok(map)
}

fn infer_heading_level(name: &str) -> Option<u8> {
    if name == "title" {
        return Some(1);
    }
    if name == "subtitle" {
        return Some(2);
    }
    if let Some(rest) = name.strip_prefix("heading") {
        let digits = rest.trim().trim_start_matches('-');
        if let Ok(lvl) = digits.parse::<u8>() {
            if (1..=6).contains(&lvl) {
                return Some(lvl);
            }
        }
    }
    None
}

fn parse_numbering(xml: &str) -> Result<NumberingMap, DocxError> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut map = NumberingMap::default();

    let mut cur_abstract: Option<String> = None;
    let mut cur_ilvl: Option<u8> = None;
    let mut cur_num: Option<String> = None;

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => match local_name(e.name().as_ref()) {
                "abstractNum" => cur_abstract = attr_value(&e, "abstractNumId"),
                "lvl" if cur_abstract.is_some() => {
                    cur_ilvl = attr_value(&e, "ilvl").and_then(|v| v.parse::<u8>().ok());
                }
                "num" => cur_num = attr_value(&e, "numId"),
                "numFmt" => {
                    if let (Some(abs), Some(ilvl), Some(fmt)) =
                        (&cur_abstract, cur_ilvl, attr_value(&e, "val"))
                    {
                        let ordered = !matches!(fmt.as_str(), "bullet" | "none");
                        map.level_ordered.insert((abs.clone(), ilvl), ordered);
                    }
                }
                "abstractNumId" => {
                    if let (Some(num_id), Some(abs_id)) = (&cur_num, attr_value(&e, "val")) {
                        map.num_to_abstract.insert(num_id.clone(), abs_id);
                    }
                }
                _ => {}
            },
            Event::Empty(e) => match local_name(e.name().as_ref()) {
                "numFmt" => {
                    if let (Some(abs), Some(ilvl), Some(fmt)) =
                        (&cur_abstract, cur_ilvl, attr_value(&e, "val"))
                    {
                        let ordered = !matches!(fmt.as_str(), "bullet" | "none");
                        map.level_ordered.insert((abs.clone(), ilvl), ordered);
                    }
                }
                "abstractNumId" => {
                    if let (Some(num_id), Some(abs_id)) = (&cur_num, attr_value(&e, "val")) {
                        map.num_to_abstract.insert(num_id.clone(), abs_id);
                    }
                }
                _ => {}
            },
            Event::End(e) => match local_name(e.name().as_ref()) {
                "abstractNum" => {
                    cur_abstract = None;
                    cur_ilvl = None;
                }
                "lvl" => cur_ilvl = None,
                "num" => cur_num = None,
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(map)
}

struct ParseCtx<'a> {
    archive: &'a mut ZipArchive<Cursor<&'a [u8]>>,
    rels: &'a HashMap<String, RelEntry>,
    styles: &'a HashMap<String, StyleInfo>,
    numbering: &'a NumberingMap,
    assets: Vec<MediaAsset>,
    asset_by_rel: HashMap<String, String>,
    next_id: usize,
    saw_tracked_changes: bool,
}

impl<'a> ParseCtx<'a> {
    fn alloc_id(&mut self, prefix: &str) -> String {
        let id = format!("{prefix}-{}", self.next_id);
        self.next_id += 1;
        id
    }

    fn resolve_image_asset(&mut self, rel_id: &str) -> Option<String> {
        if let Some(existing) = self.asset_by_rel.get(rel_id) {
            return Some(existing.clone());
        }
        let target = &self.rels.get(rel_id)?.target;
        let normalized = if let Some(stripped) = target.strip_prefix('/') {
            stripped.to_string()
        } else if target.starts_with("word/") {
            target.clone()
        } else {
            format!("word/{target}")
        };

        let bytes = read_zip_bytes(self.archive, &normalized).ok()??;
        let mime_type = mime_from_path(&normalized);
        let asset_id = self.alloc_id("asset");
        let filename = normalized.rsplit('/').next().map(|s| s.to_string());
        self.assets.push(MediaAsset {
            id: asset_id.clone(),
            mime_type: mime_type.to_string(),
            data_base64: BASE64.encode(&bytes),
            filename,
        });
        self.asset_by_rel
            .insert(rel_id.to_string(), asset_id.clone());
        Some(asset_id)
    }
}

fn mime_from_path(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

#[derive(Default)]
struct ParagraphBuilder {
    style_id: Option<String>,
    align: TextAlign,
    num_id: Option<String>,
    ilvl: u8,
    indent_level: u8,
    page_break_before: bool,
    has_bottom_border: bool,
    runs: Vec<InlineRun>,
    images: Vec<(String, String, Option<u32>, Option<u32>)>,
    trailing_page_break: bool,
}

enum RawBlock {
    Paragraph(ParagraphBuilder),
    Table(TableRowList),
}

struct TableRowList {
    rows: Vec<TableRow>,
}

fn parse_body_xml(xml: &str, ctx: &mut ParseCtx<'_>) -> Result<Vec<Block>, DocxError> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut in_body = false;
    let mut raw_blocks: Vec<RawBlock> = Vec::new();

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => match local_name(e.name().as_ref()) {
                "body" => in_body = true,
                "p" if in_body => {
                    let para = parse_paragraph(&mut reader, ctx)?;
                    raw_blocks.push(RawBlock::Paragraph(para));
                }
                "tbl" if in_body => {
                    let rows = parse_table(&mut reader, ctx)?;
                    raw_blocks.push(RawBlock::Table(TableRowList { rows }));
                }
                _ => {}
            },
            Event::End(e) if local_name(e.name().as_ref()) == "body" => break,
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(materialize_raw_blocks(raw_blocks, ctx))
}

fn parse_footnotes(xml: &str, ctx: &mut ParseCtx<'_>) -> Result<Vec<Block>, DocxError> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut result = Vec::new();

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) if local_name(e.name().as_ref()) == "footnote" => {
                let id_attr = attr_value(&e, "id").unwrap_or_default();
                let fn_type = attr_value(&e, "type");
                let skip = matches!(
                    fn_type.as_deref(),
                    Some("separator") | Some("continuationSeparator")
                ) || id_attr == "-1"
                    || id_attr == "0";

                let mut inner_raw = Vec::new();
                let mut inner_buf = Vec::new();
                loop {
                    match reader.read_event_into(&mut inner_buf)? {
                        Event::Start(se) if local_name(se.name().as_ref()) == "p" => {
                            let para = parse_paragraph(&mut reader, ctx)?;
                            inner_raw.push(RawBlock::Paragraph(para));
                        }
                        Event::End(ee) if local_name(ee.name().as_ref()) == "footnote" => break,
                        Event::Eof => break,
                        _ => {}
                    }
                    inner_buf.clear();
                }

                if !skip {
                    let blocks = materialize_raw_blocks(inner_raw, ctx);
                    if !blocks.is_empty() {
                        let block_id = ctx.alloc_id("fn");
                        result.push(Block {
                            id: block_id,
                            kind: BlockKind::Footnote {
                                label: id_attr,
                                blocks,
                            },
                        });
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(result)
}

fn parse_table(
    reader: &mut Reader<&[u8]>,
    ctx: &mut ParseCtx<'_>,
) -> Result<Vec<TableRow>, DocxError> {
    let mut rows = Vec::new();
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => match local_name(e.name().as_ref()) {
                "tr" => {
                    rows.push(parse_table_row(reader, ctx)?);
                }
                _ => {}
            },
            Event::End(e) if local_name(e.name().as_ref()) == "tbl" => break,
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    // Mark first row as header if none explicitly flagged
    if !rows.is_empty() && !rows.iter().any(|r| r.header) && rows.len() > 1 {
        rows[0].header = true;
    }

    Ok(rows)
}

fn parse_table_row(
    reader: &mut Reader<&[u8]>,
    ctx: &mut ParseCtx<'_>,
) -> Result<TableRow, DocxError> {
    let mut header = false;
    let mut cells = Vec::new();
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => match local_name(e.name().as_ref()) {
                "tblHeader" => header = true,
                "tc" => cells.push(parse_table_cell(reader, ctx)?),
                _ => {}
            },
            Event::Empty(e) if local_name(e.name().as_ref()) == "tblHeader" => {
                header = true;
            }
            Event::End(e) if local_name(e.name().as_ref()) == "tr" => break,
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(TableRow { header, cells })
}

fn parse_table_cell(
    reader: &mut Reader<&[u8]>,
    ctx: &mut ParseCtx<'_>,
) -> Result<TableCell, DocxError> {
    let mut col_span: u16 = 1;
    let mut raw_blocks = Vec::new();
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => match local_name(e.name().as_ref()) {
                "gridSpan" => {
                    if let Some(v) = attr_value(&e, "val").and_then(|s| s.parse::<u16>().ok()) {
                        col_span = v.max(1);
                    }
                }
                "p" => {
                    let para = parse_paragraph(reader, ctx)?;
                    raw_blocks.push(RawBlock::Paragraph(para));
                }
                "tbl" => {
                    let nested = parse_table(reader, ctx)?;
                    raw_blocks.push(RawBlock::Table(TableRowList { rows: nested }));
                }
                _ => {}
            },
            Event::Empty(e) if local_name(e.name().as_ref()) == "gridSpan" => {
                if let Some(v) = attr_value(&e, "val").and_then(|s| s.parse::<u16>().ok()) {
                    col_span = v.max(1);
                }
            }
            Event::End(e) if local_name(e.name().as_ref()) == "tc" => break,
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    let blocks = materialize_raw_blocks(raw_blocks, ctx);
    let align = blocks
        .first()
        .map(|b| match &b.kind {
            BlockKind::Paragraph { align, .. } | BlockKind::Heading { align, .. } => *align,
            _ => TextAlign::Left,
        })
        .unwrap_or(TextAlign::Left);
    let id = ctx.alloc_id("cell");

    Ok(TableCell {
        id,
        col_span,
        row_span: 1,
        align,
        blocks,
    })
}

fn parse_paragraph(
    reader: &mut Reader<&[u8]>,
    ctx: &mut ParseCtx<'_>,
) -> Result<ParagraphBuilder, DocxError> {
    let mut para = ParagraphBuilder::default();
    let mut buf = Vec::new();

    let mut in_ppr = false;
    let mut in_numpr = false;
    let mut in_pbdr = false;
    let mut in_r = false;
    let mut in_rpr = false;
    let mut in_t = false;
    let mut skip_del_depth: usize = 0;

    let mut active_href: Option<String> = None;
    let mut cur_run_style = TextStyle::default();
    let mut cur_drawing_dims: (Option<u32>, Option<u32>) = (None, None);
    let mut cur_drawing_alt = String::new();

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => {
                let qname = e.name();
                let name = local_name(qname.as_ref());
                if name == "del" {
                    ctx.saw_tracked_changes = true;
                    skip_del_depth += 1;
                    buf.clear();
                    continue;
                }
                if skip_del_depth > 0 {
                    buf.clear();
                    continue;
                }
                match name {
                    "ins" => ctx.saw_tracked_changes = true,
                    "pPr" => in_ppr = true,
                    "numPr" if in_ppr => in_numpr = true,
                    "pBdr" if in_ppr => in_pbdr = true,
                    "bottom" if in_pbdr => {
                        let val = attr_value(&e, "val").unwrap_or_default();
                        if !matches!(val.as_str(), "none" | "nil") {
                            para.has_bottom_border = true;
                        }
                    }
                    "pStyle" if in_ppr => {
                        para.style_id = attr_value(&e, "val");
                    }
                    "jc" if in_ppr => {
                        if let Some(v) = attr_value(&e, "val") {
                            para.align = parse_align(&v);
                        }
                    }
                    "numId" if in_numpr => {
                        para.num_id = attr_value(&e, "val");
                    }
                    "ilvl" if in_numpr => {
                        if let Some(v) = attr_value(&e, "val").and_then(|s| s.parse::<u8>().ok()) {
                            para.ilvl = v;
                        }
                    }
                    "ind" if in_ppr => {
                        if let Some(left) =
                            attr_value(&e, "left").and_then(|s| s.parse::<u32>().ok())
                        {
                            para.indent_level = ((left / 720).min(6)) as u8;
                        }
                    }
                    "pageBreakBefore" if in_ppr => para.page_break_before = true,
                    "hyperlink" => {
                        if let Some(rid) = attr_value(&e, "id") {
                            active_href = ctx.rels.get(&rid).map(|r| r.target.clone());
                        } else if let Some(anchor) = attr_value(&e, "anchor") {
                            if !anchor.is_empty() {
                                active_href = Some(format!("#{anchor}"));
                            }
                        }
                    }
                    "r" => {
                        in_r = true;
                        cur_run_style = TextStyle {
                            href: active_href.clone(),
                            ..Default::default()
                        };
                    }
                    "rPr" if in_r => in_rpr = true,
                    "t" | "instrText" if in_r => in_t = name == "t",
                    "drawing" => {
                        cur_drawing_dims = (None, None);
                        cur_drawing_alt.clear();
                    }
                    "extent" => {
                        let w = attr_value(&e, "cx")
                            .and_then(|v| v.parse::<u64>().ok())
                            .map(|emu| (emu / 9525) as u32);
                        let h = attr_value(&e, "cy")
                            .and_then(|v| v.parse::<u64>().ok())
                            .map(|emu| (emu / 9525) as u32);
                        if w.is_some() {
                            cur_drawing_dims = (w, h);
                        }
                    }
                    "docPr" => {
                        if let Some(descr) =
                            attr_value(&e, "descr").or_else(|| attr_value(&e, "name"))
                        {
                            if !descr.is_empty() {
                                cur_drawing_alt = descr;
                            }
                        }
                    }
                    "blip" => {
                        if let Some(rel_id) = attr_value(&e, "embed") {
                            if let Some(asset_id) = ctx.resolve_image_asset(&rel_id) {
                                para.images.push((
                                    asset_id,
                                    cur_drawing_alt.clone(),
                                    cur_drawing_dims.0,
                                    cur_drawing_dims.1,
                                ));
                            }
                        }
                    }
                    _ if in_rpr => apply_rpr_tag(name, &e, &mut cur_run_style),
                    _ => {}
                }
            }
            Event::Empty(e) => {
                if skip_del_depth > 0 {
                    buf.clear();
                    continue;
                }
                let qname = e.name();
                let name = local_name(qname.as_ref());
                match name {
                    "bottom" if in_pbdr => {
                        let val = attr_value(&e, "val").unwrap_or_default();
                        if !matches!(val.as_str(), "none" | "nil") {
                            para.has_bottom_border = true;
                        }
                    }
                    "pStyle" if in_ppr => para.style_id = attr_value(&e, "val"),
                    "jc" if in_ppr => {
                        if let Some(v) = attr_value(&e, "val") {
                            para.align = parse_align(&v);
                        }
                    }
                    "numId" if in_numpr => para.num_id = attr_value(&e, "val"),
                    "ilvl" if in_numpr => {
                        if let Some(v) = attr_value(&e, "val").and_then(|s| s.parse::<u8>().ok()) {
                            para.ilvl = v;
                        }
                    }
                    "ind" if in_ppr => {
                        if let Some(left) =
                            attr_value(&e, "left").and_then(|s| s.parse::<u32>().ok())
                        {
                            para.indent_level = ((left / 720).min(6)) as u8;
                        }
                    }
                    "pageBreakBefore" if in_ppr => para.page_break_before = true,
                    "br" if in_r => {
                        if attr_value(&e, "type").as_deref() == Some("page") {
                            para.trailing_page_break = true;
                        } else {
                            para.runs
                                .push(InlineRun::styled("\n", cur_run_style.clone()));
                        }
                    }
                    "tab" if in_r => {
                        para.runs
                            .push(InlineRun::styled("\t", cur_run_style.clone()));
                    }
                    "footnoteReference" if in_r => {
                        if let Some(id) = attr_value(&e, "id") {
                            let mut style = cur_run_style.clone();
                            style.superscript = true;
                            para.runs.push(InlineRun::styled(format!("[{id}]"), style));
                        }
                    }
                    "extent" => {
                        let w = attr_value(&e, "cx")
                            .and_then(|v| v.parse::<u64>().ok())
                            .map(|emu| (emu / 9525) as u32);
                        let h = attr_value(&e, "cy")
                            .and_then(|v| v.parse::<u64>().ok())
                            .map(|emu| (emu / 9525) as u32);
                        if w.is_some() {
                            cur_drawing_dims = (w, h);
                        }
                    }
                    "docPr" => {
                        if let Some(descr) =
                            attr_value(&e, "descr").or_else(|| attr_value(&e, "name"))
                        {
                            if !descr.is_empty() {
                                cur_drawing_alt = descr;
                            }
                        }
                    }
                    "blip" => {
                        if let Some(rel_id) = attr_value(&e, "embed") {
                            if let Some(asset_id) = ctx.resolve_image_asset(&rel_id) {
                                para.images.push((
                                    asset_id,
                                    cur_drawing_alt.clone(),
                                    cur_drawing_dims.0,
                                    cur_drawing_dims.1,
                                ));
                            }
                        }
                    }
                    _ if in_rpr => apply_rpr_tag(name, &e, &mut cur_run_style),
                    _ => {}
                }
            }
            Event::Text(t) => {
                if skip_del_depth == 0 && in_t {
                    let text = t.xml10_content();
                    if !text.is_empty() {
                        para.runs
                            .push(InlineRun::styled(text.into_owned(), cur_run_style.clone()));
                    }
                }
            }
            Event::CData(c) => {
                if skip_del_depth == 0 && in_t {
                    let text = c.xml10_content();
                    if !text.is_empty() {
                        para.runs
                            .push(InlineRun::styled(text.into_owned(), cur_run_style.clone()));
                    }
                }
            }
            Event::GeneralRef(r) => {
                if skip_del_depth == 0 && in_t {
                    para.runs.push(InlineRun::styled(
                        resolve_general_ref(&r),
                        cur_run_style.clone(),
                    ));
                }
            }
            Event::End(e) => {
                let qname = e.name();
                let name = local_name(qname.as_ref());
                if name == "del" {
                    skip_del_depth = skip_del_depth.saturating_sub(1);
                    buf.clear();
                    continue;
                }
                if skip_del_depth > 0 {
                    buf.clear();
                    continue;
                }
                match name {
                    "pPr" => {
                        in_ppr = false;
                        in_pbdr = false;
                        in_numpr = false;
                    }
                    "pBdr" => in_pbdr = false,
                    "numPr" => in_numpr = false,
                    "rPr" => in_rpr = false,
                    "t" => in_t = false,
                    "r" => in_r = false,
                    "hyperlink" => active_href = None,
                    "p" => break,
                    _ => {}
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(para)
}

fn apply_rpr_tag(name: &str, e: &BytesStart<'_>, style: &mut TextStyle) {
    let val_is_off = || {
        matches!(
            attr_value(e, "val").as_deref(),
            Some("0") | Some("false") | Some("none")
        )
    };
    match name {
        "b" => style.bold = !val_is_off(),
        "i" => style.italic = !val_is_off(),
        "u" => style.underline = !val_is_off(),
        "strike" | "dstrike" => style.strikethrough = !val_is_off(),
        "vertAlign" => match attr_value(e, "val").as_deref() {
            Some("superscript") => style.superscript = true,
            Some("subscript") => style.subscript = true,
            _ => {}
        },
        "sz" => {
            if let Some(half_pts) = attr_value(e, "val").and_then(|v| v.parse::<f32>().ok()) {
                style.font_size_pt = Some(half_pts / 2.0);
            }
        }
        "rFonts" => {
            if let Some(ascii) = attr_value(e, "ascii") {
                let lower = ascii.to_ascii_lowercase();
                if lower.contains("mono") || lower.contains("courier") || lower.contains("consolas")
                {
                    style.code = true;
                }
            }
        }
        _ => {}
    }
}

fn parse_align(val: &str) -> TextAlign {
    match val {
        "center" => TextAlign::Center,
        "right" | "end" => TextAlign::Right,
        "both" | "distribute" => TextAlign::Justify,
        _ => TextAlign::Left,
    }
}

fn materialize_raw_blocks(raw_blocks: Vec<RawBlock>, ctx: &mut ParseCtx<'_>) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    let mut pending_list: Option<(String, bool, Vec<ListItem>)> = None;
    let mut pending_code: Option<Vec<String>> = None;

    let flush_list = |pending: &mut Option<(String, bool, Vec<ListItem>)>,
                      out: &mut Vec<Block>,
                      ctx: &mut ParseCtx<'_>| {
        if let Some((_, ordered, items)) = pending.take() {
            if !items.is_empty() {
                let id = ctx.alloc_id("list");
                out.push(Block {
                    id,
                    kind: BlockKind::List {
                        ordered,
                        start: 1,
                        items,
                    },
                });
            }
        }
    };

    let flush_code =
        |pending: &mut Option<Vec<String>>, out: &mut Vec<Block>, ctx: &mut ParseCtx<'_>| {
            if let Some(lines) = pending.take() {
                let id = ctx.alloc_id("code");
                out.push(Block {
                    id,
                    kind: BlockKind::CodeBlock {
                        language: None,
                        code: lines.join("\n"),
                    },
                });
            }
        };

    for raw in raw_blocks {
        match raw {
            RawBlock::Table(tbl) => {
                flush_list(&mut pending_list, &mut blocks, ctx);
                flush_code(&mut pending_code, &mut blocks, ctx);
                let id = ctx.alloc_id("tbl");
                blocks.push(Block {
                    id,
                    kind: BlockKind::Table { rows: tbl.rows },
                });
            }
            RawBlock::Paragraph(para) => {
                if para.page_break_before {
                    flush_list(&mut pending_list, &mut blocks, ctx);
                    flush_code(&mut pending_code, &mut blocks, ctx);
                    let id = ctx.alloc_id("pb");
                    blocks.push(Block {
                        id,
                        kind: BlockKind::PageBreak,
                    });
                }

                let runs = merge_adjacent_runs(para.runs);

                // Check list membership
                if let Some(num_id) = &para.num_id {
                    if num_id != "0" && !runs.is_empty() {
                        flush_code(&mut pending_code, &mut blocks, ctx);
                        let ordered = ctx.numbering.is_ordered(num_id, para.ilvl);
                        let item = ListItem {
                            id: ctx.alloc_id("li"),
                            checked: None,
                            runs,
                            children: Vec::new(),
                        };
                        match &mut pending_list {
                            Some((cur_num_id, cur_ordered, items))
                                if cur_num_id == num_id && *cur_ordered == ordered =>
                            {
                                items.push(item);
                            }
                            _ => {
                                flush_list(&mut pending_list, &mut blocks, ctx);
                                pending_list = Some((num_id.clone(), ordered, vec![item]));
                            }
                        }
                        continue;
                    }
                }

                flush_list(&mut pending_list, &mut blocks, ctx);

                let style_info = para.style_id.as_deref().and_then(|id| ctx.styles.get(id));

                let is_code_para = style_info.map(|s| s.is_code).unwrap_or(false)
                    || para
                        .style_id
                        .as_deref()
                        .map(|id| id.eq_ignore_ascii_case("code"))
                        .unwrap_or(false);

                // Coalesce consecutive Code-styled paragraphs (including blank lines) into one CodeBlock
                if is_code_para && para.images.is_empty() && !para.trailing_page_break {
                    let line = orb_ir::runs_plain_text(&runs);
                    pending_code.get_or_insert_with(Vec::new).push(line);
                    continue;
                }

                flush_code(&mut pending_code, &mut blocks, ctx);

                if runs.is_empty() && para.images.is_empty() && para.has_bottom_border {
                    let id = ctx.alloc_id("hr");
                    blocks.push(Block {
                        id,
                        kind: BlockKind::HorizontalRule,
                    });
                } else if !runs.is_empty() {
                    let heading_level = style_info.and_then(|s| s.heading_level).or_else(|| {
                        para.style_id
                            .as_deref()
                            .and_then(|id| infer_heading_level(&id.to_ascii_lowercase()))
                    });

                    if let Some(level) = heading_level {
                        let id = ctx.alloc_id("h");
                        blocks.push(Block {
                            id,
                            kind: BlockKind::Heading {
                                level,
                                runs,
                                align: para.align,
                            },
                        });
                    } else if style_info.map(|s| s.is_quote).unwrap_or(false) {
                        let p_id = ctx.alloc_id("p");
                        let bq_id = ctx.alloc_id("bq");
                        blocks.push(Block {
                            id: bq_id,
                            kind: BlockKind::BlockQuote {
                                blocks: vec![Block {
                                    id: p_id,
                                    kind: BlockKind::Paragraph {
                                        runs,
                                        align: para.align,
                                        indent_level: para.indent_level,
                                    },
                                }],
                            },
                        });
                    } else {
                        let id = ctx.alloc_id("p");
                        blocks.push(Block {
                            id,
                            kind: BlockKind::Paragraph {
                                runs,
                                align: para.align,
                                indent_level: para.indent_level,
                            },
                        });
                    }
                }

                for (asset_id, alt, width_px, height_px) in para.images {
                    let id = ctx.alloc_id("img");
                    blocks.push(Block {
                        id,
                        kind: BlockKind::Image {
                            asset_id,
                            alt,
                            width_px,
                            height_px,
                            caption: None,
                        },
                    });
                }

                if para.trailing_page_break {
                    let id = ctx.alloc_id("pb");
                    blocks.push(Block {
                        id,
                        kind: BlockKind::PageBreak,
                    });
                }
            }
        }
    }

    flush_list(&mut pending_list, &mut blocks, ctx);
    flush_code(&mut pending_code, &mut blocks, ctx);
    blocks
}
