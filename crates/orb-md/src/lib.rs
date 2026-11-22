use orb_ir::{
    Block, BlockKind, DocumentFormat, DocumentIr, InlineRun, ListItem, MediaAsset, TableCell,
    TableRow, TextAlign, TextStyle, merge_adjacent_runs, runs_plain_text,
};
use pulldown_cmark::{Alignment, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

pub fn parse_markdown(input: &str, filename: Option<&str>) -> DocumentIr {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_HEADING_ATTRIBUTES);

    let title = filename.map(strip_extension);
    let mut doc = DocumentIr::new(DocumentFormat::Markdown, title);
    let parser = Parser::new_ext(input, options);

    let mut builder = MdBuilder::new();
    for event in parser {
        builder.handle_event(event);
    }
    builder.finish(&mut doc);
    doc.finalize();
    doc
}

pub fn serialize_markdown(doc: &DocumentIr) -> String {
    let mut out = String::new();
    for (idx, block) in doc.blocks.iter().enumerate() {
        if idx > 0 {
            out.push('\n');
        }
        write_block(block, &doc.assets, 0, &mut out);
    }
    if !out.ends_with('\n') && !out.is_empty() {
        out.push('\n');
    }
    out
}

fn strip_extension(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(stem, _)| stem.to_string())
        .unwrap_or_else(|| name.to_string())
}

enum Container {
    Root(Vec<Block>),
    Heading {
        level: u8,
        runs: Vec<InlineRun>,
    },
    Paragraph {
        runs: Vec<InlineRun>,
    },
    BlockQuote {
        blocks: Vec<Block>,
    },
    CodeBlock {
        language: Option<String>,
        code: String,
    },
    List {
        ordered: bool,
        start: u32,
        items: Vec<ListItem>,
    },
    ListItem {
        id: String,
        checked: Option<bool>,
        runs: Vec<InlineRun>,
        children: Vec<Block>,
    },
    Table {
        alignments: Vec<TextAlign>,
        rows: Vec<TableRow>,
        in_head: bool,
    },
    TableRow {
        header: bool,
        cells: Vec<TableCell>,
    },
    TableCell {
        id: String,
        align: TextAlign,
        runs: Vec<InlineRun>,
    },
    Footnote {
        label: String,
        blocks: Vec<Block>,
    },
    Image {
        dest_url: String,
        alt: String,
    },
}

struct MdBuilder {
    stack: Vec<Container>,
    style_stack: Vec<TextStyle>,
    assets: Vec<MediaAsset>,
    next_id: usize,
}

impl MdBuilder {
    fn new() -> Self {
        Self {
            stack: vec![Container::Root(Vec::new())],
            style_stack: vec![TextStyle::default()],
            assets: Vec::new(),
            next_id: 1,
        }
    }

    fn alloc_id(&mut self, prefix: &str) -> String {
        let id = format!("{prefix}-{}", self.next_id);
        self.next_id += 1;
        id
    }

    fn current_style(&self) -> TextStyle {
        self.style_stack.last().cloned().unwrap_or_default()
    }

    fn push_style<F: FnOnce(&mut TextStyle)>(&mut self, f: F) {
        let mut next = self.current_style();
        f(&mut next);
        self.style_stack.push(next);
    }

    fn pop_style(&mut self) {
        if self.style_stack.len() > 1 {
            self.style_stack.pop();
        }
    }

    fn push_run(&mut self, text: String, style: TextStyle) {
        if text.is_empty() {
            return;
        }
        match self.stack.last_mut() {
            Some(Container::Image { alt, .. }) => alt.push_str(&text),
            Some(Container::CodeBlock { code, .. }) => code.push_str(&text),
            Some(Container::Heading { runs, .. })
            | Some(Container::Paragraph { runs })
            | Some(Container::ListItem { runs, .. })
            | Some(Container::TableCell { runs, .. }) => {
                runs.push(InlineRun::styled(text, style));
            }
            _ => {}
        }
    }

    fn push_block(&mut self, block: Block) {
        match self.stack.last_mut() {
            Some(Container::Root(blocks))
            | Some(Container::BlockQuote { blocks })
            | Some(Container::Footnote { blocks, .. }) => blocks.push(block),
            Some(Container::ListItem { runs, children, .. }) => {
                if runs.is_empty() && children.is_empty() {
                    if let BlockKind::Paragraph { runs: p_runs, .. } = block.kind {
                        *runs = p_runs;
                        return;
                    }
                }
                children.push(block);
            }
            _ => {
                if let Some(Container::Root(blocks)) = self.stack.first_mut() {
                    blocks.push(block);
                }
            }
        }
    }

    fn handle_event(&mut self, event: Event<'_>) {
        match event {
            Event::Start(tag) => match tag {
                Tag::Heading { level, .. } => {
                    let lvl = match level {
                        HeadingLevel::H1 => 1,
                        HeadingLevel::H2 => 2,
                        HeadingLevel::H3 => 3,
                        HeadingLevel::H4 => 4,
                        HeadingLevel::H5 => 5,
                        HeadingLevel::H6 => 6,
                    };
                    self.stack.push(Container::Heading {
                        level: lvl,
                        runs: Vec::new(),
                    });
                }
                Tag::Paragraph => {
                    self.stack.push(Container::Paragraph { runs: Vec::new() });
                }
                Tag::BlockQuote(_) => {
                    self.stack.push(Container::BlockQuote { blocks: Vec::new() });
                }
                Tag::CodeBlock(kind) => {
                    let language = match kind {
                        CodeBlockKind::Fenced(lang) => {
                            let trimmed = lang.trim();
                            if trimmed.is_empty() {
                                None
                            } else {
                                Some(trimmed.to_string())
                            }
                        }
                        CodeBlockKind::Indented => None,
                    };
                    self.stack.push(Container::CodeBlock {
                        language,
                        code: String::new(),
                    });
                }
                Tag::List(start_opt) => {
                    self.stack.push(Container::List {
                        ordered: start_opt.is_some(),
                        start: start_opt.unwrap_or(1) as u32,
                        items: Vec::new(),
                    });
                }
                Tag::Item => {
                    let id = self.alloc_id("li");
                    self.stack.push(Container::ListItem {
                        id,
                        checked: None,
                        runs: Vec::new(),
                        children: Vec::new(),
                    });
                }
                Tag::Table(aligns) => {
                    let alignments = aligns
                        .into_iter()
                        .map(|a| match a {
                            Alignment::Left | Alignment::None => TextAlign::Left,
                            Alignment::Center => TextAlign::Center,
                            Alignment::Right => TextAlign::Right,
                        })
                        .collect();
                    self.stack.push(Container::Table {
                        alignments,
                        rows: Vec::new(),
                        in_head: false,
                    });
                }
                Tag::TableHead => {
                    if let Some(Container::Table { in_head, .. }) = self.stack.last_mut() {
                        *in_head = true;
                    }
                    self.stack.push(Container::TableRow {
                        header: true,
                        cells: Vec::new(),
                    });
                }
                Tag::TableRow => {
                    let header = matches!(
                        self.stack.last(),
                        Some(Container::Table { in_head: true, .. })
                    );
                    self.stack.push(Container::TableRow {
                        header,
                        cells: Vec::new(),
                    });
                }
                Tag::TableCell => {
                    let col_idx = match self.stack.last() {
                        Some(Container::TableRow { cells, .. }) => cells.len(),
                        _ => 0,
                    };
                    let align = self
                        .stack
                        .iter()
                        .rev()
                        .find_map(|c| match c {
                            Container::Table { alignments, .. } => alignments.get(col_idx).copied(),
                            _ => None,
                        })
                        .unwrap_or(TextAlign::Left);
                    let id = self.alloc_id("cell");
                    self.stack.push(Container::TableCell {
                        id,
                        align,
                        runs: Vec::new(),
                    });
                }
                Tag::FootnoteDefinition(label) => {
                    self.stack.push(Container::Footnote {
                        label: label.to_string(),
                        blocks: Vec::new(),
                    });
                }
                Tag::Strong => self.push_style(|s| s.bold = true),
                Tag::Emphasis => self.push_style(|s| s.italic = true),
                Tag::Strikethrough => self.push_style(|s| s.strikethrough = true),
                Tag::Superscript => self.push_style(|s| s.superscript = true),
                Tag::Subscript => self.push_style(|s| s.subscript = true),
                Tag::Link { dest_url, .. } => {
                    let url = dest_url.to_string();
                    self.push_style(|s| s.href = Some(url));
                }
                Tag::Image { dest_url, .. } => {
                    self.stack.push(Container::Image {
                        dest_url: dest_url.to_string(),
                        alt: String::new(),
                    });
                }
                _ => {}
            },
            Event::End(tag_end) => match tag_end {
                TagEnd::Heading(_) => {
                    if let Some(Container::Heading { level, runs }) = self.stack.pop() {
                        let id = self.alloc_id("h");
                        self.push_block(Block {
                            id,
                            kind: BlockKind::Heading {
                                level,
                                runs: merge_adjacent_runs(runs),
                                align: TextAlign::Left,
                            },
                        });
                    }
                }
                TagEnd::Paragraph => {
                    if let Some(Container::Paragraph { runs }) = self.stack.pop() {
                        let merged = merge_adjacent_runs(runs);
                        if !merged.is_empty() {
                            let id = self.alloc_id("p");
                            self.push_block(Block {
                                id,
                                kind: BlockKind::Paragraph {
                                    runs: merged,
                                    align: TextAlign::Left,
                                    indent_level: 0,
                                },
                            });
                        }
                    }
                }
                TagEnd::BlockQuote(_) => {
                    if let Some(Container::BlockQuote { blocks }) = self.stack.pop() {
                        let id = self.alloc_id("bq");
                        self.push_block(Block {
                            id,
                            kind: BlockKind::BlockQuote { blocks },
                        });
                    }
                }
                TagEnd::CodeBlock => {
                    if let Some(Container::CodeBlock { language, mut code }) = self.stack.pop() {
                        if code.ends_with('\n') {
                            code.pop();
                        }
                        let id = self.alloc_id("code");
                        self.push_block(Block {
                            id,
                            kind: BlockKind::CodeBlock { language, code },
                        });
                    }
                }
                TagEnd::List(_) => {
                    if let Some(Container::List {
                        ordered,
                        start,
                        items,
                    }) = self.stack.pop()
                    {
                        let id = self.alloc_id("list");
                        self.push_block(Block {
                            id,
                            kind: BlockKind::List {
                                ordered,
                                start,
                                items,
                            },
                        });
                    }
                }
                TagEnd::Item => {
                    if let Some(Container::ListItem {
                        id,
                        checked,
                        runs,
                        children,
                    }) = self.stack.pop()
                    {
                        let item = ListItem {
                            id,
                            checked,
                            runs: merge_adjacent_runs(runs),
                            children,
                        };
                        if let Some(Container::List { items, .. }) = self.stack.last_mut() {
                            items.push(item);
                        }
                    }
                }
                TagEnd::TableHead => {
                    if let Some(Container::TableRow { header, cells }) = self.stack.pop() {
                        if let Some(Container::Table { rows, in_head, .. }) = self.stack.last_mut()
                        {
                            *in_head = false;
                            if !cells.is_empty() {
                                rows.push(TableRow { header, cells });
                            }
                        }
                    }
                }
                TagEnd::TableRow => {
                    if let Some(Container::TableRow { header, cells }) = self.stack.pop() {
                        if let Some(Container::Table { rows, .. }) = self.stack.last_mut() {
                            rows.push(TableRow { header, cells });
                        }
                    }
                }
                TagEnd::TableCell => {
                    if let Some(Container::TableCell { id, align, runs }) = self.stack.pop() {
                        let p_id = format!("{id}-p0");
                        let cell = TableCell {
                            id,
                            col_span: 1,
                            row_span: 1,
                            align,
                            blocks: vec![Block {
                                id: p_id,
                                kind: BlockKind::Paragraph {
                                    runs: merge_adjacent_runs(runs),
                                    align,
                                    indent_level: 0,
                                },
                            }],
                        };
                        if let Some(Container::TableRow { cells, .. }) = self.stack.last_mut() {
                            cells.push(cell);
                        }
                    }
                }
                TagEnd::Table => {
                    if let Some(Container::Table { rows, .. }) = self.stack.pop() {
                        let id = self.alloc_id("tbl");
                        self.push_block(Block {
                            id,
                            kind: BlockKind::Table { rows },
                        });
                    }
                }
                TagEnd::FootnoteDefinition => {
                    if let Some(Container::Footnote { label, blocks }) = self.stack.pop() {
                        let id = self.alloc_id("fn");
                        self.push_block(Block {
                            id,
                            kind: BlockKind::Footnote { label, blocks },
                        });
                    }
                }
                TagEnd::Strong
                | TagEnd::Emphasis
                | TagEnd::Strikethrough
                | TagEnd::Superscript
                | TagEnd::Subscript
                | TagEnd::Link => {
                    self.pop_style();
                }
                TagEnd::Image => {
                    if let Some(Container::Image { dest_url, alt }) = self.stack.pop() {
                        if let Some((mime_type, data_base64)) = parse_data_uri(&dest_url) {
                            let asset_id = self.alloc_id("asset");
                            self.assets.push(MediaAsset {
                                id: asset_id.clone(),
                                mime_type,
                                data_base64,
                                filename: None,
                            });
                            let block_id = self.alloc_id("img");
                            // If inside a paragraph with no other runs, emit as image block on parent.
                            if matches!(self.stack.last(), Some(Container::Paragraph { runs }) if runs.is_empty())
                            {
                                let _ = self.stack.pop();
                                self.push_block(Block {
                                    id: block_id,
                                    kind: BlockKind::Image {
                                        asset_id,
                                        alt,
                                        width_px: None,
                                        height_px: None,
                                        caption: None,
                                    },
                                });
                                self.stack.push(Container::Paragraph { runs: Vec::new() });
                            } else {
                                self.push_block(Block {
                                    id: block_id,
                                    kind: BlockKind::Image {
                                        asset_id,
                                        alt,
                                        width_px: None,
                                        height_px: None,
                                        caption: None,
                                    },
                                });
                            }
                        } else {
                            let label = if alt.is_empty() {
                                dest_url.clone()
                            } else {
                                format!("[Image: {alt}]")
                            };
                            let mut style = self.current_style();
                            style.href = Some(dest_url);
                            self.push_run(label, style);
                        }
                    }
                }
                _ => {}
            },
            Event::Text(text) => {
                let style = self.current_style();
                self.push_run(text.to_string(), style);
            }
            Event::Code(code) => {
                let mut style = self.current_style();
                style.code = true;
                self.push_run(code.to_string(), style);
            }
            Event::SoftBreak => {
                let style = self.current_style();
                self.push_run(" ".to_string(), style);
            }
            Event::HardBreak => {
                let style = self.current_style();
                self.push_run("\n".to_string(), style);
            }
            Event::Rule => {
                let id = self.alloc_id("hr");
                self.push_block(Block {
                    id,
                    kind: BlockKind::HorizontalRule,
                });
            }
            Event::TaskListMarker(checked) => {
                if let Some(Container::ListItem {
                    checked: slot, ..
                }) = self.stack.last_mut()
                {
                    *slot = Some(checked);
                }
            }
            Event::FootnoteReference(label) => {
                let mut style = self.current_style();
                style.superscript = true;
                self.push_run(format!("[{label}]"), style);
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                let trimmed = html.trim();
                if !trimmed.is_empty() {
                    let style = self.current_style();
                    self.push_run(trimmed.to_string(), style);
                }
            }
            _ => {}
        }
    }

    fn finish(mut self, doc: &mut DocumentIr) {
        while self.stack.len() > 1 {
            let _ = self.stack.pop();
        }
        if let Some(Container::Root(blocks)) = self.stack.pop() {
            doc.blocks = blocks;
        }
        doc.assets = self.assets;
    }
}

fn parse_data_uri(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let mime = meta.strip_suffix(";base64")?;
    Some((mime.to_string(), data.to_string()))
}

fn write_block(block: &Block, assets: &[MediaAsset], indent: usize, out: &mut String) {
    let pad = " ".repeat(indent);
    match &block.kind {
        BlockKind::Heading { level, runs, .. } => {
            out.push_str(&pad);
            for _ in 0..(*level).clamp(1, 6) {
                out.push('#');
            }
            out.push(' ');
            out.push_str(&format_runs(runs));
            out.push('\n');
        }
        BlockKind::Paragraph { runs, .. } => {
            out.push_str(&pad);
            out.push_str(&format_runs(runs));
            out.push('\n');
        }
        BlockKind::List {
            ordered,
            start,
            items,
        } => {
            for (idx, item) in items.iter().enumerate() {
                out.push_str(&pad);
                if *ordered {
                    out.push_str(&format!("{}. ", *start as usize + idx));
                } else {
                    out.push_str("- ");
                }
                if let Some(checked) = item.checked {
                    out.push_str(if checked { "[x] " } else { "[ ] " });
                }
                out.push_str(&format_runs(&item.runs));
                out.push('\n');
                for child in &item.children {
                    write_block(child, assets, indent + 2, out);
                }
            }
        }
        BlockKind::Table { rows } => {
            if rows.is_empty() {
                return;
            }
            let col_count = rows.iter().map(|r| r.cells.len()).max().unwrap_or(0);
            if col_count == 0 {
                return;
            }
            for (row_idx, row) in rows.iter().enumerate() {
                out.push_str(&pad);
                out.push('|');
                for col in 0..col_count {
                    let text = row
                        .cells
                        .get(col)
                        .map(|c| {
                            c.blocks
                                .iter()
                                .map(|b| match &b.kind {
                                    BlockKind::Paragraph { runs, .. }
                                    | BlockKind::Heading { runs, .. } => format_runs(runs),
                                    _ => String::new(),
                                })
                                .collect::<Vec<_>>()
                                .join(" ")
                                .replace('|', "\\|")
                                .replace('\n', " ")
                        })
                        .unwrap_or_default();
                    out.push(' ');
                    out.push_str(text.trim());
                    out.push_str(" |");
                }
                out.push('\n');
                if row_idx == 0 {
                    out.push_str(&pad);
                    out.push('|');
                    for col in 0..col_count {
                        let align = row
                            .cells
                            .get(col)
                            .map(|c| c.align)
                            .unwrap_or(TextAlign::Left);
                        let sep = match align {
                            TextAlign::Center => " :---: |",
                            TextAlign::Right => " ---: |",
                            _ => " --- |",
                        };
                        out.push_str(sep);
                    }
                    out.push('\n');
                }
            }
        }
        BlockKind::BlockQuote { blocks } => {
            let mut inner = String::new();
            for b in blocks {
                write_block(b, assets, 0, &mut inner);
            }
            for line in inner.lines() {
                out.push_str(&pad);
                out.push_str("> ");
                out.push_str(line);
                out.push('\n');
            }
        }
        BlockKind::CodeBlock { language, code } => {
            out.push_str(&pad);
            out.push_str("```");
            if let Some(lang) = language {
                out.push_str(lang);
            }
            out.push('\n');
            for line in code.lines() {
                out.push_str(&pad);
                out.push_str(line);
                out.push('\n');
            }
            out.push_str(&pad);
            out.push_str("```\n");
        }
        BlockKind::Image { asset_id, alt, .. } => {
            if let Some(asset) = assets.iter().find(|a| a.id == *asset_id) {
                out.push_str(&pad);
                out.push_str(&format!(
                    "![{alt}](data:{};base64,{})\n",
                    asset.mime_type, asset.data_base64
                ));
            } else {
                out.push_str(&pad);
                out.push_str(&format!("![{alt}](#{asset_id})\n"));
            }
        }
        BlockKind::HorizontalRule => {
            out.push_str(&pad);
            out.push_str("---\n");
        }
        BlockKind::PageBreak => {
            out.push_str(&pad);
            out.push_str("\n---\n");
        }
        BlockKind::Footnote { label, blocks } => {
            let mut inner = String::new();
            for b in blocks {
                if let BlockKind::Paragraph { runs, .. } = &b.kind {
                    inner.push_str(&runs_plain_text(runs));
                }
            }
            out.push_str(&pad);
            out.push_str(&format!("[^{label}]: {}\n", inner.trim()));
        }
    }
}

fn format_runs(runs: &[InlineRun]) -> String {
    let mut out = String::new();
    for run in runs {
        let mut s = run.text.clone();
        if run.style.code {
            s = format!("`{s}`");
        } else {
            if run.style.strikethrough {
                s = format!("~~{s}~~");
            }
            if run.style.bold && run.style.italic {
                s = format!("***{s}***");
            } else if run.style.bold {
                s = format!("**{s}**");
            } else if run.style.italic {
                s = format!("*{s}*");
            }
            if let Some(href) = &run.style.href {
                s = format!("[{s}]({href})");
            }
        }
        out.push_str(&s);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gfm_features_and_roundtrips() {
        let src = "\
# Orb Guide

A paragraph with **bold**, *italic*, `code`, and a [link](https://example.com).

- [x] Verify PDF signatures
- [ ] Export `.docx`

| Format | Support |
| --- | :---: |
| PDF | Yes |
| DOCX | Yes |

```rust
fn main() {}
```
";
        let ir = parse_markdown(src, Some("guide.md"));
        assert_eq!(ir.outline.len(), 1);
        assert_eq!(ir.outline[0].title, "Orb Guide");
        assert!(ir.blocks.iter().any(|b| matches!(b.kind, BlockKind::Table { .. })));
        assert!(ir.blocks.iter().any(|b| matches!(b.kind, BlockKind::List { .. })));
        assert!(ir.blocks.iter().any(|b| matches!(b.kind, BlockKind::CodeBlock { .. })));

        let serialized = serialize_markdown(&ir);
        assert!(serialized.contains("# Orb Guide"));
        assert!(serialized.contains("- [x] Verify PDF signatures"));
        assert!(serialized.contains("| Format | Support |"));
        assert!(serialized.contains("```rust"));
    }
}
