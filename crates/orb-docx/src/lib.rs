mod reader;
mod writer;

use thiserror::Error;

pub use reader::parse_docx;
pub use writer::write_docx;

#[derive(Debug, Error)]
pub enum DocxError {
    #[error("invalid ZIP archive: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("XML parse error: {0}")]
    Xml(#[from] quick_xml::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("missing required OOXML part: {0}")]
    MissingPart(&'static str),
}

#[cfg(test)]
mod tests {
    use super::*;
    use orb_ir::{
        Block, BlockKind, DocumentFormat, DocumentIr, InlineRun, ListItem, MediaAsset, TableCell,
        TableRow, TextAlign, TextStyle,
    };

    #[test]
    fn docx_write_and_read_roundtrip() {
        let mut doc = DocumentIr::new(DocumentFormat::Docx, Some("Quarterly Report".into()));
        doc.metadata.author = Some("Orb Author".into());
        doc.blocks.push(Block {
            id: "h1".into(),
            kind: BlockKind::Heading {
                level: 1,
                runs: vec![InlineRun::plain("Executive Summary")],
                align: TextAlign::Left,
            },
        });
        doc.blocks.push(Block {
            id: "p1".into(),
            kind: BlockKind::Paragraph {
                runs: vec![
                    InlineRun::plain("Key metric: "),
                    InlineRun::styled(
                        "99.9% uptime",
                        TextStyle {
                            bold: true,
                            italic: true,
                            ..Default::default()
                        },
                    ),
                    InlineRun::plain(" — see "),
                    InlineRun::styled(
                        "specification",
                        TextStyle {
                            href: Some("https://example.org/spec".into()),
                            ..Default::default()
                        },
                    ),
                    InlineRun::plain(" or "),
                    InlineRun::styled(
                        "Appendix",
                        TextStyle {
                            href: Some("#appendix".into()),
                            ..Default::default()
                        },
                    ),
                ],
                align: TextAlign::Left,
                indent_level: 0,
            },
        });
        doc.blocks.push(Block {
            id: "hr1".into(),
            kind: BlockKind::HorizontalRule,
        });
        doc.blocks.push(Block {
            id: "code1".into(),
            kind: BlockKind::CodeBlock {
                language: None,
                code: "fn a() {}\n\nfn b() {}".into(),
            },
        });
        doc.blocks.push(Block {
            id: "l1".into(),
            kind: BlockKind::List {
                ordered: false,
                start: 1,
                items: vec![
                    ListItem {
                        id: "li1".into(),
                        checked: None,
                        runs: vec![InlineRun::plain("Bullet alpha")],
                        children: vec![],
                    },
                    ListItem {
                        id: "li2".into(),
                        checked: None,
                        runs: vec![InlineRun::plain("Bullet beta")],
                        children: vec![],
                    },
                ],
            },
        });
        doc.blocks.push(Block {
            id: "t1".into(),
            kind: BlockKind::Table {
                rows: vec![
                    TableRow {
                        header: true,
                        cells: vec![
                            TableCell {
                                id: "c00".into(),
                                col_span: 1,
                                row_span: 1,
                                align: TextAlign::Left,
                                blocks: vec![Block {
                                    id: "c00-p".into(),
                                    kind: BlockKind::Paragraph {
                                        runs: vec![InlineRun::plain("Item")],
                                        align: TextAlign::Left,
                                        indent_level: 0,
                                    },
                                }],
                            },
                            TableCell {
                                id: "c01".into(),
                                col_span: 1,
                                row_span: 1,
                                align: TextAlign::Right,
                                blocks: vec![Block {
                                    id: "c01-p".into(),
                                    kind: BlockKind::Paragraph {
                                        runs: vec![InlineRun::plain("Status")],
                                        align: TextAlign::Right,
                                        indent_level: 0,
                                    },
                                }],
                            },
                        ],
                    },
                    TableRow {
                        header: false,
                        cells: vec![
                            TableCell {
                                id: "c10".into(),
                                col_span: 1,
                                row_span: 1,
                                align: TextAlign::Left,
                                blocks: vec![Block {
                                    id: "c10-p".into(),
                                    kind: BlockKind::Paragraph {
                                        runs: vec![InlineRun::plain("PDF Engine")],
                                        align: TextAlign::Left,
                                        indent_level: 0,
                                    },
                                }],
                            },
                            TableCell {
                                id: "c11".into(),
                                col_span: 1,
                                row_span: 1,
                                align: TextAlign::Right,
                                blocks: vec![Block {
                                    id: "c11-p".into(),
                                    kind: BlockKind::Paragraph {
                                        runs: vec![InlineRun::plain("Verified")],
                                        align: TextAlign::Right,
                                        indent_level: 0,
                                    },
                                }],
                            },
                        ],
                    },
                ],
            },
        });
        // Minimal 1x1 valid PNG pixel
        doc.assets.push(MediaAsset {
            id: "asset-1".into(),
            mime_type: "image/png".into(),
            data_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=".into(),
            filename: Some("pixel.png".into()),
        });
        doc.blocks.push(Block {
            id: "img1".into(),
            kind: BlockKind::Image {
                asset_id: "asset-1".into(),
                alt: "Sample Pixel".into(),
                width_px: Some(120),
                height_px: Some(80),
                caption: None,
            },
        });
        doc.finalize();

        let bytes = write_docx(&doc).expect("write_docx failed");
        let parsed = parse_docx(&bytes, Some("report.docx")).expect("parse_docx failed");

        assert_eq!(parsed.title.as_deref(), Some("Quarterly Report"));
        assert_eq!(parsed.metadata.author.as_deref(), Some("Orb Author"));
        assert_eq!(parsed.outline.len(), 1);
        assert_eq!(parsed.outline[0].title, "Executive Summary");
        assert!(
            parsed
                .blocks
                .iter()
                .any(|b| matches!(b.kind, BlockKind::HorizontalRule))
        );
        assert!(parsed.blocks.iter().any(|b| matches!(
            &b.kind,
            BlockKind::CodeBlock { code, .. } if code == "fn a() {}\n\nfn b() {}"
        )));
        assert!(parsed.blocks.iter().any(|b| matches!(
            &b.kind,
            BlockKind::Paragraph { runs, .. } if runs.iter().any(|r| r.style.href.as_deref() == Some("#appendix"))
        )));
        assert!(
            parsed
                .blocks
                .iter()
                .any(|b| matches!(b.kind, BlockKind::List { ordered: false, .. }))
        );
        assert!(
            parsed
                .blocks
                .iter()
                .any(|b| matches!(b.kind, BlockKind::Table { .. }))
        );
        assert!(
            parsed
                .blocks
                .iter()
                .any(|b| matches!(b.kind, BlockKind::Image { .. }))
        );
        assert_eq!(parsed.assets.len(), 1);
    }
}
