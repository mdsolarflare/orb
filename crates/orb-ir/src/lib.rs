use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const IR_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum IrError {
    #[error("block not found: {0}")]
    BlockNotFound(String),
    #[error("invalid heading level {0}; expected 1..=6")]
    InvalidHeadingLevel(u8),
    #[error("table cell out of bounds: row={row}, col={col}")]
    CellOutOfBounds { row: usize, col: usize },
    #[error("list item index out of bounds: {0}")]
    ListItemOutOfBounds(usize),
    #[error("incompatible block kind for edit operation")]
    IncompatibleBlockKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentFormat {
    Markdown,
    Docx,
    Doc,
    Pdf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
    Justify,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub severity: DiagnosticSeverity,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMetadata {
    pub author: Option<String>,
    pub subject: Option<String>,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub word_count: usize,
    pub char_count: usize,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineItem {
    pub id: String,
    pub level: u8,
    pub title: String,
    pub block_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStyle {
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub underline: bool,
    #[serde(default)]
    pub strikethrough: bool,
    #[serde(default)]
    pub code: bool,
    #[serde(default)]
    pub superscript: bool,
    #[serde(default)]
    pub subscript: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size_pt: Option<f32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineRun {
    pub text: String,
    #[serde(default)]
    pub style: TextStyle,
}

impl InlineRun {
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            style: TextStyle::default(),
        }
    }

    pub fn styled(text: impl Into<String>, style: TextStyle) -> Self {
        Self {
            text: text.into(),
            style,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListItem {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    pub runs: Vec<InlineRun>,
    #[serde(default)]
    pub children: Vec<Block>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCell {
    pub id: String,
    #[serde(default = "default_span")]
    pub col_span: u16,
    #[serde(default = "default_span")]
    pub row_span: u16,
    #[serde(default)]
    pub align: TextAlign,
    pub blocks: Vec<Block>,
}

fn default_span() -> u16 {
    1
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRow {
    #[serde(default)]
    pub header: bool,
    pub cells: Vec<TableCell>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BlockKind {
    Heading {
        level: u8,
        runs: Vec<InlineRun>,
        #[serde(default)]
        align: TextAlign,
    },
    #[serde(rename_all = "camelCase")]
    Paragraph {
        runs: Vec<InlineRun>,
        #[serde(default)]
        align: TextAlign,
        #[serde(default)]
        indent_level: u8,
    },
    List {
        ordered: bool,
        #[serde(default = "default_list_start")]
        start: u32,
        items: Vec<ListItem>,
    },
    Table {
        rows: Vec<TableRow>,
    },
    BlockQuote {
        blocks: Vec<Block>,
    },
    CodeBlock {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        language: Option<String>,
        code: String,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        asset_id: String,
        alt: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        width_px: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        height_px: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        caption: Option<String>,
    },
    HorizontalRule,
    PageBreak,
    Footnote {
        label: String,
        blocks: Vec<Block>,
    },
}

fn default_list_start() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub id: String,
    #[serde(flatten)]
    pub kind: BlockKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: String,
    pub mime_type: String,
    pub data_base64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentIr {
    pub version: u32,
    pub title: Option<String>,
    pub source_format: DocumentFormat,
    pub metadata: DocumentMetadata,
    pub outline: Vec<OutlineItem>,
    pub blocks: Vec<Block>,
    pub assets: Vec<MediaAsset>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum EditOperation {
    #[serde(rename_all = "camelCase")]
    SetTitle { title: Option<String> },
    #[serde(rename_all = "camelCase")]
    UpdateBlockRuns {
        block_id: String,
        runs: Vec<InlineRun>,
    },
    #[serde(rename_all = "camelCase")]
    UpdateHeadingLevel { block_id: String, level: u8 },
    #[serde(rename_all = "camelCase")]
    UpdateCodeBlock {
        block_id: String,
        language: Option<String>,
        code: String,
    },
    #[serde(rename_all = "camelCase")]
    UpdateListItem {
        block_id: String,
        item_index: usize,
        runs: Vec<InlineRun>,
        checked: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    UpdateTableCell {
        block_id: String,
        row: usize,
        col: usize,
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    InsertBlockAfter {
        after_block_id: Option<String>,
        block: Block,
    },
    #[serde(rename_all = "camelCase")]
    DeleteBlock { block_id: String },
}

impl DocumentIr {
    pub fn new(source_format: DocumentFormat, title: Option<String>) -> Self {
        Self {
            version: IR_SCHEMA_VERSION,
            title,
            source_format,
            metadata: DocumentMetadata::default(),
            outline: Vec::new(),
            blocks: Vec::new(),
            assets: Vec::new(),
        }
    }

    pub fn add_diagnostic(
        &mut self,
        severity: DiagnosticSeverity,
        code: impl Into<String>,
        message: impl Into<String>,
    ) {
        self.metadata.diagnostics.push(Diagnostic {
            severity,
            code: code.into(),
            message: message.into(),
        });
    }

    /// Recomputes outline entries from headings and updates word/char statistics.
    pub fn finalize(&mut self) {
        self.rebuild_outline();
        self.recompute_stats();
        if self.title.is_none() {
            if let Some(first_heading) = self.outline.first() {
                if !first_heading.title.trim().is_empty() {
                    self.title = Some(first_heading.title.clone());
                }
            }
        }
    }

    pub fn rebuild_outline(&mut self) {
        self.outline.clear();
        for (idx, block) in self.blocks.iter().enumerate() {
            if let BlockKind::Heading { level, runs, .. } = &block.kind {
                let heading_text = runs_plain_text(runs).trim().to_string();
                if !heading_text.is_empty() {
                    self.outline.push(OutlineItem {
                        id: format!("outline-{idx}"),
                        level: (*level).clamp(1, 6),
                        title: heading_text,
                        block_id: block.id.clone(),
                    });
                }
            }
        }
    }

    pub fn recompute_stats(&mut self) {
        let mut words = 0usize;
        let mut chars = 0usize;
        for block in &self.blocks {
            count_block_stats(block, &mut words, &mut chars);
        }
        self.metadata.word_count = words;
        self.metadata.char_count = chars;
    }

    pub fn apply_edit(&mut self, op: EditOperation) -> Result<(), IrError> {
        match op {
            EditOperation::SetTitle { title } => {
                self.title = title;
            }
            EditOperation::UpdateBlockRuns { block_id, runs } => {
                let block = find_block_mut(&mut self.blocks, &block_id)
                    .ok_or_else(|| IrError::BlockNotFound(block_id))?;
                match &mut block.kind {
                    BlockKind::Paragraph { runs: target, .. }
                    | BlockKind::Heading { runs: target, .. } => {
                        *target = merge_adjacent_runs(runs);
                    }
                    _ => return Err(IrError::IncompatibleBlockKind),
                }
            }
            EditOperation::UpdateHeadingLevel { block_id, level } => {
                if !(1..=6).contains(&level) {
                    return Err(IrError::InvalidHeadingLevel(level));
                }
                let block = find_block_mut(&mut self.blocks, &block_id)
                    .ok_or_else(|| IrError::BlockNotFound(block_id))?;
                match &mut block.kind {
                    BlockKind::Heading { level: target, .. } => {
                        *target = level;
                    }
                    _ => return Err(IrError::IncompatibleBlockKind),
                }
            }
            EditOperation::UpdateCodeBlock {
                block_id,
                language,
                code,
            } => {
                let block = find_block_mut(&mut self.blocks, &block_id)
                    .ok_or_else(|| IrError::BlockNotFound(block_id))?;
                match &mut block.kind {
                    BlockKind::CodeBlock {
                        language: target_lang,
                        code: target_code,
                    } => {
                        *target_lang = language;
                        *target_code = code;
                    }
                    _ => return Err(IrError::IncompatibleBlockKind),
                }
            }
            EditOperation::UpdateListItem {
                block_id,
                item_index,
                runs,
                checked,
            } => {
                let block = find_block_mut(&mut self.blocks, &block_id)
                    .ok_or_else(|| IrError::BlockNotFound(block_id))?;
                match &mut block.kind {
                    BlockKind::List { items, .. } => {
                        let item = items
                            .get_mut(item_index)
                            .ok_or(IrError::ListItemOutOfBounds(item_index))?;
                        item.runs = merge_adjacent_runs(runs);
                        if checked.is_some() {
                            item.checked = checked;
                        }
                    }
                    _ => return Err(IrError::IncompatibleBlockKind),
                }
            }
            EditOperation::UpdateTableCell {
                block_id,
                row,
                col,
                text,
            } => {
                let block = find_block_mut(&mut self.blocks, &block_id)
                    .ok_or_else(|| IrError::BlockNotFound(block_id))?;
                match &mut block.kind {
                    BlockKind::Table { rows } => {
                        let cell = rows
                            .get_mut(row)
                            .and_then(|r| r.cells.get_mut(col))
                            .ok_or(IrError::CellOutOfBounds { row, col })?;
                        let cell_block_id = cell
                            .blocks
                            .first()
                            .map(|b| b.id.clone())
                            .unwrap_or_else(|| format!("{}-p0", cell.id));
                        cell.blocks = vec![Block {
                            id: cell_block_id,
                            kind: BlockKind::Paragraph {
                                runs: vec![InlineRun::plain(text)],
                                align: cell.align,
                                indent_level: 0,
                            },
                        }];
                    }
                    _ => return Err(IrError::IncompatibleBlockKind),
                }
            }
            EditOperation::InsertBlockAfter {
                after_block_id,
                block,
            } => {
                if let Some(after_id) = after_block_id {
                    if let Some(pos) = self.blocks.iter().position(|b| b.id == after_id) {
                        self.blocks.insert(pos + 1, block);
                    } else {
                        return Err(IrError::BlockNotFound(after_id));
                    }
                } else {
                    self.blocks.push(block);
                }
            }
            EditOperation::DeleteBlock { block_id } => {
                let before = self.blocks.len();
                self.blocks.retain(|b| b.id != block_id);
                if self.blocks.len() == before {
                    return Err(IrError::BlockNotFound(block_id));
                }
            }
        }
        self.rebuild_outline();
        self.recompute_stats();
        Ok(())
    }

    pub fn plain_text(&self) -> String {
        let mut out = String::new();
        for block in &self.blocks {
            append_block_plain_text(block, &mut out);
        }
        out.trim().to_string()
    }
}

pub fn runs_plain_text(runs: &[InlineRun]) -> String {
    let mut s = String::new();
    for run in runs {
        s.push_str(&run.text);
    }
    s
}

pub fn merge_adjacent_runs(runs: Vec<InlineRun>) -> Vec<InlineRun> {
    let mut merged: Vec<InlineRun> = Vec::with_capacity(runs.len());
    for run in runs {
        if run.text.is_empty() {
            continue;
        }
        if let Some(last) = merged.last_mut() {
            if last.style == run.style {
                last.text.push_str(&run.text);
                continue;
            }
        }
        merged.push(run);
    }
    merged
}

fn find_block_mut<'a>(blocks: &'a mut [Block], id: &str) -> Option<&'a mut Block> {
    for block in blocks {
        if block.id == id {
            return Some(block);
        }
        match &mut block.kind {
            BlockKind::BlockQuote { blocks: inner } | BlockKind::Footnote { blocks: inner, .. } => {
                if let Some(found) = find_block_mut(inner, id) {
                    return Some(found);
                }
            }
            BlockKind::List { items, .. } => {
                for item in items {
                    if let Some(found) = find_block_mut(&mut item.children, id) {
                        return Some(found);
                    }
                }
            }
            BlockKind::Table { rows } => {
                for row in rows {
                    for cell in &mut row.cells {
                        if let Some(found) = find_block_mut(&mut cell.blocks, id) {
                            return Some(found);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    None
}

fn count_runs_stats(runs: &[InlineRun], words: &mut usize, chars: &mut usize) {
    let text = runs_plain_text(runs);
    *words += text.split_whitespace().count();
    *chars += text.chars().count();
}

fn count_block_stats(block: &Block, words: &mut usize, chars: &mut usize) {
    match &block.kind {
        BlockKind::Heading { runs, .. } | BlockKind::Paragraph { runs, .. } => {
            count_runs_stats(runs, words, chars);
        }
        BlockKind::List { items, .. } => {
            for item in items {
                count_runs_stats(&item.runs, words, chars);
                for child in &item.children {
                    count_block_stats(child, words, chars);
                }
            }
        }
        BlockKind::Table { rows } => {
            for row in rows {
                for cell in &row.cells {
                    for b in &cell.blocks {
                        count_block_stats(b, words, chars);
                    }
                }
            }
        }
        BlockKind::BlockQuote { blocks } | BlockKind::Footnote { blocks, .. } => {
            for b in blocks {
                count_block_stats(b, words, chars);
            }
        }
        BlockKind::CodeBlock { code, .. } => {
            *words += code.split_whitespace().count();
            *chars += code.chars().count();
        }
        BlockKind::Image { alt, caption, .. } => {
            *words += alt.split_whitespace().count();
            *chars += alt.chars().count();
            if let Some(cap) = caption {
                *words += cap.split_whitespace().count();
                *chars += cap.chars().count();
            }
        }
        BlockKind::HorizontalRule | BlockKind::PageBreak => {}
    }
}

fn append_block_plain_text(block: &Block, out: &mut String) {
    match &block.kind {
        BlockKind::Heading { runs, .. } | BlockKind::Paragraph { runs, .. } => {
            out.push_str(&runs_plain_text(runs));
            out.push('\n');
        }
        BlockKind::List { items, .. } => {
            for item in items {
                out.push_str(&runs_plain_text(&item.runs));
                out.push('\n');
                for child in &item.children {
                    append_block_plain_text(child, out);
                }
            }
        }
        BlockKind::Table { rows } => {
            for row in rows {
                for (i, cell) in row.cells.iter().enumerate() {
                    if i > 0 {
                        out.push('\t');
                    }
                    let mut cell_text = String::new();
                    for b in &cell.blocks {
                        append_block_plain_text(b, &mut cell_text);
                    }
                    out.push_str(cell_text.trim());
                }
                out.push('\n');
            }
        }
        BlockKind::BlockQuote { blocks } | BlockKind::Footnote { blocks, .. } => {
            for b in blocks {
                append_block_plain_text(b, out);
            }
        }
        BlockKind::CodeBlock { code, .. } => {
            out.push_str(code);
            out.push('\n');
        }
        BlockKind::Image { alt, .. } => {
            if !alt.is_empty() {
                out.push_str(alt);
                out.push('\n');
            }
        }
        BlockKind::HorizontalRule | BlockKind::PageBreak => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_operations_update_outline_and_stats() {
        let mut doc = DocumentIr::new(DocumentFormat::Markdown, None);
        doc.blocks.push(Block {
            id: "b1".into(),
            kind: BlockKind::Heading {
                level: 1,
                runs: vec![InlineRun::plain("Initial Title")],
                align: TextAlign::Left,
            },
        });
        doc.blocks.push(Block {
            id: "b2".into(),
            kind: BlockKind::Paragraph {
                runs: vec![InlineRun::plain("Hello world")],
                align: TextAlign::Left,
                indent_level: 0,
            },
        });
        doc.finalize();

        assert_eq!(doc.title.as_deref(), Some("Initial Title"));
        assert_eq!(doc.outline.len(), 1);
        assert_eq!(doc.metadata.word_count, 4);

        doc.apply_edit(EditOperation::UpdateBlockRuns {
            block_id: "b1".into(),
            runs: vec![InlineRun::plain("Updated"), InlineRun::plain(" Heading")],
        })
        .unwrap();

        assert_eq!(doc.outline[0].title, "Updated Heading");
        assert_eq!(doc.metadata.word_count, 4);

        doc.apply_edit(EditOperation::InsertBlockAfter {
            after_block_id: Some("b2".into()),
            block: Block {
                id: "b3".into(),
                kind: BlockKind::Paragraph {
                    runs: vec![InlineRun::plain("Extra words here")],
                    align: TextAlign::Left,
                    indent_level: 0,
                },
            },
        })
        .unwrap();
        assert_eq!(doc.blocks.len(), 3);
        assert_eq!(doc.metadata.word_count, 7);

        doc.apply_edit(EditOperation::DeleteBlock {
            block_id: "b2".into(),
        })
        .unwrap();
        assert_eq!(doc.blocks.len(), 2);
        assert_eq!(doc.metadata.word_count, 5);
    }
}
