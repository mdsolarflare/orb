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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BlockConvertTarget {
    Paragraph,
    Heading { level: u8 },
    BlockQuote,
    CodeBlock,
    List { ordered: bool, checklist: bool },
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
    SetBlockAlign { block_id: String, align: TextAlign },
    #[serde(rename_all = "camelCase")]
    SetBlockIndent { block_id: String, indent_level: u8 },
    #[serde(rename_all = "camelCase")]
    ConvertBlockKind {
        block_id: String,
        target: BlockConvertTarget,
    },
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
    AddListItem {
        block_id: String,
        after_index: Option<usize>,
        item: ListItem,
    },
    #[serde(rename_all = "camelCase")]
    DeleteListItem { block_id: String, item_index: usize },
    #[serde(rename_all = "camelCase")]
    UpdateTableCell {
        block_id: String,
        row: usize,
        col: usize,
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    AddTableRow {
        block_id: String,
        after_row: Option<usize>,
    },
    #[serde(rename_all = "camelCase")]
    DeleteTableRow { block_id: String, row: usize },
    #[serde(rename_all = "camelCase")]
    AddTableColumn {
        block_id: String,
        after_col: Option<usize>,
    },
    #[serde(rename_all = "camelCase")]
    DeleteTableColumn { block_id: String, col: usize },
    #[serde(rename_all = "camelCase")]
    AddAsset { asset: MediaAsset },
    #[serde(rename_all = "camelCase")]
    ReplaceAllText {
        find: String,
        replace: String,
        #[serde(default)]
        case_sensitive: bool,
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
            EditOperation::SetBlockAlign { block_id, align } => {
                let block = find_block_mut(&mut self.blocks, &block_id)
                    .ok_or_else(|| IrError::BlockNotFound(block_id))?;
                match &mut block.kind {
                    BlockKind::Paragraph { align: target, .. }
                    | BlockKind::Heading { align: target, .. } => {
                        *target = align;
                    }
                    BlockKind::BlockQuote { blocks: inner } => {
                        for child in inner {
                            match &mut child.kind {
                                BlockKind::Paragraph { align: target, .. }
                                | BlockKind::Heading { align: target, .. } => {
                                    *target = align;
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => return Err(IrError::IncompatibleBlockKind),
                }
            }
            EditOperation::SetBlockIndent {
                block_id,
                indent_level,
            } => {
                let clamped = indent_level.min(6);
                let block = find_block_mut(&mut self.blocks, &block_id)
                    .ok_or_else(|| IrError::BlockNotFound(block_id))?;
                match &mut block.kind {
                    BlockKind::Paragraph {
                        indent_level: target,
                        ..
                    } => {
                        *target = clamped;
                    }
                    BlockKind::BlockQuote { blocks: inner } => {
                        for child in inner {
                            if let BlockKind::Paragraph {
                                indent_level: target,
                                ..
                            } = &mut child.kind
                            {
                                *target = clamped;
                            }
                        }
                    }
                    _ => return Err(IrError::IncompatibleBlockKind),
                }
            }
            EditOperation::ConvertBlockKind { block_id, target } => {
                if let BlockConvertTarget::Heading { level } = target {
                    if !(1..=6).contains(&level) {
                        return Err(IrError::InvalidHeadingLevel(level));
                    }
                }
                let block = find_block_mut(&mut self.blocks, &block_id)
                    .ok_or_else(|| IrError::BlockNotFound(block_id.clone()))?;
                convert_block_in_place(block, target)?;
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
            EditOperation::AddListItem {
                block_id,
                after_index,
                item,
            } => {
                let block = find_block_mut(&mut self.blocks, &block_id)
                    .ok_or_else(|| IrError::BlockNotFound(block_id))?;
                match &mut block.kind {
                    BlockKind::List { items, .. } => {
                        if let Some(idx) = after_index {
                            if idx >= items.len() {
                                return Err(IrError::ListItemOutOfBounds(idx));
                            }
                            items.insert(idx + 1, item);
                        } else {
                            items.push(item);
                        }
                    }
                    _ => return Err(IrError::IncompatibleBlockKind),
                }
            }
            EditOperation::DeleteListItem {
                block_id,
                item_index,
            } => {
                let block = find_block_mut(&mut self.blocks, &block_id)
                    .ok_or_else(|| IrError::BlockNotFound(block_id))?;
                match &mut block.kind {
                    BlockKind::List { items, .. } => {
                        if item_index >= items.len() {
                            return Err(IrError::ListItemOutOfBounds(item_index));
                        }
                        if items.len() <= 1 {
                            items[0].runs.clear();
                        } else {
                            items.remove(item_index);
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
            EditOperation::AddTableRow {
                block_id,
                after_row,
            } => {
                let block = find_block_mut(&mut self.blocks, &block_id)
                    .ok_or_else(|| IrError::BlockNotFound(block_id.clone()))?;
                match &mut block.kind {
                    BlockKind::Table { rows } => {
                        let cols = rows.first().map(|r| r.cells.len()).unwrap_or(2).max(1);
                        let mut next_seq = next_unique_cell_seq(rows);
                        let new_row = TableRow {
                            header: false,
                            cells: (0..cols)
                                .map(|_| {
                                    let cell_id = format!("{block_id}-cell-{next_seq}");
                                    next_seq += 1;
                                    TableCell {
                                        id: cell_id.clone(),
                                        col_span: 1,
                                        row_span: 1,
                                        align: TextAlign::Left,
                                        blocks: vec![Block {
                                            id: format!("{cell_id}-p0"),
                                            kind: BlockKind::Paragraph {
                                                runs: vec![],
                                                align: TextAlign::Left,
                                                indent_level: 0,
                                            },
                                        }],
                                    }
                                })
                                .collect(),
                        };
                        if let Some(idx) = after_row {
                            if idx >= rows.len() {
                                return Err(IrError::CellOutOfBounds { row: idx, col: 0 });
                            }
                            rows.insert(idx + 1, new_row);
                        } else {
                            rows.push(new_row);
                        }
                    }
                    _ => return Err(IrError::IncompatibleBlockKind),
                }
            }
            EditOperation::DeleteTableRow { block_id, row } => {
                let block = find_block_mut(&mut self.blocks, &block_id)
                    .ok_or_else(|| IrError::BlockNotFound(block_id))?;
                match &mut block.kind {
                    BlockKind::Table { rows } => {
                        if row >= rows.len() {
                            return Err(IrError::CellOutOfBounds { row, col: 0 });
                        }
                        if rows.len() > 1 {
                            rows.remove(row);
                        }
                    }
                    _ => return Err(IrError::IncompatibleBlockKind),
                }
            }
            EditOperation::AddTableColumn {
                block_id,
                after_col,
            } => {
                let block = find_block_mut(&mut self.blocks, &block_id)
                    .ok_or_else(|| IrError::BlockNotFound(block_id.clone()))?;
                match &mut block.kind {
                    BlockKind::Table { rows } => {
                        let mut next_seq = next_unique_cell_seq(rows);
                        for row in rows.iter_mut() {
                            let cell_id = format!("{block_id}-cell-{next_seq}");
                            next_seq += 1;
                            let new_cell = TableCell {
                                id: cell_id.clone(),
                                col_span: 1,
                                row_span: 1,
                                align: TextAlign::Left,
                                blocks: vec![Block {
                                    id: format!("{cell_id}-p0"),
                                    kind: BlockKind::Paragraph {
                                        runs: vec![],
                                        align: TextAlign::Left,
                                        indent_level: 0,
                                    },
                                }],
                            };
                            if let Some(idx) = after_col {
                                let insert_at = (idx + 1).min(row.cells.len());
                                row.cells.insert(insert_at, new_cell);
                            } else {
                                row.cells.push(new_cell);
                            }
                        }
                    }
                    _ => return Err(IrError::IncompatibleBlockKind),
                }
            }
            EditOperation::DeleteTableColumn { block_id, col } => {
                let block = find_block_mut(&mut self.blocks, &block_id)
                    .ok_or_else(|| IrError::BlockNotFound(block_id))?;
                match &mut block.kind {
                    BlockKind::Table { rows } => {
                        let min_cols = rows.iter().map(|r| r.cells.len()).min().unwrap_or(0);
                        if col >= min_cols {
                            return Err(IrError::CellOutOfBounds { row: 0, col });
                        }
                        if min_cols > 1 {
                            for row in rows.iter_mut() {
                                row.cells.remove(col);
                            }
                        }
                    }
                    _ => return Err(IrError::IncompatibleBlockKind),
                }
            }
            EditOperation::AddAsset { asset } => {
                if let Some(existing) = self.assets.iter_mut().find(|a| a.id == asset.id) {
                    *existing = asset;
                } else {
                    self.assets.push(asset);
                }
            }
            EditOperation::ReplaceAllText {
                find,
                replace,
                case_sensitive,
            } => {
                if !find.is_empty() {
                    for block in &mut self.blocks {
                        replace_in_block(block, &find, &replace, case_sensitive);
                    }
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
                if !delete_block_recursive(&mut self.blocks, &block_id, false) {
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

fn delete_block_recursive(
    blocks: &mut Vec<Block>,
    target_id: &str,
    require_remaining: bool,
) -> bool {
    if !require_remaining || blocks.len() > 1 {
        let before = blocks.len();
        blocks.retain(|b| b.id != target_id);
        if blocks.len() != before {
            return true;
        }
    }
    for block in blocks.iter_mut() {
        match &mut block.kind {
            BlockKind::BlockQuote { blocks: inner }
            | BlockKind::Footnote { blocks: inner, .. } => {
                if delete_block_recursive(inner, target_id, true) {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

fn next_unique_cell_seq(rows: &[TableRow]) -> usize {
    let mut max_seq = 0usize;
    let mut total_cells = 0usize;
    for row in rows {
        for cell in &row.cells {
            total_cells += 1;
            if let Some(suffix) = cell.id.rsplit("-cell-").next() {
                if let Ok(n) = suffix.parse::<usize>() {
                    max_seq = max_seq.max(n + 1);
                }
            }
        }
    }
    max_seq.max(total_cells + 1)
}

fn convert_block_in_place(block: &mut Block, target: BlockConvertTarget) -> Result<(), IrError> {
    if let BlockConvertTarget::List { ordered, checklist } = target {
        if let BlockKind::List {
            ordered: cur_ordered,
            items,
            ..
        } = &mut block.kind
        {
            *cur_ordered = ordered;
            for item in items.iter_mut() {
                item.checked = if checklist {
                    Some(item.checked.unwrap_or(false))
                } else {
                    None
                };
            }
            return Ok(());
        }
    }

    let (runs, align, indent) = match &block.kind {
        BlockKind::Paragraph {
            runs,
            align,
            indent_level,
        } => (runs.clone(), *align, *indent_level),
        BlockKind::Heading { runs, align, .. } => (runs.clone(), *align, 0),
        BlockKind::BlockQuote { blocks } => {
            let mut extracted = Vec::new();
            let mut first_align = TextAlign::Left;
            for (idx, b) in blocks.iter().enumerate() {
                match &b.kind {
                    BlockKind::Paragraph { runs, align, .. }
                    | BlockKind::Heading { runs, align, .. } => {
                        if idx == 0 {
                            first_align = *align;
                        } else if !extracted.is_empty() {
                            extracted.push(InlineRun::plain(" "));
                        }
                        extracted.extend(runs.iter().cloned());
                    }
                    _ => {}
                }
            }
            (merge_adjacent_runs(extracted), first_align, 0)
        }
        BlockKind::CodeBlock { code, .. } => (
            if code.is_empty() {
                vec![]
            } else {
                vec![InlineRun::plain(code.clone())]
            },
            TextAlign::Left,
            0,
        ),
        BlockKind::List { items, .. } => {
            let mut combined = Vec::new();
            for (idx, item) in items.iter().enumerate() {
                if idx > 0 && !combined.is_empty() {
                    combined.push(InlineRun::plain("\n"));
                }
                combined.extend(item.runs.iter().cloned());
            }
            (merge_adjacent_runs(combined), TextAlign::Left, 0)
        }
        _ => return Err(IrError::IncompatibleBlockKind),
    };

    let block_id = block.id.clone();
    block.kind = match target {
        BlockConvertTarget::Paragraph => BlockKind::Paragraph {
            runs,
            align,
            indent_level: indent,
        },
        BlockConvertTarget::Heading { level } => BlockKind::Heading { level, runs, align },
        BlockConvertTarget::BlockQuote => BlockKind::BlockQuote {
            blocks: vec![Block {
                id: format!("{block_id}-q0"),
                kind: BlockKind::Paragraph {
                    runs,
                    align,
                    indent_level: 0,
                },
            }],
        },
        BlockConvertTarget::CodeBlock => BlockKind::CodeBlock {
            language: None,
            code: runs_plain_text(&runs),
        },
        BlockConvertTarget::List { ordered, checklist } => BlockKind::List {
            ordered,
            start: 1,
            items: vec![ListItem {
                id: format!("{block_id}-li0"),
                checked: if checklist { Some(false) } else { None },
                runs,
                children: vec![],
            }],
        },
    };
    Ok(())
}

/// Finds non-overlapping byte-range matches `(start_byte, end_byte)` in `input`.
fn find_match_byte_ranges(input: &str, find: &str, case_sensitive: bool) -> Vec<(usize, usize)> {
    if find.is_empty() || input.is_empty() {
        return Vec::new();
    }
    if case_sensitive {
        return input
            .match_indices(find)
            .map(|(start, slice)| (start, start + slice.len()))
            .collect();
    }

    let find_chars: Vec<char> = find.chars().flat_map(char::to_lowercase).collect();
    if find_chars.is_empty() {
        return Vec::new();
    }

    let orig_chars: Vec<(usize, char)> = input.char_indices().collect();
    let mut lower_chars: Vec<(usize, usize, char)> = Vec::with_capacity(orig_chars.len());
    for (idx, &(byte_start, ch)) in orig_chars.iter().enumerate() {
        let byte_end = if idx + 1 < orig_chars.len() {
            orig_chars[idx + 1].0
        } else {
            input.len()
        };
        for lc in ch.to_lowercase() {
            lower_chars.push((byte_start, byte_end, lc));
        }
    }

    let mut ranges = Vec::new();
    let mut last_byte = 0usize;
    let mut i = 0usize;
    while i + find_chars.len() <= lower_chars.len() {
        let matched = lower_chars[i..i + find_chars.len()]
            .iter()
            .zip(find_chars.iter())
            .all(|((_, _, c), f)| c == f);
        if matched {
            let match_start = lower_chars[i].0;
            let match_end = lower_chars[i + find_chars.len() - 1].1;
            if match_start >= last_byte {
                ranges.push((match_start, match_end));
                last_byte = match_end;
            }
            i += find_chars.len();
        } else {
            i += 1;
        }
    }
    ranges
}

fn replace_in_string(input: &str, find: &str, replace: &str, case_sensitive: bool) -> String {
    let ranges = find_match_byte_ranges(input, find, case_sensitive);
    if ranges.is_empty() {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let mut last = 0usize;
    for (start, end) in ranges {
        out.push_str(&input[last..start]);
        out.push_str(replace);
        last = end;
    }
    out.push_str(&input[last..]);
    out
}

/// Replaces matches across run boundaries, preserving the style of the run at each match start.
fn replace_in_runs(runs: &mut Vec<InlineRun>, find: &str, replace: &str, case_sensitive: bool) {
    let combined = runs_plain_text(runs);
    let ranges = find_match_byte_ranges(&combined, find, case_sensitive);
    if ranges.is_empty() {
        return;
    }

    // Precompute byte spans for each existing run inside `combined`.
    let mut spans: Vec<(usize, usize, TextStyle)> = Vec::with_capacity(runs.len());
    let mut offset = 0usize;
    for run in runs.iter() {
        let end = offset + run.text.len();
        spans.push((offset, end, run.style.clone()));
        offset = end;
    }

    let style_at = |byte_pos: usize| -> TextStyle {
        for (s, e, st) in &spans {
            if byte_pos >= *s && byte_pos < *e {
                return st.clone();
            }
        }
        TextStyle::default()
    };

    let push_slice = |from: usize, to: usize, dest: &mut Vec<InlineRun>| {
        if from >= to {
            return;
        }
        for (s, e, st) in &spans {
            let ov_start = from.max(*s);
            let ov_end = to.min(*e);
            if ov_start < ov_end {
                dest.push(InlineRun::styled(&combined[ov_start..ov_end], st.clone()));
            }
        }
    };

    let mut next_runs: Vec<InlineRun> = Vec::with_capacity(runs.len() + ranges.len());
    let mut cursor = 0usize;
    for (m_start, m_end) in ranges {
        push_slice(cursor, m_start, &mut next_runs);
        if !replace.is_empty() {
            next_runs.push(InlineRun::styled(replace, style_at(m_start)));
        }
        cursor = m_end;
    }
    push_slice(cursor, combined.len(), &mut next_runs);
    *runs = merge_adjacent_runs(next_runs);
}

fn replace_in_block(block: &mut Block, find: &str, replace: &str, case_sensitive: bool) {
    match &mut block.kind {
        BlockKind::Heading { runs, .. } | BlockKind::Paragraph { runs, .. } => {
            replace_in_runs(runs, find, replace, case_sensitive);
        }
        BlockKind::List { items, .. } => {
            for item in items {
                replace_in_runs(&mut item.runs, find, replace, case_sensitive);
                for child in &mut item.children {
                    replace_in_block(child, find, replace, case_sensitive);
                }
            }
        }
        BlockKind::Table { rows } => {
            for row in rows {
                for cell in &mut row.cells {
                    for b in &mut cell.blocks {
                        replace_in_block(b, find, replace, case_sensitive);
                    }
                }
            }
        }
        BlockKind::BlockQuote { blocks } | BlockKind::Footnote { blocks, .. } => {
            for b in blocks {
                replace_in_block(b, find, replace, case_sensitive);
            }
        }
        BlockKind::CodeBlock { code, .. } => {
            *code = replace_in_string(code, find, replace, case_sensitive);
        }
        BlockKind::Image { .. } | BlockKind::HorizontalRule | BlockKind::PageBreak => {}
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
    use std::collections::HashSet;

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

    #[test]
    fn editor_formatting_conversion_table_list_and_replace_ops() {
        let mut doc = DocumentIr::new(DocumentFormat::Docx, Some("Draft".into()));
        doc.blocks.push(Block {
            id: "p1".into(),
            kind: BlockKind::Paragraph {
                runs: vec![
                    InlineRun::plain("Hello "),
                    InlineRun::styled(
                        "World",
                        TextStyle {
                            bold: true,
                            ..Default::default()
                        },
                    ),
                    InlineRun::plain(" hello"),
                ],
                align: TextAlign::Left,
                indent_level: 0,
            },
        });
        doc.finalize();

        // Cross-run boundary replacement ("Hello World" spans plain + bold runs)
        doc.apply_edit(EditOperation::ReplaceAllText {
            find: "hello world".into(),
            replace: "Orb Studio".into(),
            case_sensitive: false,
        })
        .unwrap();
        assert_eq!(doc.plain_text(), "Orb Studio hello");

        doc.apply_edit(EditOperation::SetBlockAlign {
            block_id: "p1".into(),
            align: TextAlign::Center,
        })
        .unwrap();
        doc.apply_edit(EditOperation::SetBlockIndent {
            block_id: "p1".into(),
            indent_level: 2,
        })
        .unwrap();
        match &doc.blocks[0].kind {
            BlockKind::Paragraph {
                align,
                indent_level,
                ..
            } => {
                assert_eq!(*align, TextAlign::Center);
                assert_eq!(*indent_level, 2);
            }
            _ => panic!("expected paragraph"),
        }

        doc.apply_edit(EditOperation::ConvertBlockKind {
            block_id: "p1".into(),
            target: BlockConvertTarget::Heading { level: 2 },
        })
        .unwrap();
        assert_eq!(doc.outline.len(), 1);
        assert_eq!(doc.outline[0].level, 2);

        doc.apply_edit(EditOperation::ConvertBlockKind {
            block_id: "p1".into(),
            target: BlockConvertTarget::List {
                ordered: false,
                checklist: true,
            },
        })
        .unwrap();
        doc.apply_edit(EditOperation::AddListItem {
            block_id: "p1".into(),
            after_index: Some(0),
            item: ListItem {
                id: "li-2".into(),
                checked: Some(true),
                runs: vec![InlineRun::plain("Second task")],
                children: vec![],
            },
        })
        .unwrap();
        match &doc.blocks[0].kind {
            BlockKind::List { items, .. } => {
                assert_eq!(items.len(), 2);
                assert_eq!(items[0].checked, Some(false));
                assert_eq!(items[1].checked, Some(true));
            }
            _ => panic!("expected list"),
        }

        // Table row/col mutations must generate unique, non-colliding cell IDs across delete+add
        doc.apply_edit(EditOperation::InsertBlockAfter {
            after_block_id: Some("p1".into()),
            block: Block {
                id: "t1".into(),
                kind: BlockKind::Table {
                    rows: vec![TableRow {
                        header: true,
                        cells: vec![
                            TableCell {
                                id: "c0".into(),
                                col_span: 1,
                                row_span: 1,
                                align: TextAlign::Left,
                                blocks: vec![],
                            },
                            TableCell {
                                id: "c1".into(),
                                col_span: 1,
                                row_span: 1,
                                align: TextAlign::Left,
                                blocks: vec![],
                            },
                        ],
                    }],
                },
            },
        })
        .unwrap();
        doc.apply_edit(EditOperation::AddTableRow {
            block_id: "t1".into(),
            after_row: Some(0),
        })
        .unwrap();
        doc.apply_edit(EditOperation::AddTableRow {
            block_id: "t1".into(),
            after_row: Some(1),
        })
        .unwrap();
        doc.apply_edit(EditOperation::DeleteTableRow {
            block_id: "t1".into(),
            row: 1,
        })
        .unwrap();
        doc.apply_edit(EditOperation::AddTableRow {
            block_id: "t1".into(),
            after_row: Some(1),
        })
        .unwrap();
        doc.apply_edit(EditOperation::AddTableColumn {
            block_id: "t1".into(),
            after_col: None,
        })
        .unwrap();
        match &doc.blocks[1].kind {
            BlockKind::Table { rows } => {
                assert_eq!(rows.len(), 3);
                assert_eq!(rows[0].cells.len(), 3);
                let mut seen = HashSet::new();
                for r in rows {
                    for c in &r.cells {
                        assert!(seen.insert(c.id.clone()), "duplicate cell id: {}", c.id);
                    }
                }
            }
            _ => panic!("expected table"),
        }

        doc.apply_edit(EditOperation::DeleteTableColumn {
            block_id: "t1".into(),
            col: 2,
        })
        .unwrap();
        doc.apply_edit(EditOperation::DeleteTableRow {
            block_id: "t1".into(),
            row: 1,
        })
        .unwrap();
        match &doc.blocks[1].kind {
            BlockKind::Table { rows } => {
                assert_eq!(rows.len(), 2);
                assert_eq!(rows[0].cells.len(), 2);
            }
            _ => panic!("expected table"),
        }

        doc.apply_edit(EditOperation::AddAsset {
            asset: MediaAsset {
                id: "img-1".into(),
                mime_type: "image/png".into(),
                data_base64: "AAAA".into(),
                filename: Some("test.png".into()),
            },
        })
        .unwrap();
        assert_eq!(doc.assets.len(), 1);
    }
}
