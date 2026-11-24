pub mod fixture;

use std::collections::HashMap;
use std::io::{Cursor, Read};

use cfb::CompoundFile;
use orb_ir::{
    Block, BlockKind, DiagnosticSeverity, DocumentFormat, DocumentIr, InlineRun, ListItem,
    TableCell, TableRow, TextAlign, TextStyle, merge_adjacent_runs,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DocError {
    #[error("not a valid OLE2 Compound File Binary (.doc): {0}")]
    InvalidContainer(String),
    #[error("missing WordDocument stream inside OLE2 container")]
    MissingWordStream,
    #[error("missing Word table stream ({0})")]
    MissingTableStream(&'static str),
    #[error("corrupted or truncated Word binary FIB header")]
    InvalidFib,
    #[error("document is password-encrypted; encrypted legacy .doc files cannot be opened")]
    EncryptedDocument,
    #[error("document appears to be RTF saved with a .doc extension")]
    MisnamedRtf,
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
struct Piece {
    cp_start: u32,
    cp_end: u32,
    byte_offset: usize,
    compressed: bool,
}

#[derive(Debug, Clone, Default)]
struct ChpxRun {
    fc_start: u32,
    fc_end: u32,
    style: TextStyle,
}

#[derive(Debug, Clone, Default)]
struct PapxRun {
    fc_start: u32,
    fc_end: u32,
    istd: u16,
    align: TextAlign,
    outline_lvl: Option<u8>,
    in_table: bool,
    is_list: bool,
}

pub fn parse_doc(bytes: &[u8], filename: Option<&str>) -> Result<DocumentIr, DocError> {
    if bytes.starts_with(b"{\\rtf") {
        return Err(DocError::MisnamedRtf);
    }

    let mut comp = CompoundFile::open(Cursor::new(bytes))
        .map_err(|e| DocError::InvalidContainer(e.to_string()))?;

    let word_stream = read_stream(&mut comp, "/WordDocument")
        .or_else(|_| read_stream(&mut comp, "WordDocument"))
        .map_err(|_| DocError::MissingWordStream)?;

    if word_stream.len() < 34 {
        return Err(DocError::InvalidFib);
    }

    let w_ident = read_u16(&word_stream, 0).ok_or(DocError::InvalidFib)?;
    let n_fib = read_u16(&word_stream, 2).ok_or(DocError::InvalidFib)?;
    let flags = read_u16(&word_stream, 10).ok_or(DocError::InvalidFib)?;

    if w_ident != 0xA5EC && w_ident != 0xA5DC {
        return Err(DocError::InvalidFib);
    }
    if (flags & 0x0100) != 0 {
        return Err(DocError::EncryptedDocument);
    }

    let fallback_title = filename.map(|f| {
        f.rsplit_once('.')
            .map(|(stem, _)| stem.to_string())
            .unwrap_or_else(|| f.to_string())
    });
    let mut doc = DocumentIr::new(DocumentFormat::Doc, None);

    if n_fib < 0x00C1 {
        doc.add_diagnostic(
            DiagnosticSeverity::Warning,
            "DOC_PRE_97_FORMAT",
            format!("Legacy pre-Word 97 binary format detected (nFib=0x{n_fib:04X}); attempting text recovery."),
        );
    }

    // Parse OLE2 SummaryInformation if present
    if let Ok(summary_bytes) = read_stream(&mut comp, "/\x05SummaryInformation")
        .or_else(|_| read_stream(&mut comp, "\x05SummaryInformation"))
    {
        parse_summary_info(&summary_bytes, &mut doc);
    }

    let table_name = if (flags & 0x0200) != 0 {
        "1Table"
    } else {
        "0Table"
    };
    let table_stream = read_stream(&mut comp, &format!("/{table_name}"))
        .or_else(|_| read_stream(&mut comp, table_name))
        .map_err(|_| DocError::MissingTableStream(table_name))?;

    // Navigate FIB sections: FibBase (32) -> csw -> FibRgW -> cslw -> FibRgLw -> cbRgFcLcb -> FibRgFcLcb
    let csw = usize::from(read_u16(&word_stream, 32).ok_or(DocError::InvalidFib)?);
    let cslw_off = 34 + csw * 2;
    let cslw = usize::from(read_u16(&word_stream, cslw_off).ok_or(DocError::InvalidFib)?);
    let fibrglw_off = cslw_off + 2;
    let ccp_text = read_u32(&word_stream, fibrglw_off + 12).unwrap_or(0);

    let cbfclcb_off = fibrglw_off + cslw * 4;
    let cb_rg_fc_lcb = usize::from(read_u16(&word_stream, cbfclcb_off).ok_or(DocError::InvalidFib)?);
    let fc_lcb_base = cbfclcb_off + 2;

    let read_fc_lcb = |index: usize| -> (usize, usize) {
        if index >= cb_rg_fc_lcb {
            return (0, 0);
        }
        let off = fc_lcb_base + index * 8;
        let fc = read_u32(&word_stream, off).unwrap_or(0) as usize;
        let lcb = read_u32(&word_stream, off + 4).unwrap_or(0) as usize;
        (fc, lcb)
    };

    let (fc_stshf, lcb_stshf) = read_fc_lcb(1);
    let (fc_chpx_bte, lcb_chpx_bte) = read_fc_lcb(12);
    let (fc_papx_bte, lcb_papx_bte) = read_fc_lcb(13);
    let (fc_clx, lcb_clx) = read_fc_lcb(33);

    let style_headings = parse_stsh_headings(&table_stream, fc_stshf, lcb_stshf);
    let chpx_runs = parse_chpx_table(&word_stream, &table_stream, fc_chpx_bte, lcb_chpx_bte);
    let papx_runs = parse_papx_table(&word_stream, &table_stream, fc_papx_bte, lcb_papx_bte);

    let pieces = parse_clx_pieces(&table_stream, fc_clx, lcb_clx);
    if pieces.is_empty() {
        doc.add_diagnostic(
            DiagnosticSeverity::Warning,
            "DOC_EMPTY_PIECE_TABLE",
            "No complex piece table found; text body could not be decoded.",
        );
    }

    // Reconstruct main document characters along with their source FC byte offset in WordDocument
    let limit_cp = if ccp_text > 0 {
        ccp_text
    } else {
        pieces.last().map(|p| p.cp_end).unwrap_or(0)
    };

    let mut chars_with_fc: Vec<(char, u32)> = Vec::new();
    for piece in &pieces {
        if piece.cp_start >= limit_cp {
            break;
        }
        let effective_end = piece.cp_end.min(limit_cp);
        let count = effective_end.saturating_sub(piece.cp_start) as usize;
        if piece.compressed {
            for i in 0..count {
                let off = piece.byte_offset + i;
                if let Some(&b) = word_stream.get(off) {
                    let fc = (off * 2) as u32 | 0x4000_0000;
                    let raw_fc = off as u32;
                    let ch = decode_cp1252(b);
                    // Word FKPs compare against compressed FC (byte_offset * 2 | 0x40000000) or raw byte offset
                    chars_with_fc.push((ch, select_matching_fc(raw_fc, fc, &chpx_runs, &papx_runs)));
                }
            }
        } else {
            for i in 0..count {
                let off = piece.byte_offset + i * 2;
                if let Some(code_unit) = read_u16(&word_stream, off) {
                    let ch = char::from_u32(u32::from(code_unit)).unwrap_or('\u{FFFD}');
                    chars_with_fc.push((ch, off as u32));
                }
            }
        }
    }

    doc.blocks = build_blocks_from_stream(&chars_with_fc, &chpx_runs, &papx_runs, &style_headings);
    doc.add_diagnostic(
        DiagnosticSeverity::Info,
        "DOC_LEGACY_BINARY",
        "Parsed legacy Word 97-2003 binary (.doc) via pure-Rust OLE2/MS-DOC decoder. Export to .docx or .md for long-term archival.",
    );

    if doc.title.is_none() {
        doc.title = fallback_title;
    }
    doc.finalize();
    Ok(doc)
}

fn select_matching_fc(
    raw_fc: u32,
    compressed_fc: u32,
    chpx: &[ChpxRun],
    papx: &[PapxRun],
) -> u32 {
    if papx
        .iter()
        .any(|r| compressed_fc >= r.fc_start && compressed_fc < r.fc_end)
        || chpx
            .iter()
            .any(|r| compressed_fc >= r.fc_start && compressed_fc < r.fc_end)
    {
        compressed_fc
    } else {
        raw_fc
    }
}

fn read_stream(comp: &mut CompoundFile<Cursor<&[u8]>>, name: &str) -> Result<Vec<u8>, std::io::Error> {
    let mut stream = comp.open_stream(name)?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf)?;
    Ok(buf)
}

fn read_u16(buf: &[u8], off: usize) -> Option<u16> {
    let slice = buf.get(off..off + 2)?;
    Some(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32(buf: &[u8], off: usize) -> Option<u32> {
    let slice = buf.get(off..off + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn parse_clx_pieces(table: &[u8], fc_clx: usize, lcb_clx: usize) -> Vec<Piece> {
    if lcb_clx == 0 || fc_clx + lcb_clx > table.len() {
        return Vec::new();
    }
    let clx = &table[fc_clx..fc_clx + lcb_clx];
    let mut pos = 0;

    // Skip zero or more Prc (0x01) records
    while pos < clx.len() && clx[pos] == 0x01 {
        if pos + 3 > clx.len() {
            return Vec::new();
        }
        let cb = usize::from(u16::from_le_bytes([clx[pos + 1], clx[pos + 2]]));
        pos += 3 + cb;
    }

    // Expect Pcdt (0x02)
    if pos + 5 > clx.len() || clx[pos] != 0x02 {
        return Vec::new();
    }
    let lcb = u32::from_le_bytes([clx[pos + 1], clx[pos + 2], clx[pos + 3], clx[pos + 4]]) as usize;
    pos += 5;

    if lcb < 4 || pos + lcb > clx.len() {
        return Vec::new();
    }
    let plc = &clx[pos..pos + lcb];
    let n = (lcb - 4) / 12;
    let pcd_base = (n + 1) * 4;

    let mut pieces = Vec::with_capacity(n);
    for i in 0..n {
        let Some(cp_start) = read_u32(plc, i * 4) else {
            break;
        };
        let Some(cp_end) = read_u32(plc, (i + 1) * 4) else {
            break;
        };
        let Some(fc_raw) = read_u32(plc, pcd_base + i * 8 + 2) else {
            break;
        };
        let compressed = (fc_raw & 0x4000_0000) != 0;
        let masked = (fc_raw & 0x3FFF_FFFF) as usize;
        let byte_offset = if compressed { masked / 2 } else { masked };
        pieces.push(Piece {
            cp_start,
            cp_end,
            byte_offset,
            compressed,
        });
    }
    pieces
}

fn parse_chpx_table(word: &[u8], table: &[u8], fc_bte: usize, lcb_bte: usize) -> Vec<ChpxRun> {
    let mut runs = Vec::new();
    if lcb_bte < 12 || fc_bte + lcb_bte > table.len() {
        return runs;
    }
    let bte = &table[fc_bte..fc_bte + lcb_bte];
    let count = (lcb_bte - 4) / 8;
    let pn_base = (count + 1) * 4;

    for i in 0..count {
        let Some(pn_raw) = read_u32(bte, pn_base + i * 4) else {
            continue;
        };
        let pn = (pn_raw & 0x003F_FFFF) as usize;
        let page_off = pn * 512;
        if page_off + 512 > word.len() {
            continue;
        }
        let page = &word[page_off..page_off + 512];
        let crun = usize::from(page[511]);
        let rgb_base = (crun + 1) * 4;
        if rgb_base + crun > 511 {
            continue;
        }
        for r in 0..crun {
            let Some(fc_start) = read_u32(page, r * 4) else {
                continue;
            };
            let Some(fc_end) = read_u32(page, (r + 1) * 4) else {
                continue;
            };
            let b_off = usize::from(page[rgb_base + r]);
            let mut style = TextStyle::default();
            if b_off > 0 {
                let off = b_off * 2;
                if off < 511 {
                    let cb = usize::from(page[off]);
                    if off + 1 + cb <= 511 {
                        apply_chpx_grpprl(&page[off + 1..off + 1 + cb], &mut style);
                    }
                }
            }
            runs.push(ChpxRun {
                fc_start,
                fc_end,
                style,
            });
        }
    }
    runs
}

fn parse_papx_table(word: &[u8], table: &[u8], fc_bte: usize, lcb_bte: usize) -> Vec<PapxRun> {
    let mut runs = Vec::new();
    if lcb_bte < 12 || fc_bte + lcb_bte > table.len() {
        return runs;
    }
    let bte = &table[fc_bte..fc_bte + lcb_bte];
    let count = (lcb_bte - 4) / 8;
    let pn_base = (count + 1) * 4;

    for i in 0..count {
        let Some(pn_raw) = read_u32(bte, pn_base + i * 4) else {
            continue;
        };
        let pn = (pn_raw & 0x003F_FFFF) as usize;
        let page_off = pn * 512;
        if page_off + 512 > word.len() {
            continue;
        }
        let page = &word[page_off..page_off + 512];
        let crun = usize::from(page[511]);
        let bx_base = (crun + 1) * 4;
        if bx_base + crun * 13 > 511 {
            continue;
        }
        for r in 0..crun {
            let Some(fc_start) = read_u32(page, r * 4) else {
                continue;
            };
            let Some(fc_end) = read_u32(page, (r + 1) * 4) else {
                continue;
            };
            let b_off = usize::from(page[bx_base + r * 13]);
            let mut pap = PapxRun {
                fc_start,
                fc_end,
                ..Default::default()
            };
            if b_off > 0 {
                let off = b_off * 2;
                if off + 2 < 511 {
                    let cb = usize::from(page[off]);
                    let (payload_start, payload_len) = if cb == 0 {
                        (off + 2, usize::from(page[off + 1]) * 2)
                    } else {
                        (off + 1, cb * 2 - 1)
                    };
                    if payload_len >= 2 && payload_start + payload_len <= 512 {
                        pap.istd = u16::from_le_bytes([
                            page[payload_start],
                            page[payload_start + 1],
                        ]);
                        apply_papx_grpprl(
                            &page[payload_start + 2..payload_start + payload_len],
                            &mut pap,
                        );
                    }
                }
            }
            runs.push(pap);
        }
    }
    runs
}

fn sprm_operand_len(sprm: u16, rest: &[u8]) -> usize {
    let spra = (sprm >> 13) & 0x7;
    match spra {
        0 | 1 => 1,
        2 | 4 | 5 => 2,
        3 => 4,
        7 => 3,
        6 => {
            if sprm == 0xD608 {
                if rest.len() >= 2 {
                    usize::from(u16::from_le_bytes([rest[0], rest[1]])) + 1
                } else {
                    rest.len()
                }
            } else if let Some(&len) = rest.first() {
                1 + usize::from(len)
            } else {
                0
            }
        }
        _ => 1,
    }
}

fn apply_chpx_grpprl(grpprl: &[u8], style: &mut TextStyle) {
    let mut pos = 0;
    while pos + 2 <= grpprl.len() {
        let sprm = u16::from_le_bytes([grpprl[pos], grpprl[pos + 1]]);
        pos += 2;
        let op_len = sprm_operand_len(sprm, &grpprl[pos..]);
        if pos + op_len > grpprl.len() {
            break;
        }
        let op = &grpprl[pos..pos + op_len];
        match sprm {
            0x0835 => style.bold = op[0] != 0,
            0x0836 => style.italic = op[0] != 0,
            0x0837 => style.strikethrough = op[0] != 0,
            0x2A3E => style.underline = op[0] != 0,
            0x2A48 => {
                style.superscript = op[0] == 1;
                style.subscript = op[0] == 2;
            }
            0x4A43 if op.len() >= 2 => {
                let half_pt = u16::from_le_bytes([op[0], op[1]]);
                if half_pt > 0 {
                    style.font_size_pt = Some(f32::from(half_pt) / 2.0);
                }
            }
            _ => {}
        }
        pos += op_len;
    }
}

fn apply_papx_grpprl(grpprl: &[u8], pap: &mut PapxRun) {
    let mut pos = 0;
    while pos + 2 <= grpprl.len() {
        let sprm = u16::from_le_bytes([grpprl[pos], grpprl[pos + 1]]);
        pos += 2;
        let op_len = sprm_operand_len(sprm, &grpprl[pos..]);
        if pos + op_len > grpprl.len() {
            break;
        }
        let op = &grpprl[pos..pos + op_len];
        match sprm {
            0x2403 | 0x2461 => {
                pap.align = match op[0] {
                    1 => TextAlign::Center,
                    2 => TextAlign::Right,
                    3 => TextAlign::Justify,
                    _ => TextAlign::Left,
                };
            }
            0x2416 => pap.in_table = op[0] != 0,
            0x2640 => {
                if op[0] < 6 {
                    pap.outline_lvl = Some(op[0] + 1);
                }
            }
            0x460B if op.len() >= 2 => {
                let ilfo = u16::from_le_bytes([op[0], op[1]]);
                pap.is_list = ilfo > 0;
            }
            _ => {}
        }
        pos += op_len;
    }
}

fn parse_stsh_headings(table: &[u8], fc_stshf: usize, lcb_stshf: usize) -> HashMap<u16, u8> {
    let mut map = HashMap::new();
    // Standard built-in Word istd indices: 1..=6 are Heading 1..6
    for lvl in 1u16..=6 {
        map.insert(lvl, lvl as u8);
    }
    if lcb_stshf < 20 || fc_stshf + lcb_stshf > table.len() {
        return map;
    }
    let stsh = &table[fc_stshf..fc_stshf + lcb_stshf];
    let Some(cb_stshi) = read_u16(stsh, 0) else {
        return map;
    };
    let stshi_len = usize::from(cb_stshi);
    if 2 + stshi_len > stsh.len() || stshi_len < 4 {
        return map;
    }
    let cstd = usize::from(read_u16(stsh, 2).unwrap_or(0));
    let cb_std_base = usize::from(read_u16(stsh, 4).unwrap_or(10));
    let mut pos = 2 + stshi_len;

    for istd in 0..cstd {
        let Some(cb_std) = read_u16(stsh, pos) else {
            break;
        };
        pos += 2;
        let len = usize::from(cb_std);
        if pos + len > stsh.len() {
            break;
        }
        if len > cb_std_base + 2 {
            let std_slice = &stsh[pos..pos + len];
            if let Some(cch) = read_u16(std_slice, cb_std_base) {
                let name_bytes_start = cb_std_base + 2;
                let name_bytes_end = name_bytes_start + usize::from(cch) * 2;
                if name_bytes_end <= std_slice.len() {
                    let units: Vec<u16> = std_slice[name_bytes_start..name_bytes_end]
                        .chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect();
                    let name = String::from_utf16_lossy(&units).to_ascii_lowercase();
                    if name == "title" {
                        map.insert(istd as u16, 1);
                    } else if let Some(rest) = name.strip_prefix("heading ") {
                        if let Ok(lvl) = rest.trim().parse::<u8>() {
                            if (1..=6).contains(&lvl) {
                                map.insert(istd as u16, lvl);
                            }
                        }
                    }
                }
            }
        }
        pos += len;
        if len % 2 == 1 && pos < stsh.len() {
            // STD entries are 2-byte aligned in some versions; only skip if needed
        }
    }
    map
}

fn find_chpx_style(fc: u32, chpx_runs: &[ChpxRun]) -> TextStyle {
    for r in chpx_runs {
        if fc >= r.fc_start && fc < r.fc_end {
            return r.style.clone();
        }
    }
    TextStyle::default()
}

fn find_papx(fc: u32, papx_runs: &[PapxRun]) -> Option<&PapxRun> {
    papx_runs.iter().find(|r| fc >= r.fc_start && fc < r.fc_end)
}

fn build_blocks_from_stream(
    chars: &[(char, u32)],
    chpx_runs: &[ChpxRun],
    papx_runs: &[PapxRun],
    style_headings: &HashMap<u16, u8>,
) -> Vec<Block> {
    let mut blocks: Vec<Block> = Vec::new();
    let mut next_id: usize = 1;
    let mut alloc = |prefix: &str| {
        let id = format!("{prefix}-{next_id}");
        next_id += 1;
        id
    };

    let mut cur_runs: Vec<InlineRun> = Vec::new();
    let mut para_first_fc: Option<u32> = None;

    // Field parsing state (0x13 begin, 0x14 separator, 0x15 end)
    let mut field_depth: usize = 0;
    let mut in_field_code = false;
    let mut field_code_buf = String::new();
    let mut active_hyperlink: Option<String> = None;

    // Pending table accumulation
    let mut pending_table_rows: Vec<TableRow> = Vec::new();
    let mut cur_table_cells: Vec<TableCell> = Vec::new();
    let mut pending_list_items: Vec<ListItem> = Vec::new();

    let flush_list = |items: &mut Vec<ListItem>, blocks: &mut Vec<Block>, alloc: &mut dyn FnMut(&str) -> String| {
        if !items.is_empty() {
            let id = alloc("list");
            blocks.push(Block {
                id,
                kind: BlockKind::List {
                    ordered: false,
                    start: 1,
                    items: std::mem::take(items),
                },
            });
        }
    };

    let flush_table = |rows: &mut Vec<TableRow>, blocks: &mut Vec<Block>, alloc: &mut dyn FnMut(&str) -> String| {
        if !rows.is_empty() {
            if rows.len() > 1 {
                rows[0].header = true;
            }
            let id = alloc("tbl");
            blocks.push(Block {
                id,
                kind: BlockKind::Table {
                    rows: std::mem::take(rows),
                },
            });
        }
    };

    for &(ch, fc) in chars {
        match ch {
            '\u{0013}' => {
                field_depth += 1;
                in_field_code = true;
                field_code_buf.clear();
            }
            '\u{0014}' => {
                in_field_code = false;
                if let Some(url) = extract_hyperlink_url(&field_code_buf) {
                    active_hyperlink = Some(url);
                }
            }
            '\u{0015}' => {
                field_depth = field_depth.saturating_sub(1);
                in_field_code = false;
                active_hyperlink = None;
                field_code_buf.clear();
            }
            '\u{0007}' => {
                // Cell terminator or row terminator in MS-DOC tables
                let merged = merge_adjacent_runs(std::mem::take(&mut cur_runs));
                para_first_fc = None;
                if merged.is_empty() && !cur_table_cells.is_empty() {
                    pending_table_rows.push(TableRow {
                        header: false,
                        cells: std::mem::take(&mut cur_table_cells),
                    });
                } else {
                    flush_list(&mut pending_list_items, &mut blocks, &mut alloc);
                    let cell_id = alloc("cell");
                    let p_id = format!("{cell_id}-p0");
                    cur_table_cells.push(TableCell {
                        id: cell_id,
                        col_span: 1,
                        row_span: 1,
                        align: TextAlign::Left,
                        blocks: vec![Block {
                            id: p_id,
                            kind: BlockKind::Paragraph {
                                runs: merged,
                                align: TextAlign::Left,
                                indent_level: 0,
                            },
                        }],
                    });
                }
            }
            '\u{000C}' => {
                flush_list(&mut pending_list_items, &mut blocks, &mut alloc);
                flush_table(&mut pending_table_rows, &mut blocks, &mut alloc);
                let id = alloc("pb");
                blocks.push(Block {
                    id,
                    kind: BlockKind::PageBreak,
                });
            }
            '\r' => {
                if !cur_table_cells.is_empty() {
                    pending_table_rows.push(TableRow {
                        header: false,
                        cells: std::mem::take(&mut cur_table_cells),
                    });
                }
                let merged = merge_adjacent_runs(std::mem::take(&mut cur_runs));
                let pap = para_first_fc.and_then(|pfc| find_papx(pfc, papx_runs));
                para_first_fc = None;

                if merged.is_empty() {
                    continue;
                }

                flush_table(&mut pending_table_rows, &mut blocks, &mut alloc);

                if pap.map(|p| p.is_list).unwrap_or(false) {
                    pending_list_items.push(ListItem {
                        id: alloc("li"),
                        checked: None,
                        runs: merged,
                        children: Vec::new(),
                    });
                    continue;
                }

                flush_list(&mut pending_list_items, &mut blocks, &mut alloc);

                let heading_level = pap.and_then(|p| {
                    p.outline_lvl
                        .or_else(|| style_headings.get(&p.istd).copied())
                });
                let align = pap.map(|p| p.align).unwrap_or(TextAlign::Left);

                if let Some(level) = heading_level {
                    let id = alloc("h");
                    blocks.push(Block {
                        id,
                        kind: BlockKind::Heading {
                            level,
                            runs: merged,
                            align,
                        },
                    });
                } else {
                    let id = alloc("p");
                    blocks.push(Block {
                        id,
                        kind: BlockKind::Paragraph {
                            runs: merged,
                            align,
                            indent_level: 0,
                        },
                    });
                }
            }
            '\u{000B}' => {
                // Soft line break inside paragraph
                cur_runs.push(InlineRun::plain("\n"));
            }
            '\u{0001}' | '\u{0008}' | '\u{0000}' | '\u{0002}' | '\u{0005}' => {
                // Inline picture/annotation/footnote placeholder markers — skip cleanly
            }
            c if c.is_control() && c != '\t' => {}
            c => {
                if in_field_code && field_depth > 0 {
                    field_code_buf.push(c);
                } else {
                    if para_first_fc.is_none() {
                        para_first_fc = Some(fc);
                    }
                    let mut style = find_chpx_style(fc, chpx_runs);
                    if active_hyperlink.is_some() {
                        style.href = active_hyperlink.clone();
                    }
                    cur_runs.push(InlineRun::styled(c.to_string(), style));
                }
            }
        }
    }

    if !cur_table_cells.is_empty() {
        pending_table_rows.push(TableRow {
            header: false,
            cells: cur_table_cells,
        });
    }
    flush_table(&mut pending_table_rows, &mut blocks, &mut alloc);
    flush_list(&mut pending_list_items, &mut blocks, &mut alloc);

    let trailing = merge_adjacent_runs(cur_runs);
    if !trailing.is_empty() {
        let id = alloc("p");
        blocks.push(Block {
            id,
            kind: BlockKind::Paragraph {
                runs: trailing,
                align: TextAlign::Left,
                indent_level: 0,
            },
        });
    }

    blocks
}

fn extract_hyperlink_url(code: &str) -> Option<String> {
    let trimmed = code.trim();
    let rest = trimmed
        .strip_prefix("HYPERLINK")
        .or_else(|| trimmed.strip_prefix("hyperlink"))?
        .trim();
    if let Some(quoted) = rest.strip_prefix('"') {
        quoted.split('"').next().map(|s| s.to_string())
    } else {
        rest.split_whitespace().next().map(|s| s.to_string())
    }
}

fn parse_summary_info(bytes: &[u8], doc: &mut DocumentIr) {
    // Minimal OLE2 PropertySetStream parser for PID_TITLE (2), PID_SUBJECT (3), PID_AUTHOR (4)
    if bytes.len() < 48 {
        return;
    }
    let Some(section_off) = read_u32(bytes, 44).map(|v| v as usize) else {
        return;
    };
    if section_off + 8 > bytes.len() {
        return;
    }
    let prop_count = read_u32(bytes, section_off + 4).unwrap_or(0) as usize;
    for i in 0..prop_count.min(64) {
        let entry_off = section_off + 8 + i * 8;
        let Some(pid) = read_u32(bytes, entry_off) else {
            break;
        };
        let Some(rel_off) = read_u32(bytes, entry_off + 4) else {
            break;
        };
        let val_off = section_off + rel_off as usize;
        if val_off + 8 > bytes.len() {
            continue;
        }
        let vt = read_u32(bytes, val_off).unwrap_or(0);
        // VT_LPSTR = 30
        if vt == 30 {
            let len = read_u32(bytes, val_off + 4).unwrap_or(0) as usize;
            if len > 0 && val_off + 8 + len <= bytes.len() {
                let raw = &bytes[val_off + 8..val_off + 8 + len];
                let trimmed = raw.split(|&b| b == 0).next().unwrap_or(raw);
                let text: String = trimmed.iter().map(|&b| decode_cp1252(b)).collect();
                let clean = text.trim();
                if !clean.is_empty() {
                    match pid {
                        2 => doc.title = Some(clean.to_string()),
                        3 => doc.metadata.subject = Some(clean.to_string()),
                        4 => doc.metadata.author = Some(clean.to_string()),
                        _ => {}
                    }
                }
            }
        }
    }
}

fn decode_cp1252(byte: u8) -> char {
    match byte {
        0x80 => '\u{20AC}',
        0x82 => '\u{201A}',
        0x83 => '\u{0192}',
        0x84 => '\u{201E}',
        0x85 => '\u{2026}',
        0x86 => '\u{2020}',
        0x87 => '\u{2021}',
        0x88 => '\u{02C6}',
        0x89 => '\u{2030}',
        0x8A => '\u{0160}',
        0x8B => '\u{2039}',
        0x8C => '\u{0152}',
        0x8E => '\u{017D}',
        0x91 => '\u{2018}',
        0x92 => '\u{2019}',
        0x93 => '\u{201C}',
        0x94 => '\u{201D}',
        0x95 => '\u{2022}',
        0x96 => '\u{2013}',
        0x97 => '\u{2014}',
        0x98 => '\u{02DC}',
        0x99 => '\u{2122}',
        0x9A => '\u{0161}',
        0x9B => '\u{203A}',
        0x9C => '\u{0153}',
        0x9E => '\u{017E}',
        0x9F => '\u{0178}',
        other => char::from(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_word97_binary_doc_fixture() {
        let doc_bytes = fixture::generate_sample_doc().expect("fixture generation failed");
        let parsed = parse_doc(&doc_bytes, Some("legacy_memo.doc")).expect("parse_doc failed");

        assert_eq!(parsed.source_format, DocumentFormat::Doc);
        assert_eq!(parsed.title.as_deref(), Some("Legacy Word 97-2003 Archival Memo"));
        assert_eq!(parsed.metadata.author.as_deref(), Some("Orb Archive Team"));
        assert!(!parsed.outline.is_empty());
        assert!(parsed.plain_text().contains("Word 97"));
        assert!(parsed.blocks.iter().any(|b| matches!(b.kind, BlockKind::Table { .. })));
    }

    #[test]
    fn detects_misnamed_rtf_files() {
        let rtf = b"{\\rtf1\\ansi Hello World}";
        let err = parse_doc(rtf, Some("fake.doc")).unwrap_err();
        assert!(matches!(err, DocError::MisnamedRtf));
    }
}
