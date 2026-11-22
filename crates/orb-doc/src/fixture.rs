use std::io::{Cursor, Write};

use cfb::CompoundFile;

/// Generates a spec-compliant Word 97-2003 OLE2/CFB binary `.doc` sample file
/// containing SummaryInformation, FIB, 1Table Clx piece table (UTF-16LE),
/// PAPX FKP (Heading 1/2 styles), CHPX FKP (bold/italic runs), and a table.
pub fn generate_sample_doc() -> Result<Vec<u8>, std::io::Error> {
    // Text starts at FC = 1024 (after a 1024-byte FIB header) in WordDocument stream.
    let text_start_fc: u32 = 1024;

    // Build structured main text with exact paragraph ranges
    let mut text = String::new();
    struct ParaSpec {
        start_char: usize,
        istd: u16,
    }
    fn push_para(text: &mut String, paras: &mut Vec<ParaSpec>, s: &str, istd: u16) -> usize {
        let start = text.encode_utf16().count();
        text.push_str(s);
        text.push('\r');
        paras.push(ParaSpec {
            start_char: start,
            istd,
        });
        start
    }

    let mut paras: Vec<ParaSpec> = Vec::new();
    push_para(&mut text, &mut paras, "Legacy Word 97-2003 Archival Memo", 1);

    let intro = "This binary .doc file is parsed natively in pure Rust (WebAssembly) directly from its OLE2 Compound File Binary container — zero external Word converter required.";
    let bold_start_offset = intro.find("pure Rust").unwrap_or(0);
    let bold_end_offset = bold_start_offset + "pure Rust (WebAssembly)".len();
    let intro_para_start = push_para(&mut text, &mut paras, intro, 0);

    push_para(&mut text, &mut paras, "Archival Compatibility Matrix", 2);
    // Table: three rows using \x07 cell and row delimiters
    let table_start = text.encode_utf16().count();
    text.push_str("Stream\u{0007}Purpose\u{0007}\u{0007}");
    text.push_str("WordDocument\u{0007}FIB header, UTF-16LE text, and 512-byte FKP property pages\u{0007}\u{0007}");
    text.push_str("1Table\u{0007}Complex piece table (Clx) and CHPX/PAPX bin tables\u{0007}\u{0007}");
    paras.push(ParaSpec {
        start_char: table_start,
        istd: 0,
    });

    push_para(
        &mut text,
        &mut paras,
        "Tip: Click Edit Document or Export .docx / .md in the toolbar to migrate this legacy binary document into a modern long-term archival format.",
        0,
    );

    let utf16: Vec<u16> = text.encode_utf16().collect();
    let ccp_text = utf16.len() as u32;
    let text_bytes_len = utf16.len() * 2;

    // Layout WordDocument stream:
    // Page 0..1 (0..1024): FIB
    // Offset 1024..: UTF-16LE text, padded to 512-byte boundary
    // Next 512-byte page (pn_chpx): CHPX FKP
    // Next 512-byte page (pn_papx): PAPX FKP
    let text_end_padded = ((text_start_fc as usize + text_bytes_len) + 511) & !511;
    let pn_chpx = (text_end_padded / 512) as u32;
    let pn_papx = pn_chpx + 1;

    let mut word_stream = vec![0u8; (pn_papx as usize + 1) * 512];

    // Write UTF-16LE text at offset 1024
    for (i, &unit) in utf16.iter().enumerate() {
        let off = text_start_fc as usize + i * 2;
        word_stream[off..off + 2].copy_from_slice(&unit.to_le_bytes());
    }

    // Build CHPX FKP page (mark "pure Rust (WebAssembly)" as bold)
    let chpx_page = &mut word_stream[(pn_chpx as usize) * 512..(pn_chpx as usize + 1) * 512];
    let text_end_fc = text_start_fc + text_bytes_len as u32;
    let bold_fc_start = text_start_fc + ((intro_para_start + bold_start_offset) * 2) as u32;
    let bold_fc_end = text_start_fc + ((intro_para_start + bold_end_offset) * 2) as u32;

    let chpx_fcs = [text_start_fc, bold_fc_start, bold_fc_end, text_end_fc];
    for (i, &fc) in chpx_fcs.iter().enumerate() {
        chpx_page[i * 4..i * 4 + 4].copy_from_slice(&fc.to_le_bytes());
    }
    // rgb array at offset 16 (3 runs): run 0 = 0 (plain), run 1 = offset 200 (byte 400 -> bold), run 2 = 0
    chpx_page[16] = 0;
    chpx_page[17] = 200; // byte offset 400
    chpx_page[18] = 0;
    // CHPX at byte 400: cb = 3, sprmCFBold (0x0835) + operand 1
    chpx_page[400] = 3;
    chpx_page[401..403].copy_from_slice(&0x0835u16.to_le_bytes());
    chpx_page[403] = 1;
    chpx_page[511] = 3; // crun

    // Build PAPX FKP page with style istd per paragraph
    let papx_page = &mut word_stream[(pn_papx as usize) * 512..(pn_papx as usize + 1) * 512];
    let crun_pap = paras.len();
    for (i, p) in paras.iter().enumerate() {
        let fc = text_start_fc + (p.start_char * 2) as u32;
        papx_page[i * 4..i * 4 + 4].copy_from_slice(&fc.to_le_bytes());
    }
    papx_page[crun_pap * 4..crun_pap * 4 + 4].copy_from_slice(&text_end_fc.to_le_bytes());

    let bx_base = (crun_pap + 1) * 4;
    let mut papx_word_off: usize = 200; // byte 400
    for (i, p) in paras.iter().enumerate() {
        papx_page[bx_base + i * 13] = papx_word_off as u8;
        let off = papx_word_off * 2;
        // cb = 2 -> payload_len = 3 bytes (istd: u16 + pad)
        papx_page[off] = 2;
        papx_page[off + 1..off + 3].copy_from_slice(&p.istd.to_le_bytes());
        papx_page[off + 3] = 0;
        papx_word_off += 4;
    }
    papx_page[511] = crun_pap as u8;

    // Build 1Table stream:
    // 1. PlcfBteChpx (12 bytes: fc_start, fc_end, pn_chpx)
    // 2. PlcfBtePapx (12 bytes: fc_start, fc_end, pn_papx)
    // 3. Clx (Pcdt: 0x02 + lcb=16 + [cp0=0, cp1=ccp_text, pcd(8 bytes with fc=text_start_fc)])
    let mut table_stream = Vec::new();

    let fc_chpx_bte = table_stream.len() as u32;
    table_stream.extend_from_slice(&text_start_fc.to_le_bytes());
    table_stream.extend_from_slice(&text_end_fc.to_le_bytes());
    table_stream.extend_from_slice(&pn_chpx.to_le_bytes());
    let lcb_chpx_bte = 12u32;

    let fc_papx_bte = table_stream.len() as u32;
    table_stream.extend_from_slice(&text_start_fc.to_le_bytes());
    table_stream.extend_from_slice(&text_end_fc.to_le_bytes());
    table_stream.extend_from_slice(&pn_papx.to_le_bytes());
    let lcb_papx_bte = 12u32;

    let fc_clx = table_stream.len() as u32;
    table_stream.push(0x02); // Pcdt
    table_stream.extend_from_slice(&16u32.to_le_bytes()); // PlcPcd length for 1 piece: (1+1)*4 + 1*8 = 16
    table_stream.extend_from_slice(&0u32.to_le_bytes()); // cp0
    table_stream.extend_from_slice(&ccp_text.to_le_bytes()); // cp1
    // 8-byte Pcd: 2 bytes flags, 4 bytes fc (UTF-16LE -> bit 30 clear), 2 bytes prm
    table_stream.extend_from_slice(&0u16.to_le_bytes());
    table_stream.extend_from_slice(&text_start_fc.to_le_bytes());
    table_stream.extend_from_slice(&0u16.to_le_bytes());
    let lcb_clx = (table_stream.len() as u32) - fc_clx;

    // Populate FIB in word_stream[0..1024]
    word_stream[0..2].copy_from_slice(&0xA5ECu16.to_le_bytes()); // wIdent
    word_stream[2..4].copy_from_slice(&0x00C1u16.to_le_bytes()); // nFib (Word 97)
    word_stream[10..12].copy_from_slice(&0x0200u16.to_le_bytes()); // fWhichTblStm = 1Table
    word_stream[32..34].copy_from_slice(&14u16.to_le_bytes()); // csw = 14
    // cslw at offset 34 + 28 = 62
    word_stream[62..64].copy_from_slice(&22u16.to_le_bytes()); // cslw = 22
    // ccpText at 64 + 12 = 76
    word_stream[76..80].copy_from_slice(&ccp_text.to_le_bytes());
    // cbRgFcLcb at 64 + 88 = 152
    word_stream[152..154].copy_from_slice(&93u16.to_le_bytes());
    let fc_lcb_base = 154;
    let write_pair = |buf: &mut [u8], idx: usize, fc: u32, lcb: u32| {
        let off = fc_lcb_base + idx * 8;
        buf[off..off + 4].copy_from_slice(&fc.to_le_bytes());
        buf[off + 4..off + 8].copy_from_slice(&lcb.to_le_bytes());
    };
    write_pair(&mut word_stream, 12, fc_chpx_bte, lcb_chpx_bte);
    write_pair(&mut word_stream, 13, fc_papx_bte, lcb_papx_bte);
    write_pair(&mut word_stream, 33, fc_clx, lcb_clx);

    // Build minimal OLE2 \x05SummaryInformation stream
    let summary_stream = build_summary_info_stream(
        "Legacy Word 97-2003 Archival Memo",
        "Long-Term Format Compatibility",
        "Orb Archive Team",
    );

    let cursor = Cursor::new(Vec::new());
    let mut comp = CompoundFile::create(cursor)?;
    comp.create_stream("WordDocument")?.write_all(&word_stream)?;
    comp.create_stream("1Table")?.write_all(&table_stream)?;
    comp.create_stream("\x05SummaryInformation")?
        .write_all(&summary_stream)?;

    Ok(comp.into_inner().into_inner())
}

fn build_summary_info_stream(title: &str, subject: &str, author: &str) -> Vec<u8> {
    let mut out = vec![0u8; 48];
    // ByteOrder 0xFFFE, Version 0, OS, CLSID (16 zero), cSections = 1
    out[0..2].copy_from_slice(&0xFFFEu16.to_le_bytes());
    out[24..28].copy_from_slice(&1u32.to_le_bytes());
    // Section offset = 48 at offset 44
    out[44..48].copy_from_slice(&48u32.to_le_bytes());

    let props: [(u32, &str); 3] = [(2, title), (3, subject), (4, author)];
    let mut section = Vec::new();
    section.extend_from_slice(&0u32.to_le_bytes()); // placeholder size
    section.extend_from_slice(&(props.len() as u32).to_le_bytes());

    let header_len = 8 + props.len() * 8;
    let mut values = Vec::new();
    for (pid, val) in props {
        let rel_off = (header_len + values.len()) as u32;
        section.extend_from_slice(&pid.to_le_bytes());
        section.extend_from_slice(&rel_off.to_le_bytes());

        values.extend_from_slice(&30u32.to_le_bytes()); // VT_LPSTR
        let mut bytes = val.as_bytes().to_vec();
        bytes.push(0);
        values.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        values.extend_from_slice(&bytes);
        while values.len() % 4 != 0 {
            values.push(0);
        }
    }
    section.extend_from_slice(&values);
    let total_len = section.len() as u32;
    section[0..4].copy_from_slice(&total_len.to_le_bytes());
    out.extend_from_slice(&section);
    out
}
