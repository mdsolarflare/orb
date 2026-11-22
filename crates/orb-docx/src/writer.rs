use std::io::{Cursor, Write};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use orb_ir::{Block, BlockKind, DocumentIr, InlineRun, TextAlign};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::DocxError;

struct PendingRel {
    id: String,
    rel_type: &'static str,
    target: String,
    external: bool,
}

struct PendingMedia {
    path: String,
    bytes: Vec<u8>,
}

pub fn write_docx(doc: &DocumentIr) -> Result<Vec<u8>, DocxError> {
    let mut rels: Vec<PendingRel> = vec![
        PendingRel {
            id: "rId1".into(),
            rel_type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
            target: "styles.xml".into(),
            external: false,
        },
        PendingRel {
            id: "rId2".into(),
            rel_type:
                "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering",
            target: "numbering.xml".into(),
            external: false,
        },
    ];
    let mut media_files: Vec<PendingMedia> = Vec::new();
    let mut next_rid: usize = 3;
    let mut next_docpr: usize = 1;

    let mut body_xml = String::new();
    for block in &doc.blocks {
        write_block_xml(
            block,
            doc,
            &mut body_xml,
            &mut rels,
            &mut media_files,
            &mut next_rid,
            &mut next_docpr,
            None,
        );
    }

    let document_xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    {body_xml}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>"#
    );

    let mut rels_xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    );
    for rel in &rels {
        let mode = if rel.external {
            r#" TargetMode="External""#
        } else {
            ""
        };
        rels_xml.push_str(&format!(
            r#"<Relationship Id="{}" Type="{}" Target="{}"{}/>"#,
            escape_xml(&rel.id),
            rel.rel_type,
            escape_xml(&rel.target),
            mode
        ));
    }
    rels_xml.push_str("</Relationships>");

    let core_xml = build_core_xml(doc);
    let content_types_xml = build_content_types_xml(&media_files);

    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut buf);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        write_zip_entry(&mut zip, "[Content_Types].xml", content_types_xml.as_bytes(), opts)?;
        write_zip_entry(&mut zip, "_rels/.rels", ROOT_RELS_XML.as_bytes(), opts)?;
        write_zip_entry(&mut zip, "docProps/core.xml", core_xml.as_bytes(), opts)?;
        write_zip_entry(
            &mut zip,
            "word/_rels/document.xml.rels",
            rels_xml.as_bytes(),
            opts,
        )?;
        write_zip_entry(&mut zip, "word/styles.xml", STYLES_XML.as_bytes(), opts)?;
        write_zip_entry(&mut zip, "word/numbering.xml", NUMBERING_XML.as_bytes(), opts)?;
        write_zip_entry(&mut zip, "word/document.xml", document_xml.as_bytes(), opts)?;

        for media in &media_files {
            write_zip_entry(&mut zip, &media.path, &media.bytes, opts)?;
        }

        zip.finish()?;
    }

    Ok(buf.into_inner())
}

fn write_zip_entry(
    zip: &mut ZipWriter<&mut Cursor<Vec<u8>>>,
    name: &str,
    data: &[u8],
    opts: SimpleFileOptions,
) -> Result<(), DocxError> {
    zip.start_file(name, opts)?;
    zip.write_all(data)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn write_block_xml(
    block: &Block,
    doc: &DocumentIr,
    out: &mut String,
    rels: &mut Vec<PendingRel>,
    media_files: &mut Vec<PendingMedia>,
    next_rid: &mut usize,
    next_docpr: &mut usize,
    style_override: Option<&str>,
) {
    match &block.kind {
        BlockKind::Heading { level, runs, align } => {
            let style = format!("Heading{}", (*level).clamp(1, 6));
            write_paragraph_xml(
                runs,
                Some(&style),
                *align,
                None,
                0,
                out,
                rels,
                next_rid,
            );
        }
        BlockKind::Paragraph {
            runs,
            align,
            indent_level,
        } => {
            write_paragraph_xml(
                runs,
                style_override,
                *align,
                None,
                *indent_level,
                out,
                rels,
                next_rid,
            );
        }
        BlockKind::List { ordered, items, .. } => {
            let num_id = if *ordered { "2" } else { "1" };
            for item in items {
                let mut runs = item.runs.clone();
                if let Some(checked) = item.checked {
                    runs.insert(
                        0,
                        InlineRun::plain(if checked { "[x] " } else { "[ ] " }),
                    );
                }
                write_paragraph_xml(
                    &runs,
                    None,
                    TextAlign::Left,
                    Some((num_id, 0)),
                    0,
                    out,
                    rels,
                    next_rid,
                );
                for child in &item.children {
                    write_block_xml(
                        child,
                        doc,
                        out,
                        rels,
                        media_files,
                        next_rid,
                        next_docpr,
                        None,
                    );
                }
            }
        }
        BlockKind::Table { rows } => {
            out.push_str(
                "<w:tbl><w:tblPr><w:tblBorders>\
                 <w:top w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>\
                 <w:left w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>\
                 <w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>\
                 <w:right w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>\
                 <w:insideH w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>\
                 <w:insideV w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>\
                 </w:tblBorders></w:tblPr>",
            );
            for row in rows {
                out.push_str("<w:tr>");
                if row.header {
                    out.push_str("<w:trPr><w:tblHeader/></w:trPr>");
                }
                for cell in &row.cells {
                    out.push_str("<w:tc><w:tcPr>");
                    if cell.col_span > 1 {
                        out.push_str(&format!(r#"<w:gridSpan w:val="{}"/>"#, cell.col_span));
                    }
                    out.push_str("</w:tcPr>");
                    if cell.blocks.is_empty() {
                        out.push_str("<w:p/>");
                    } else {
                        for cb in &cell.blocks {
                            write_block_xml(
                                cb,
                                doc,
                                out,
                                rels,
                                media_files,
                                next_rid,
                                next_docpr,
                                None,
                            );
                        }
                    }
                    out.push_str("</w:tc>");
                }
                out.push_str("</w:tr>");
            }
            out.push_str("</w:tbl>");
        }
        BlockKind::BlockQuote { blocks } => {
            for b in blocks {
                write_block_xml(
                    b,
                    doc,
                    out,
                    rels,
                    media_files,
                    next_rid,
                    next_docpr,
                    Some("Quote"),
                );
            }
        }
        BlockKind::CodeBlock { code, .. } => {
            for line in code.lines() {
                write_paragraph_xml(
                    &[InlineRun::plain(line)],
                    Some("Code"),
                    TextAlign::Left,
                    None,
                    0,
                    out,
                    rels,
                    next_rid,
                );
            }
        }
        BlockKind::Image {
            asset_id,
            alt,
            width_px,
            height_px,
            ..
        } => {
            if let Some(asset) = doc.assets.iter().find(|a| a.id == *asset_id) {
                if let Ok(bytes) = BASE64.decode(&asset.data_base64) {
                    let ext = ext_from_mime(&asset.mime_type);
                    let rid = format!("rId{}", *next_rid);
                    *next_rid += 1;
                    let media_name = format!("image{}.{ext}", *next_docpr);
                    let docpr_id = *next_docpr;
                    *next_docpr += 1;

                    rels.push(PendingRel {
                        id: rid.clone(),
                        rel_type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
                        target: format!("media/{media_name}"),
                        external: false,
                    });
                    media_files.push(PendingMedia {
                        path: format!("word/media/{media_name}"),
                        bytes,
                    });

                    let cx = u64::from(width_px.unwrap_or(320)) * 9525;
                    let cy = u64::from(height_px.unwrap_or(200)) * 9525;
                    let escaped_alt = escape_xml(alt);

                    out.push_str(&format!(
                        r#"<w:p><w:r><w:drawing><wp:inline>
<wp:extent cx="{cx}" cy="{cy}"/>
<wp:docPr id="{docpr_id}" name="Image {docpr_id}" descr="{escaped_alt}"/>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic>
<pic:nvPicPr><pic:cNvPr id="{docpr_id}" name="{media_name}" descr="{escaped_alt}"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
</pic:pic>
</a:graphicData></a:graphic>
</wp:inline></w:drawing></w:r></w:p>"#
                    ));
                }
            }
        }
        BlockKind::HorizontalRule => {
            out.push_str(
                r#"<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>"#,
            );
        }
        BlockKind::PageBreak => {
            out.push_str(r#"<w:p><w:r><w:br w:type="page"/></w:r></w:p>"#);
        }
        BlockKind::Footnote { label, blocks } => {
            let mut text = format!("[{label}] ");
            for b in blocks {
                if let BlockKind::Paragraph { runs, .. } = &b.kind {
                    text.push_str(&orb_ir::runs_plain_text(runs));
                }
            }
            write_paragraph_xml(
                &[InlineRun::plain(text)],
                None,
                TextAlign::Left,
                None,
                0,
                out,
                rels,
                next_rid,
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn write_paragraph_xml(
    runs: &[InlineRun],
    style_id: Option<&str>,
    align: TextAlign,
    num: Option<(&str, u8)>,
    indent_level: u8,
    out: &mut String,
    rels: &mut Vec<PendingRel>,
    next_rid: &mut usize,
) {
    out.push_str("<w:p>");
    let has_ppr = style_id.is_some() || align != TextAlign::Left || num.is_some() || indent_level > 0;
    if has_ppr {
        out.push_str("<w:pPr>");
        if let Some(style) = style_id {
            out.push_str(&format!(r#"<w:pStyle w:val="{}"/>"#, escape_xml(style)));
        }
        if let Some((num_id, ilvl)) = num {
            out.push_str(&format!(
                r#"<w:numPr><w:ilvl w:val="{ilvl}"/><w:numId w:val="{num_id}"/></w:numPr>"#
            ));
        }
        if indent_level > 0 {
            let twips = u32::from(indent_level) * 720;
            out.push_str(&format!(r#"<w:ind w:left="{twips}"/>"#));
        }
        match align {
            TextAlign::Center => out.push_str(r#"<w:jc w:val="center"/>"#),
            TextAlign::Right => out.push_str(r#"<w:jc w:val="right"/>"#),
            TextAlign::Justify => out.push_str(r#"<w:jc w:val="both"/>"#),
            TextAlign::Left => {}
        }
        out.push_str("</w:pPr>");
    }

    for run in runs {
        if let Some(href) = &run.style.href {
            let rid = format!("rId{}", *next_rid);
            *next_rid += 1;
            rels.push(PendingRel {
                id: rid.clone(),
                rel_type:
                    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
                target: href.clone(),
                external: true,
            });
            out.push_str(&format!(r#"<w:hyperlink r:id="{rid}">"#));
            write_run_xml(run, out);
            out.push_str("</w:hyperlink>");
        } else {
            write_run_xml(run, out);
        }
    }

    out.push_str("</w:p>");
}

fn write_run_xml(run: &InlineRun, out: &mut String) {
    let s = &run.style;
    out.push_str("<w:r>");
    if s.bold
        || s.italic
        || s.underline
        || s.strikethrough
        || s.superscript
        || s.subscript
        || s.code
        || s.font_size_pt.is_some()
    {
        out.push_str("<w:rPr>");
        if s.bold {
            out.push_str("<w:b/>");
        }
        if s.italic {
            out.push_str("<w:i/>");
        }
        if s.underline {
            out.push_str(r#"<w:u w:val="single"/>"#);
        }
        if s.strikethrough {
            out.push_str("<w:strike/>");
        }
        if s.superscript {
            out.push_str(r#"<w:vertAlign w:val="superscript"/>"#);
        } else if s.subscript {
            out.push_str(r#"<w:vertAlign w:val="subscript"/>"#);
        }
        if s.code {
            out.push_str(r#"<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>"#);
        }
        if let Some(pt) = s.font_size_pt {
            let half_pts = (pt * 2.0).round() as u32;
            out.push_str(&format!(r#"<w:sz w:val="{half_pts}"/>"#));
        }
        out.push_str("</w:rPr>");
    }

    for (idx, line) in run.text.split('\n').enumerate() {
        if idx > 0 {
            out.push_str("<w:br/>");
        }
        out.push_str(r#"<w:t xml:space="preserve">"#);
        out.push_str(&escape_xml(line));
        out.push_str("</w:t>");
    }

    out.push_str("</w:r>");
}

fn build_core_xml(doc: &DocumentIr) -> String {
    let title = doc
        .title
        .as_deref()
        .map(escape_xml)
        .unwrap_or_else(|| "Untitled Document".into());
    let creator = doc
        .metadata
        .author
        .as_deref()
        .map(escape_xml)
        .unwrap_or_else(|| "Orb".into());
    let subject = doc
        .metadata
        .subject
        .as_deref()
        .map(escape_xml)
        .unwrap_or_default();

    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>{title}</dc:title>
  <dc:creator>{creator}</dc:creator>
  <dc:subject>{subject}</dc:subject>
</cp:coreProperties>"#
    )
}

fn build_content_types_xml(media: &[PendingMedia]) -> String {
    let mut extras = String::new();
    let has_ext = |ext: &str| media.iter().any(|m| m.path.ends_with(ext));
    if has_ext(".png") {
        extras.push_str(r#"<Default Extension="png" ContentType="image/png"/>"#);
    }
    if has_ext(".jpg") || has_ext(".jpeg") {
        extras.push_str(r#"<Default Extension="jpg" ContentType="image/jpeg"/>"#);
    }
    if has_ext(".gif") {
        extras.push_str(r#"<Default Extension="gif" ContentType="image/gif"/>"#);
    }
    if has_ext(".svg") {
        extras.push_str(r#"<Default Extension="svg" ContentType="image/svg+xml"/>"#);
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  {extras}
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>"#
    )
}

fn ext_from_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/svg+xml" => "svg",
        _ => "png",
    }
}

fn escape_xml(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

const ROOT_RELS_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>"#;

const STYLES_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:pPr><w:outlineLvl w:val="4"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:pPr><w:outlineLvl w:val="5"/></w:pPr><w:rPr><w:b/><w:sz w:val="20"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:rPr><w:i/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr></w:style>
</w:styles>"#;

const NUMBERING_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>"#;
