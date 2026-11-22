use std::io::Cursor;

use orb_doc::DocError;
use orb_docx::DocxError;
use orb_ir::{
    Block, BlockKind, DocumentFormat, DocumentIr, EditOperation, InlineRun, IrError, ListItem,
    TableCell, TableRow, TextAlign, TextStyle,
};
use orb_pdf::{
    CertificateTrustProvider, FormFieldUpdate, PdfError, PdfInspection, WebTrustProvider,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zip::ZipArchive;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("unsupported or unrecognized document format: {0}")]
    UnsupportedFormat(String),
    #[error("invalid UTF-8 text in Markdown document")]
    InvalidUtf8,
    #[error("DOCX error: {0}")]
    Docx(#[from] DocxError),
    #[error("legacy DOC error: {0}")]
    Doc(#[from] DocError),
    #[error("PDF error: {0}")]
    Pdf(#[from] PdfError),
    #[error("IR edit error: {0}")]
    Ir(#[from] IrError),
    #[error("unknown sample document id: {0}")]
    UnknownSample(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WordFormat {
    Docx,
    Doc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpenedDocument {
    #[serde(rename_all = "camelCase")]
    Markdown {
        ir: DocumentIr,
        raw_markdown: String,
    },
    #[serde(rename_all = "camelCase")]
    Word {
        ir: DocumentIr,
        word_format: WordFormat,
    },
    Pdf {
        inspection: PdfInspection,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleDescriptor {
    pub id: String,
    pub label: String,
    pub filename: String,
    pub format: DocumentFormat,
    pub description: String,
}

pub struct GeneratedSample {
    pub filename: String,
    pub bytes: Vec<u8>,
    pub hint_pem: Option<String>,
}

/// Detects format primarily via file magic bytes, falling back to extension for plain-text Markdown.
pub fn detect_format(bytes: &[u8], filename: Option<&str>) -> Result<DocumentFormat, EngineError> {
    if bytes.starts_with(b"%PDF-") || find_pdf_header(bytes) {
        return Ok(DocumentFormat::Pdf);
    }

    if bytes.starts_with(b"{\\rtf") {
        return Err(EngineError::UnsupportedFormat(
            "RTF document detected (often saved with a .doc extension). RTF is not yet supported."
                .into(),
        ));
    }

    // OLE2 Compound File Binary magic: D0 CF 11 E0 A1 B1 1A E1
    if bytes.len() >= 8 && bytes[..8] == [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] {
        return Ok(DocumentFormat::Doc);
    }

    // ZIP container: inspect for OOXML word/document.xml
    if bytes.len() >= 4 && &bytes[..4] == b"PK\x03\x04" {
        if let Ok(mut archive) = ZipArchive::new(Cursor::new(bytes)) {
            if archive.by_name("word/document.xml").is_ok() {
                return Ok(DocumentFormat::Docx);
            }
        }
        return Err(EngineError::UnsupportedFormat(
            "ZIP archive is not a Word (.docx) document (missing word/document.xml).".into(),
        ));
    }

    // Plain UTF-8 text / Markdown
    if std::str::from_utf8(bytes).is_ok() {
        let lower_ext = filename
            .and_then(|f| f.rsplit_once('.'))
            .map(|(_, ext)| ext.to_ascii_lowercase());
        if matches!(
            lower_ext.as_deref(),
            None | Some("md") | Some("markdown") | Some("mdown") | Some("txt")
        ) || bytes.iter().all(|&b| b == b'\n' || b == b'\r' || b == b'\t' || b >= 0x20)
        {
            return Ok(DocumentFormat::Markdown);
        }
    }

    Err(EngineError::UnsupportedFormat(
        "Unrecognized binary file. Supported formats: PDF, .docx, .doc, and Markdown.".into(),
    ))
}

fn find_pdf_header(bytes: &[u8]) -> bool {
    let prefix = &bytes[..bytes.len().min(1024)];
    prefix.windows(5).any(|w| w == b"%PDF-")
}

pub fn open_document(
    bytes: &[u8],
    filename: Option<&str>,
    trusted_roots_pem: &[String],
) -> Result<OpenedDocument, EngineError> {
    let trust = WebTrustProvider::from_pem_list(trusted_roots_pem);
    open_document_with_trust(bytes, filename, &trust)
}

pub fn open_document_with_trust(
    bytes: &[u8],
    filename: Option<&str>,
    trust_provider: &dyn CertificateTrustProvider,
) -> Result<OpenedDocument, EngineError> {
    match detect_format(bytes, filename)? {
        DocumentFormat::Markdown => {
            let text = std::str::from_utf8(bytes).map_err(|_| EngineError::InvalidUtf8)?;
            let ir = orb_md::parse_markdown(text, filename);
            Ok(OpenedDocument::Markdown {
                ir,
                raw_markdown: text.to_string(),
            })
        }
        DocumentFormat::Docx => {
            let ir = orb_docx::parse_docx(bytes, filename)?;
            Ok(OpenedDocument::Word {
                ir,
                word_format: WordFormat::Docx,
            })
        }
        DocumentFormat::Doc => {
            let ir = orb_doc::parse_doc(bytes, filename)?;
            Ok(OpenedDocument::Word {
                ir,
                word_format: WordFormat::Doc,
            })
        }
        DocumentFormat::Pdf => {
            let inspection = orb_pdf::inspect_pdf(bytes, filename, trust_provider)?;
            Ok(OpenedDocument::Pdf { inspection })
        }
    }
}

pub fn parse_markdown_live(markdown: &str, filename: Option<&str>) -> DocumentIr {
    orb_md::parse_markdown(markdown, filename)
}

pub fn apply_ir_edit(mut ir: DocumentIr, op: EditOperation) -> Result<DocumentIr, EngineError> {
    ir.apply_edit(op)?;
    Ok(ir)
}

pub fn export_ir_to_markdown(ir: &DocumentIr) -> String {
    orb_md::serialize_markdown(ir)
}

pub fn export_ir_to_docx(ir: &DocumentIr) -> Result<Vec<u8>, EngineError> {
    Ok(orb_docx::write_docx(ir)?)
}

pub fn export_pdf_forms(
    raw_pdf: &[u8],
    updates: &[FormFieldUpdate],
) -> Result<Vec<u8>, EngineError> {
    Ok(orb_pdf::apply_form_updates(raw_pdf, updates)?)
}

pub fn reverify_pdf(
    raw_pdf: &[u8],
    filename: Option<&str>,
    trusted_roots_pem: &[String],
) -> Result<PdfInspection, EngineError> {
    let trust = WebTrustProvider::from_pem_list(trusted_roots_pem);
    Ok(orb_pdf::inspect_pdf(raw_pdf, filename, &trust)?)
}

pub fn list_samples() -> Vec<SampleDescriptor> {
    vec![
        SampleDescriptor {
            id: "signed-form-pdf".into(),
            label: "Signed AcroForm PDF".into(),
            filename: "orb-archival-form-signed.pdf".into(),
            format: DocumentFormat::Pdf,
            description: "2-page interactive AcroForm PDF with valid ECDSA P-256 CMS digital signature and outline.".into(),
        },
        SampleDescriptor {
            id: "tampered-pdf".into(),
            label: "Tampered Signed PDF".into(),
            filename: "orb-archival-form-tampered.pdf".into(),
            format: DocumentFormat::Pdf,
            description: "Modified signed PDF demonstrating cryptographic byte-range tamper detection.".into(),
        },
        SampleDescriptor {
            id: "sample-docx".into(),
            label: "Word Document (.docx)".into(),
            filename: "orb-architecture-brief.docx".into(),
            format: DocumentFormat::Docx,
            description: "Rich OOXML document with headings, styled runs, hyperlinks, lists, and tables.".into(),
        },
        SampleDescriptor {
            id: "sample-doc".into(),
            label: "Legacy Word 97-2003 (.doc)".into(),
            filename: "legacy-archival-memo.doc".into(),
            format: DocumentFormat::Doc,
            description: "Binary OLE2/CFB MS-DOC file decoded in pure Rust without external converters.".into(),
        },
        SampleDescriptor {
            id: "sample-md".into(),
            label: "Markdown Guide (.md)".into(),
            filename: "orb-long-term-compatibility.md".into(),
            format: DocumentFormat::Markdown,
            description: "CommonMark + GFM reference document ready for live split-pane editing and .docx export.".into(),
        },
    ]
}

pub fn generate_sample(sample_id: &str) -> Result<GeneratedSample, EngineError> {
    match sample_id {
        "signed-form-pdf" => {
            let sample = orb_pdf::fixture::generate_signed_form_pdf();
            Ok(GeneratedSample {
                filename: "orb-archival-form-signed.pdf".into(),
                bytes: sample.pdf_bytes,
                hint_pem: Some(sample.signer_cert_pem),
            })
        }
        "tampered-pdf" => {
            let sample = orb_pdf::fixture::generate_signed_form_pdf();
            let tampered = orb_pdf::fixture::tamper_signed_pdf(&sample.pdf_bytes);
            Ok(GeneratedSample {
                filename: "orb-archival-form-tampered.pdf".into(),
                bytes: tampered,
                hint_pem: Some(sample.signer_cert_pem),
            })
        }
        "sample-docx" => {
            let bytes = build_sample_docx()?;
            Ok(GeneratedSample {
                filename: "orb-architecture-brief.docx".into(),
                bytes,
                hint_pem: None,
            })
        }
        "sample-doc" => {
            let bytes = orb_doc::fixture::generate_sample_doc().map_err(DocError::Io)?;
            Ok(GeneratedSample {
                filename: "legacy-archival-memo.doc".into(),
                bytes,
                hint_pem: None,
            })
        }
        "sample-md" => Ok(GeneratedSample {
            filename: "orb-long-term-compatibility.md".into(),
            bytes: SAMPLE_MARKDOWN.as_bytes().to_vec(),
            hint_pem: None,
        }),
        other => Err(EngineError::UnknownSample(other.to_string())),
    }
}

fn build_sample_docx() -> Result<Vec<u8>, DocxError> {
    let mut doc = DocumentIr::new(
        DocumentFormat::Docx,
        Some("Orb Archival Document Brief".into()),
    );
    doc.metadata.author = Some("Orb Engineering".into());
    doc.metadata.subject = Some("Long-Term Format Compatibility".into());

    doc.blocks = vec![
        Block {
            id: "h1".into(),
            kind: BlockKind::Heading {
                level: 1,
                runs: vec![InlineRun::plain("Orb Archival Document Brief")],
                align: TextAlign::Left,
            },
        },
        Block {
            id: "p1".into(),
            kind: BlockKind::Paragraph {
                runs: vec![
                    InlineRun::plain("This "),
                    InlineRun::styled(
                        ".docx (OOXML)",
                        TextStyle {
                            bold: true,
                            ..Default::default()
                        },
                    ),
                    InlineRun::plain(
                        " file is parsed directly in pure Rust inside a WebAssembly worker — no server upload, no cloud conversion, and zero external office dependencies.",
                    ),
                ],
                align: TextAlign::Left,
                indent_level: 0,
            },
        },
        Block {
            id: "h2-1".into(),
            kind: BlockKind::Heading {
                level: 2,
                runs: vec![InlineRun::plain("Core Design Guarantees")],
                align: TextAlign::Left,
            },
        },
        Block {
            id: "list1".into(),
            kind: BlockKind::List {
                ordered: false,
                start: 1,
                items: vec![
                    ListItem {
                        id: "li-1".into(),
                        checked: None,
                        runs: vec![
                            InlineRun::styled(
                                "Canonical IR: ",
                                TextStyle {
                                    bold: true,
                                    ..Default::default()
                                },
                            ),
                            InlineRun::plain("Markdown, .docx, and legacy .doc map into one versioned intermediate representation."),
                        ],
                        children: vec![],
                    },
                    ListItem {
                        id: "li-2".into(),
                        checked: None,
                        runs: vec![
                            InlineRun::styled(
                                "Non-Destructive Export: ",
                                TextStyle {
                                    bold: true,
                                    ..Default::default()
                                },
                            ),
                            InlineRun::plain("Edit blocks directly in Orb and export a clean copy as .docx or .md without mutating original archives."),
                        ],
                        children: vec![],
                    },
                    ListItem {
                        id: "li-3".into(),
                        checked: None,
                        runs: vec![
                            InlineRun::styled(
                                "Portable Rust Core: ",
                                TextStyle {
                                    bold: true,
                                    ..Default::default()
                                },
                            ),
                            InlineRun::plain("The same cargo workspace powers static web WASM today and native Windows/macOS clients tomorrow."),
                        ],
                        children: vec![],
                    },
                ],
            },
        },
        Block {
            id: "h2-2".into(),
            kind: BlockKind::Heading {
                level: 2,
                runs: vec![InlineRun::plain("Supported Format Matrix")],
                align: TextAlign::Left,
            },
        },
        Block {
            id: "tbl1".into(),
            kind: BlockKind::Table {
                rows: vec![
                    TableRow {
                        header: true,
                        cells: vec![
                            make_cell("c00", "Format", TextAlign::Left),
                            make_cell("c01", "Decoder", TextAlign::Left),
                            make_cell("c02", "Editing & Export", TextAlign::Left),
                        ],
                    },
                    TableRow {
                        header: false,
                        cells: vec![
                            make_cell("c10", "PDF (.pdf)", TextAlign::Left),
                            make_cell("c11", "Pluggable renderer + RustCrypto CMS", TextAlign::Left),
                            make_cell("c12", "AcroForm incremental update (.pdf)", TextAlign::Left),
                        ],
                    },
                    TableRow {
                        header: false,
                        cells: vec![
                            make_cell("c20", "Word (.docx)", TextAlign::Left),
                            make_cell("c21", "Pure-Rust zip + quick-xml", TextAlign::Left),
                            make_cell("c22", "Canonical IR editor -> .docx / .md", TextAlign::Left),
                        ],
                    },
                    TableRow {
                        header: false,
                        cells: vec![
                            make_cell("c30", "Legacy Word (.doc)", TextAlign::Left),
                            make_cell("c31", "Pure-Rust OLE2/CFB MS-DOC", TextAlign::Left),
                            make_cell("c32", "Canonical IR editor -> .docx / .md", TextAlign::Left),
                        ],
                    },
                ],
            },
        },
        Block {
            id: "bq1".into(),
            kind: BlockKind::BlockQuote {
                blocks: vec![Block {
                    id: "bq1-p".into(),
                    kind: BlockKind::Paragraph {
                        runs: vec![InlineRun::styled(
                            "Switch to Edit Mode in the toolbar above to modify any heading, paragraph, list item, or table cell, then export back to .docx or Markdown.",
                            TextStyle {
                                italic: true,
                                ..Default::default()
                            },
                        )],
                        align: TextAlign::Left,
                        indent_level: 0,
                    },
                }],
            },
        },
    ];
    doc.finalize();
    orb_docx::write_docx(&doc)
}

fn make_cell(id: &str, text: &str, align: TextAlign) -> TableCell {
    TableCell {
        id: id.into(),
        col_span: 1,
        row_span: 1,
        align,
        blocks: vec![Block {
            id: format!("{id}-p"),
            kind: BlockKind::Paragraph {
                runs: vec![InlineRun::plain(text)],
                align,
                indent_level: 0,
            },
        }],
    }
}

const SAMPLE_MARKDOWN: &str = r#"# Orb — Long-Term Compatible Document Viewer

Welcome to **Orb**, a static web-hostable office document viewer and editor powered by a pure-Rust WebAssembly core and a 6-color theme architecture.

## Why Long-Term Compatibility Matters

Documents outlive software vendors, operating systems, and cloud services. Orb processes every file **100% locally in your browser** using small, auditable open-source crates:

- [x] **PDF** with interactive AcroForm filling, incremental-update export, and RustCrypto CMS/PKCS#7 signature verification
- [x] **Microsoft Word (`.docx`)** pure-Rust OOXML parser and writer
- [x] **Legacy Word 97–2003 (`.doc`)** pure-Rust OLE2/CFB binary decoder
- [x] **Markdown (`.md`)** CommonMark + GFM live split editor with `.docx` export

## Strict 6-Color Theme Contract

Every Orb theme defines at most **six unique base colors** (`base`, `ink`, `accent`, `positive`, `warning`, `danger`). All elevated surfaces, borders, hover states, and badges are computed declaratively using `color-mix(in oklch, ...)`.

| Token | Role | Mode Derivation |
| --- | --- | --- |
| `--orb-base` | Document chrome canvas | Light / Dark / Custom |
| `--orb-ink` | Primary typography & icons | High-contrast pair |
| `--orb-accent` | Active controls & focus rings | Mixed at 16% for soft tints |
| `--orb-positive` | Valid cryptographic signatures | Mixed at 14% for badges |
| `--orb-warning` | Post-signing updates & diagnostics | Mixed at 16% for notices |
| `--orb-danger` | Tampered bytes & parse errors | Mixed at 14% for alerts |

> Try switching between **System**, **Light**, and **Dark** in the top bar, or switch to **Split** mode above to edit this Markdown live and export it as a real `.docx` file.

```rust
// Platform-agnostic core: identical API for WASM today and native Windows/macOS tomorrow
let opened = orb_engine::open_document(&file_bytes, Some("contract.pdf"), &trusted_roots)?;
```
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_all_bundled_samples_via_magic_bytes() {
        for sample_desc in list_samples() {
            let generated = generate_sample(&sample_desc.id).expect("sample generation failed");
            let opened = open_document(&generated.bytes, Some(&generated.filename), &[])
                .expect("open_document failed");
            match (&sample_desc.format, &opened) {
                (DocumentFormat::Pdf, OpenedDocument::Pdf { inspection }) => {
                    assert!(inspection.page_count >= 1);
                    assert!(inspection.has_signatures);
                }
                (DocumentFormat::Docx, OpenedDocument::Word { word_format, ir }) => {
                    assert_eq!(*word_format, WordFormat::Docx);
                    assert!(!ir.blocks.is_empty());
                }
                (DocumentFormat::Doc, OpenedDocument::Word { word_format, ir }) => {
                    assert_eq!(*word_format, WordFormat::Doc);
                    assert!(!ir.blocks.is_empty());
                }
                (DocumentFormat::Markdown, OpenedDocument::Markdown { ir, .. }) => {
                    assert!(!ir.blocks.is_empty());
                }
                _ => panic!("mismatched format for {}", sample_desc.id),
            }
            let json = serde_json::to_string(&opened).expect("json serialize");
            match sample_desc.format {
                DocumentFormat::Markdown => assert!(json.contains("\"rawMarkdown\"")),
                DocumentFormat::Docx | DocumentFormat::Doc => {
                    assert!(json.contains("\"wordFormat\""));
                }
                DocumentFormat::Pdf => assert!(json.contains("\"formFields\"")),
            }
        }
    }
}
