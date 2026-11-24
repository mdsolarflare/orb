use std::str::FromStr;

use cms::cert::CertificateChoices;
use cms::content_info::{CmsVersion, ContentInfo};
use cms::signed_data::{
    CertificateSet, EncapsulatedContentInfo, SignedData, SignerIdentifier, SignerInfo,
    SignerInfos,
};
use const_oid::ObjectIdentifier;
use der::asn1::{BitString, OctetString, SetOfVec, UtcTime};
use der::{Any, Decode, Encode};
use p256::ecdsa::{DerSignature as P256DerSig, SigningKey as P256SigningKey};
use sha2::{Digest, Sha256};
use signature::Signer;
use spki::{AlgorithmIdentifierOwned, EncodePublicKey, SubjectPublicKeyInfoOwned};
use x509_cert::attr::{Attribute, Attributes};
use x509_cert::name::Name;
use x509_cert::serial_number::SerialNumber;
use x509_cert::time::{Time, Validity};
use x509_cert::{Certificate, TbsCertificate, Version};

const TEST_P256_KEY_BYTES: [u8; 32] = [
    0x4B, 0x22, 0xA1, 0x7E, 0x19, 0xC4, 0x88, 0x3D, 0x9F, 0x05, 0x6A, 0xE2, 0x14, 0x73, 0xB8,
    0x51, 0x0C, 0x91, 0x2F, 0xD6, 0x47, 0x8A, 0x33, 0xE9, 0x62, 0x1B, 0x55, 0xC0, 0x7A, 0x4E,
    0x29, 0x11,
];

const OID_DATA: &str = "1.2.840.113549.1.7.1";
const OID_SIGNED_DATA: &str = "1.2.840.113549.1.7.2";
const OID_CONTENT_TYPE: &str = "1.2.840.113549.1.9.3";
const OID_MESSAGE_DIGEST: &str = "1.2.840.113549.1.9.4";
const OID_SHA256: &str = "2.16.840.1.101.3.4.2.1";
const OID_ECDSA_SHA256: &str = "1.2.840.10045.4.3.2";

pub struct SignedSamplePdf {
    pub pdf_bytes: Vec<u8>,
    pub signer_cert_pem: String,
}

/// Generates a real 2-page PDF with bookmarks/outline, interactive AcroForm fields,
/// and a cryptographically valid CMS/PKCS#7 ECDSA P-256 detached signature.
pub fn generate_signed_form_pdf() -> SignedSamplePdf {
    let signing_key =
        P256SigningKey::from_bytes((&TEST_P256_KEY_BYTES).into()).expect("valid P-256 test key");
    let cert = build_p256_self_signed_cert(&signing_key);
    let cert_der = cert.to_der().expect("cert DER encoding");
    let cert_pem =
        der::pem::encode_string("CERTIFICATE", der::pem::LineEnding::LF, &cert_der).unwrap();

    let (template, br_placeholder_off, contents_hex_off, contents_hex_len) =
        build_unsigned_pdf_template();

    // Compute exact ByteRange [0, b, c, d]
    // Contents is `<...hex...>` starting with `<` at contents_hex_off - 1 and ending with `>` at contents_hex_off + contents_hex_len
    let b = contents_hex_off - 1;
    let c = contents_hex_off + contents_hex_len + 1;
    let d = template.len() - c;

    let mut pdf = template;
    let br_str = format!("[0 {b} {c} {d}]");
    let br_slot_len = 40;
    assert!(br_str.len() <= br_slot_len, "ByteRange exceeds placeholder slot");
    pdf[br_placeholder_off..br_placeholder_off + br_str.len()].copy_from_slice(br_str.as_bytes());
    for byte in &mut pdf[br_placeholder_off + br_str.len()..br_placeholder_off + br_slot_len] {
        *byte = b' ';
    }

    // Hash the two byte ranges and construct real CMS SignedData
    let mut hasher = Sha256::new();
    hasher.update(&pdf[0..b]);
    hasher.update(&pdf[c..c + d]);
    let digest = hasher.finalize().to_vec();

    let cms_der = build_p256_cms_detached(&signing_key, &cert, &digest);
    let cms_hex = bytes_to_hex_upper(&cms_der);
    assert!(
        cms_hex.len() <= contents_hex_len,
        "CMS hex {} exceeds placeholder {}",
        cms_hex.len(),
        contents_hex_len
    );

    pdf[contents_hex_off..contents_hex_off + cms_hex.len()].copy_from_slice(cms_hex.as_bytes());
    for byte in &mut pdf[contents_hex_off + cms_hex.len()..contents_hex_off + contents_hex_len] {
        *byte = b'0';
    }

    SignedSamplePdf {
        pdf_bytes: pdf,
        signer_cert_pem: cert_pem,
    }
}

/// Produces a tampered copy of a signed PDF by altering visible text inside the signed range.
pub fn tamper_signed_pdf(valid_pdf: &[u8]) -> Vec<u8> {
    let mut tampered = valid_pdf.to_vec();
    let target = b"Archival Form";
    if let Some(pos) = tampered.windows(target.len()).position(|w| w == target) {
        tampered[pos] = b'X';
    } else if tampered.len() > 30 {
        tampered[25] ^= 0x01;
    }
    tampered
}

fn build_p256_self_signed_cert(signing_key: &P256SigningKey) -> Certificate {
    let vk = signing_key.verifying_key();
    let spki_doc = p256::PublicKey::from(vk)
        .to_public_key_der()
        .expect("SPKI encode");
    let spki = SubjectPublicKeyInfoOwned::try_from(spki_doc.as_bytes()).expect("SPKI parse");

    let sig_alg = AlgorithmIdentifierOwned {
        oid: ObjectIdentifier::from_str(OID_ECDSA_SHA256).unwrap(),
        parameters: None,
    };

    let subject = Name::from_str("CN=Orb Archival Signer,O=Orb Document Project,C=US")
        .expect("valid DN");
    let validity = Validity {
        not_before: Time::UtcTime(UtcTime::from_unix_duration(std::time::Duration::from_secs(
            1_735_689_600, // 2025-01-01T00:00:00Z
        )).unwrap()),
        not_after: Time::UtcTime(UtcTime::from_unix_duration(std::time::Duration::from_secs(
            1_893_456_000, // 2030-01-01T00:00:00Z
        )).unwrap()),
    };

    let tbs = TbsCertificate {
        version: Version::V3,
        serial_number: SerialNumber::new(&[0x01, 0x0A, 0x5B, 0x77, 0x42]).unwrap(),
        signature: sig_alg.clone(),
        issuer: subject.clone(),
        validity,
        subject,
        subject_public_key_info: spki,
        issuer_unique_id: None,
        subject_unique_id: None,
        extensions: None,
    };

    let tbs_der = tbs.to_der().expect("TBS DER");
    let sig: P256DerSig = signing_key.sign(&tbs_der);

    Certificate {
        tbs_certificate: tbs,
        signature_algorithm: sig_alg,
        signature: BitString::from_bytes(sig.as_bytes()).unwrap(),
    }
}

fn build_p256_cms_detached(
    signing_key: &P256SigningKey,
    cert: &Certificate,
    content_digest: &[u8],
) -> Vec<u8> {
    let sha256_alg = AlgorithmIdentifierOwned {
        oid: ObjectIdentifier::from_str(OID_SHA256).unwrap(),
        parameters: None,
    };
    let ecdsa_alg = AlgorithmIdentifierOwned {
        oid: ObjectIdentifier::from_str(OID_ECDSA_SHA256).unwrap(),
        parameters: None,
    };

    let mut content_type_vals = SetOfVec::new();
    let data_oid = ObjectIdentifier::from_str(OID_DATA).unwrap();
    content_type_vals
        .insert(Any::from_der(&data_oid.to_der().unwrap()).unwrap())
        .unwrap();

    let mut digest_vals = SetOfVec::new();
    let digest_octets = OctetString::new(content_digest.to_vec()).unwrap();
    digest_vals
        .insert(Any::from_der(&digest_octets.to_der().unwrap()).unwrap())
        .unwrap();

    let mut signed_attrs: Attributes = SetOfVec::new();
    signed_attrs
        .insert(Attribute {
            oid: ObjectIdentifier::from_str(OID_CONTENT_TYPE).unwrap(),
            values: content_type_vals,
        })
        .unwrap();
    signed_attrs
        .insert(Attribute {
            oid: ObjectIdentifier::from_str(OID_MESSAGE_DIGEST).unwrap(),
            values: digest_vals,
        })
        .unwrap();

    // Sign DER-encoded signedAttrs with EXPLICIT SET OF tag 0x31
    let mut attrs_der = signed_attrs.to_der().expect("signedAttrs DER");
    attrs_der[0] = 0x31;
    let sig: P256DerSig = signing_key.sign(&attrs_der);

    let signer_info = SignerInfo {
        version: CmsVersion::V1,
        sid: SignerIdentifier::IssuerAndSerialNumber(cms::cert::IssuerAndSerialNumber {
            issuer: cert.tbs_certificate.issuer.clone(),
            serial_number: cert.tbs_certificate.serial_number.clone(),
        }),
        digest_alg: sha256_alg.clone(),
        signed_attrs: Some(signed_attrs),
        signature_algorithm: ecdsa_alg,
        signature: OctetString::new(sig.as_bytes().to_vec()).unwrap(),
        unsigned_attrs: None,
    };

    let mut digest_algs = SetOfVec::new();
    digest_algs.insert(sha256_alg).unwrap();

    let mut certs = SetOfVec::new();
    certs
        .insert(CertificateChoices::Certificate(cert.clone()))
        .unwrap();

    let mut signer_infos = SetOfVec::new();
    signer_infos.insert(signer_info).unwrap();

    let signed_data = SignedData {
        version: CmsVersion::V1,
        digest_algorithms: digest_algs,
        encap_content_info: EncapsulatedContentInfo {
            econtent_type: ObjectIdentifier::from_str(OID_DATA).unwrap(),
            econtent: None,
        },
        certificates: Some(CertificateSet(certs)),
        crls: None,
        signer_infos: SignerInfos(signer_infos),
    };

    let sd_der = signed_data.to_der().expect("SignedData DER");
    let content_info = ContentInfo {
        content_type: ObjectIdentifier::from_str(OID_SIGNED_DATA).unwrap(),
        content: Any::from_der(&sd_der).unwrap(),
    };
    content_info.to_der().expect("ContentInfo DER")
}

/// Constructs a clean 2-page PDF with outline bookmarks, interactive AcroForm fields,
/// and reserved `/ByteRange` + `/Contents` slots for cryptographic signing.
fn build_unsigned_pdf_template() -> (Vec<u8>, usize, usize, usize) {
    let mut pdf = Vec::<u8>::new();
    pdf.extend_from_slice(b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");

    let mut offsets: Vec<(usize, usize)> = Vec::new();
    let contents_hex_len = 3200usize; // 1600 bytes DER capacity

    let push_obj = |pdf: &mut Vec<u8>, offsets: &mut Vec<(usize, usize)>, id: usize, body: &[u8]| {
        offsets.push((id, pdf.len()));
        pdf.extend_from_slice(format!("{id} 0 obj\n").as_bytes());
        pdf.extend_from_slice(body);
        pdf.extend_from_slice(b"\nendobj\n");
    };

    // 1: Catalog
    push_obj(
        &mut pdf,
        &mut offsets,
        1,
        b"<< /Type /Catalog /Pages 2 0 R /AcroForm 15 0 R /Outlines 16 0 R >>",
    );

    // 2: Pages
    push_obj(
        &mut pdf,
        &mut offsets,
        2,
        b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    );

    // 3: Page 1 (Letter 612x792) with AcroForm widgets
    push_obj(
        &mut pdf,
        &mut offsets,
        3,
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R /ZaDb 7 0 R >> >> /Contents 8 0 R /Annots [10 0 R 11 0 R 12 0 R 13 0 R 14 0 R 20 0 R 21 0 R] >>",
    );

    // 4: Page 2 (Appendix)
    push_obj(
        &mut pdf,
        &mut offsets,
        4,
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 9 0 R >>",
    );

    // 5, 6, 7: Standard PDF Type1 Fonts
    push_obj(
        &mut pdf,
        &mut offsets,
        5,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    );
    push_obj(
        &mut pdf,
        &mut offsets,
        6,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    );
    push_obj(
        &mut pdf,
        &mut offsets,
        7,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>",
    );

    // 8: Page 1 content stream (clean visual layout for form fields & signature block)
    let page1_stream = "\
q
0.13 0.22 0.38 rg
50 710 512 46 re f
BT
/F2 16 Tf 1 1 1 rg 1 0 0 1 66 728 Tm (Orb Document Verification & Archival Form) Tj
ET
0.96 0.97 0.98 rg
50 658 512 40 re f
BT
/F1 10 Tf 0.25 0.29 0.35 rg 1 0 0 1 64 680 Tm (Interactive AcroForm + Cryptographic CMS/PKCS#7 Digital Signature Fixture) Tj
/F1 9 Tf 0.40 0.44 0.50 rg 1 0 0 1 64 666 Tm (Fill any field below and export via PDF incremental update, or inspect the cryptographic signature.) Tj
ET
BT
/F2 11 Tf 0.12 0.14 0.18 rg 1 0 0 1 50 626 Tm (1. Applicant Information) Tj
/F1 10 Tf 0.24 0.27 0.32 rg 1 0 0 1 50 596 Tm (Full Name:) Tj
/F1 10 Tf 1 0 0 1 50 552 Tm (Department:) Tj
/F1 10 Tf 1 0 0 1 50 510 Tm (Expedited Review:) Tj
/F1 10 Tf 1 0 0 1 204 510 Tm (Yes, prioritize long-term archival verification) Tj
/F1 10 Tf 1 0 0 1 50 468 Tm (Approval Tier:) Tj
/F1 10 Tf 1 0 0 1 204 468 Tm (Standard) Tj
/F1 10 Tf 1 0 0 1 314 468 Tm (Executive) Tj
/F1 10 Tf 1 0 0 1 50 422 Tm (Review Notes:) Tj
/F2 11 Tf 0.12 0.14 0.18 rg 1 0 0 1 50 286 Tm (2. Digital Signature Attestation) Tj
/F1 9 Tf 0.35 0.39 0.45 rg 1 0 0 1 50 268 Tm (This document revision is cryptographically signed with ECDSA P-256 / SHA-256.) Tj
ET
0.75 0.78 0.84 RG 0.8 w
180 588 340 24 re S
180 544 240 24 re S
180 506 16 16 re S
180 464 16 16 re S
290 464 16 16 re S
180 340 340 94 re S
0.20 0.48 0.32 RG 1.0 w
0.95 0.98 0.96 rg
50 186 512 68 re B
BT
/F2 10 Tf 0.10 0.40 0.22 rg 1 0 0 1 66 232 Tm (DIGITALLY SIGNED BY: Orb Archival Signer (CN=Orb Archival Signer, O=Orb Document Project)) Tj
/F1 9 Tf 0.22 0.26 0.30 rg 1 0 0 1 66 214 Tm (Reason: Approved archival baseline fixture   |   Location: San Francisco, CA) Tj
/F1 9 Tf 0.30 0.34 0.38 rg 1 0 0 1 66 198 Tm (SubFilter: adbe.pkcs7.detached   |   Click this box or open Signatures panel to verify) Tj
ET
BT
/F1 8.5 Tf 0.48 0.51 0.56 rg 1 0 0 1 50 48 Tm (Orb Prototype Fixture — Page 1 of 2) Tj
ET
Q
";
    push_obj(
        &mut pdf,
        &mut offsets,
        8,
        format!(
            "<< /Length {} >>\nstream\n{page1_stream}endstream",
            page1_stream.len()
        )
        .as_bytes(),
    );

    // 9: Page 2 content stream
    let page2_stream = "\
q
BT
/F2 15 Tf 0.13 0.22 0.38 rg 1 0 0 1 50 726 Tm (Appendix A: Long-Term PDF Compatibility Notes) Tj
/F1 10.5 Tf 0.18 0.20 0.25 rg 1 0 0 1 50 692 Tm (1. Incremental Updates: Form edits are appended after %%EOF to keep prior byte ranges intact.) Tj
/F1 10.5 Tf 1 0 0 1 50 668 Tm (2. Appearance Streams: Orb generates /AP /N streams so filled values render in every PDF reader.) Tj
/F1 10.5 Tf 1 0 0 1 50 644 Tm (3. Cryptographic Integrity: Byte-range digests and CMS signatures are verified in pure Rust WASM.) Tj
/F1 10.5 Tf 1 0 0 1 50 620 Tm (4. Certificate Trust: Import the signer PEM root in the Signatures drawer to verify trust chains.) Tj
/F1 8.5 Tf 0.48 0.51 0.56 rg 1 0 0 1 50 48 Tm (Orb Prototype Fixture — Page 2 of 2) Tj
ET
Q
";
    push_obj(
        &mut pdf,
        &mut offsets,
        9,
        format!(
            "<< /Length {} >>\nstream\n{page2_stream}endstream",
            page2_stream.len()
        )
        .as_bytes(),
    );

    // 10: FullName text field
    push_obj(
        &mut pdf,
        &mut offsets,
        10,
        b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (FullName) /V (Ada Lovelace) /Rect [180 588 520 612] /P 3 0 R /DA (/Helv 11 Tf 0 g) /F 4 >>",
    );

    // 11: Department dropdown field (Ff = 1 << 17 = 131072 -> Combo/Dropdown)
    push_obj(
        &mut pdf,
        &mut offsets,
        11,
        b"<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 131072 /T (Department) /V (Engineering) /Opt [(Engineering) (Legal & Compliance) (Operations) (Archival Research)] /Rect [180 544 420 568] /P 3 0 R /DA (/Helv 11 Tf 0 g) /F 4 >>",
    );

    // 12: ExpediteReview checkbox
    push_obj(
        &mut pdf,
        &mut offsets,
        12,
        b"<< /Type /Annot /Subtype /Widget /FT /Btn /T (ExpediteReview) /V /Yes /AS /Yes /Rect [180 506 196 522] /P 3 0 R /F 4 >>",
    );

    // 13: Multiline Notes field (Ff = 1 << 12 = 4096 -> Multiline)
    push_obj(
        &mut pdf,
        &mut offsets,
        13,
        b"<< /Type /Annot /Subtype /Widget /FT /Tx /Ff 4096 /T (Notes) /V (Verified baseline archive form.) /Rect [180 340 520 434] /P 3 0 R /DA (/Helv 10 Tf 0 g) /F 4 >>",
    );

    // 14: Signature Widget field referencing Signature Value object 18
    push_obj(
        &mut pdf,
        &mut offsets,
        14,
        b"<< /Type /Annot /Subtype /Widget /FT /Sig /T (AuthorSignature) /V 18 0 R /Rect [50 186 562 254] /P 3 0 R /F 132 >>",
    );

    // 19: Parent Radio Group (ApprovalTier, Ff = (1<<15)|(1<<14) = 49152)
    push_obj(
        &mut pdf,
        &mut offsets,
        19,
        b"<< /FT /Btn /Ff 49152 /T (ApprovalTier) /V /Standard /Kids [20 0 R 21 0 R] >>",
    );
    // 20: Radio Kid 1 (Standard)
    push_obj(
        &mut pdf,
        &mut offsets,
        20,
        b"<< /Type /Annot /Subtype /Widget /Parent 19 0 R /AS /Standard /AP << /N << /Standard 22 0 R /Off 23 0 R >> >> /Rect [180 464 196 480] /P 3 0 R /F 4 >>",
    );
    // 21: Radio Kid 2 (Executive)
    push_obj(
        &mut pdf,
        &mut offsets,
        21,
        b"<< /Type /Annot /Subtype /Widget /Parent 19 0 R /AS /Off /AP << /N << /Executive 22 0 R /Off 23 0 R >> >> /Rect [290 464 306 480] /P 3 0 R /F 4 >>",
    );
    // 22, 23: Minimal empty appearance XObjects for radio state detection
    push_obj(
        &mut pdf,
        &mut offsets,
        22,
        b"<< /Type /XObject /Subtype /Form /BBox [0 0 16 16] /Length 0 >>\nstream\n\nendstream",
    );
    push_obj(
        &mut pdf,
        &mut offsets,
        23,
        b"<< /Type /XObject /Subtype /Form /BBox [0 0 16 16] /Length 0 >>\nstream\n\nendstream",
    );

    // 15: AcroForm dictionary
    push_obj(
        &mut pdf,
        &mut offsets,
        15,
        b"<< /Fields [10 0 R 11 0 R 12 0 R 13 0 R 14 0 R 19 0 R] /SigFlags 3 /NeedAppearances true /DR << /Font << /Helv 5 0 R /ZaDb 7 0 R >> >> >>",
    );

    // 16, 17, 24: Document Outline (Bookmarks)
    push_obj(
        &mut pdf,
        &mut offsets,
        16,
        b"<< /Type /Outlines /First 17 0 R /Last 24 0 R /Count 2 >>",
    );
    push_obj(
        &mut pdf,
        &mut offsets,
        17,
        b"<< /Title (1. Verification & Archival Form) /Parent 16 0 R /Next 24 0 R /Dest [3 0 R /Fit] >>",
    );
    push_obj(
        &mut pdf,
        &mut offsets,
        24,
        b"<< /Title (2. Appendix A: Compatibility Notes) /Parent 16 0 R /Prev 17 0 R /Dest [4 0 R /Fit] >>",
    );

    // 18: Signature Dictionary with exact fixed-width /ByteRange and /Contents placeholders
    offsets.push((18, pdf.len()));
    pdf.extend_from_slice(b"18 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /Name (Orb Archival Signer) /Reason (Approved archival baseline fixture) /Location (San Francisco, CA) /ContactInfo (security@orb.local) /M (D:20261121180000Z) /ByteRange ");
    let br_offset = pdf.len();
    pdf.extend_from_slice(&[b' '; 40]);
    pdf.extend_from_slice(b" /Contents <");
    let contents_offset = pdf.len();
    pdf.extend_from_slice(&vec![b'0'; contents_hex_len]);
    pdf.extend_from_slice(b"> >>\nendobj\n");

    // 25: Document Info
    push_obj(
        &mut pdf,
        &mut offsets,
        25,
        b"<< /Title (Orb Verification & Archival Form) /Author (Orb Document Project) /Subject (Signed AcroForm PDF Fixture) >>",
    );

    // Sort offsets by object ID and write xref table
    offsets.sort_by_key(|(id, _)| *id);
    let max_id = offsets.last().map(|(id, _)| *id).unwrap_or(0);
    let xref_pos = pdf.len();
    pdf.extend_from_slice(format!("xref\n0 {}\n", max_id + 1).as_bytes());
    pdf.extend_from_slice(b"0000000000 65535 f \n");
    let offset_map: std::collections::HashMap<usize, usize> = offsets.into_iter().collect();
    for id in 1..=max_id {
        if let Some(&off) = offset_map.get(&id) {
            pdf.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
        } else {
            pdf.extend_from_slice(b"0000000000 65535 f \n");
        }
    }
    pdf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R /Info 25 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n",
            max_id + 1
        )
        .as_bytes(),
    );

    (pdf, br_offset, contents_offset, contents_hex_len)
}

fn bytes_to_hex_upper(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push_str(&format!("{b:02X}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CoverageStatus, FormFieldType, FormFieldUpdate, FormFieldValue, IntegrityStatus,
        TrustStatus, WebTrustProvider, apply_form_updates, inspect_pdf,
    };

    #[test]
    fn verifies_valid_and_tampered_signed_pdf_and_user_root_trust() {
        let sample = generate_signed_form_pdf();
        let default_trust = WebTrustProvider::default();

        let report = inspect_pdf(&sample.pdf_bytes, Some("signed.pdf"), &default_trust)
            .expect("inspect_pdf failed");
        assert_eq!(report.page_count, 2);
        assert_eq!(report.outline.len(), 2);
        assert!(report.has_signatures);
        assert!(report.has_forms);
        assert_eq!(report.signatures.len(), 1);

        let sig = &report.signatures[0];
        assert_eq!(sig.integrity, IntegrityStatus::Valid, "{}", sig.integrity_detail);
        assert_eq!(sig.coverage, CoverageStatus::FullDocument);
        assert_eq!(sig.trust.status, TrustStatus::SelfSigned);
        assert_eq!(
            sig.signer_certificate
                .as_ref()
                .and_then(|c| c.common_name.as_deref()),
            Some("Orb Archival Signer")
        );

        // Now verify with user-imported root PEM
        let custom_trust = WebTrustProvider::from_pem_list(&[sample.signer_cert_pem.clone()]);
        let trusted_report = inspect_pdf(&sample.pdf_bytes, Some("signed.pdf"), &custom_trust)
            .expect("trusted inspect failed");
        assert_eq!(
            trusted_report.signatures[0].trust.status,
            TrustStatus::TrustedByUserRoot
        );

        // Tamper 1 byte inside signed range and verify detection
        let tampered = tamper_signed_pdf(&sample.pdf_bytes);
        let tampered_report = inspect_pdf(&tampered, Some("tampered.pdf"), &default_trust)
            .expect("tampered inspect failed");
        assert_eq!(
            tampered_report.signatures[0].integrity,
            IntegrityStatus::Invalid
        );
    }

    #[test]
    fn incremental_form_update_preserves_original_signature_revision() {
        let sample = generate_signed_form_pdf();
        let updates = vec![
            FormFieldUpdate {
                field_name: "FullName".into(),
                value: FormFieldValue::Text("Grace Hopper".into()),
            },
            FormFieldUpdate {
                field_name: "Department".into(),
                value: FormFieldValue::Choice("Archival Research".into()),
            },
            FormFieldUpdate {
                field_name: "ExpediteReview".into(),
                value: FormFieldValue::Bool(false),
            },
            FormFieldUpdate {
                field_name: "ApprovalTier".into(),
                value: FormFieldValue::Choice("Executive".into()),
            },
            FormFieldUpdate {
                field_name: "Notes".into(),
                value: FormFieldValue::Text("Line 1\nLine 2 verified".into()),
            },
        ];

        let updated_pdf = apply_form_updates(&sample.pdf_bytes, &updates)
            .expect("apply_form_updates failed");
        // Incremental update MUST keep the exact original bytes as a prefix!
        assert!(updated_pdf.starts_with(&sample.pdf_bytes));

        let trust = WebTrustProvider::default();
        let re_inspected = inspect_pdf(&updated_pdf, Some("filled.pdf"), &trust)
            .expect("re-inspect failed");

        // Verify updated form field values
        let full_name = re_inspected
            .form_fields
            .iter()
            .find(|f| f.name == "FullName")
            .unwrap();
        assert_eq!(full_name.value, FormFieldValue::Text("Grace Hopper".into()));

        let dept = re_inspected
            .form_fields
            .iter()
            .find(|f| f.name == "Department")
            .unwrap();
        assert_eq!(
            dept.value,
            FormFieldValue::Choice("Archival Research".into())
        );

        let checkbox = re_inspected
            .form_fields
            .iter()
            .find(|f| f.name == "ExpediteReview")
            .unwrap();
        assert_eq!(checkbox.field_type, FormFieldType::Checkbox);
        assert_eq!(checkbox.value, FormFieldValue::Bool(false));

        // Original cryptographic signature remains intact over its signed revision,
        // and coverage transparently reports incremental updates after signing!
        assert_eq!(re_inspected.signatures.len(), 1);
        assert_eq!(re_inspected.signatures[0].integrity, IntegrityStatus::Valid);
        assert_eq!(
            re_inspected.signatures[0].coverage,
            CoverageStatus::IncrementalUpdatesAfterSigning
        );
    }

    #[test]
    fn verifies_rsa2048_pkcs1v15_pdf_signature() {
        use rand_chacha::ChaCha20Rng;
        use rand_chacha::rand_core::SeedableRng;
        use rsa::pkcs1v15::SigningKey as RsaSigningKey;
        use rsa::RsaPrivateKey;
        use signature::SignatureEncoding;

        let mut rng = ChaCha20Rng::from_seed([0x5Au8; 32]);
        let priv_key = RsaPrivateKey::new(&mut rng, 2048).expect("RSA keygen");
        let signing_key = RsaSigningKey::<Sha256>::new(priv_key.clone());
        let pub_key = priv_key.to_public_key();
        let spki_doc = pub_key.to_public_key_der().unwrap();
        let spki = SubjectPublicKeyInfoOwned::try_from(spki_doc.as_bytes()).unwrap();

        let sig_alg = AlgorithmIdentifierOwned {
            oid: ObjectIdentifier::from_str("1.2.840.113549.1.1.11").unwrap(), // sha256WithRSAEncryption
            parameters: Some(Any::null()),
        };
        let subject = Name::from_str("CN=RSA Test Signer,O=Orb").unwrap();
        let validity = Validity {
            not_before: Time::UtcTime(
                UtcTime::from_unix_duration(std::time::Duration::from_secs(1_735_689_600)).unwrap(),
            ),
            not_after: Time::UtcTime(
                UtcTime::from_unix_duration(std::time::Duration::from_secs(1_893_456_000)).unwrap(),
            ),
        };
        let tbs = TbsCertificate {
            version: Version::V3,
            serial_number: SerialNumber::new(&[0x09, 0x09]).unwrap(),
            signature: sig_alg.clone(),
            issuer: subject.clone(),
            validity,
            subject,
            subject_public_key_info: spki,
            issuer_unique_id: None,
            subject_unique_id: None,
            extensions: None,
        };
        let tbs_sig = signing_key.sign(&tbs.to_der().unwrap());
        let cert = Certificate {
            tbs_certificate: tbs,
            signature_algorithm: sig_alg,
            signature: BitString::from_bytes(&tbs_sig.to_bytes()).unwrap(),
        };

        let (mut pdf, br_off, contents_off, contents_len) = build_unsigned_pdf_template();
        let b = contents_off - 1;
        let c = contents_off + contents_len + 1;
        let d = pdf.len() - c;
        let br_str = format!("[0 {b} {c} {d}]");
        pdf[br_off..br_off + br_str.len()].copy_from_slice(br_str.as_bytes());

        let mut h = Sha256::new();
        h.update(&pdf[0..b]);
        h.update(&pdf[c..c + d]);
        let digest = h.finalize().to_vec();

        // Build CMS using generic rsaEncryption OID (1.2.840.113549.1.1.1) — matching real Adobe PDFs!
        let sha256_alg = AlgorithmIdentifierOwned {
            oid: ObjectIdentifier::from_str(OID_SHA256).unwrap(),
            parameters: None,
        };
        let rsa_generic_alg = AlgorithmIdentifierOwned {
            oid: ObjectIdentifier::from_str("1.2.840.113549.1.1.1").unwrap(),
            parameters: Some(Any::null()),
        };

        let mut ct_vals = SetOfVec::new();
        ct_vals
            .insert(
                Any::from_der(&ObjectIdentifier::from_str(OID_DATA).unwrap().to_der().unwrap())
                    .unwrap(),
            )
            .unwrap();
        let mut md_vals = SetOfVec::new();
        md_vals
            .insert(Any::from_der(&OctetString::new(digest).unwrap().to_der().unwrap()).unwrap())
            .unwrap();
        let mut signed_attrs: Attributes = SetOfVec::new();
        signed_attrs
            .insert(Attribute {
                oid: ObjectIdentifier::from_str(OID_CONTENT_TYPE).unwrap(),
                values: ct_vals,
            })
            .unwrap();
        signed_attrs
            .insert(Attribute {
                oid: ObjectIdentifier::from_str(OID_MESSAGE_DIGEST).unwrap(),
                values: md_vals,
            })
            .unwrap();
        let mut attrs_der = signed_attrs.to_der().unwrap();
        attrs_der[0] = 0x31;
        let sig_bytes = signing_key.sign(&attrs_der).to_bytes().to_vec();

        let signer_info = SignerInfo {
            version: CmsVersion::V1,
            sid: SignerIdentifier::IssuerAndSerialNumber(cms::cert::IssuerAndSerialNumber {
                issuer: cert.tbs_certificate.issuer.clone(),
                serial_number: cert.tbs_certificate.serial_number.clone(),
            }),
            digest_alg: sha256_alg.clone(),
            signed_attrs: Some(signed_attrs),
            signature_algorithm: rsa_generic_alg,
            signature: OctetString::new(sig_bytes).unwrap(),
            unsigned_attrs: None,
        };

        let mut digest_algs = SetOfVec::new();
        digest_algs.insert(sha256_alg).unwrap();
        let mut certs = SetOfVec::new();
        certs
            .insert(CertificateChoices::Certificate(cert.clone()))
            .unwrap();
        let mut signer_infos = SetOfVec::new();
        signer_infos.insert(signer_info).unwrap();

        let sd = SignedData {
            version: CmsVersion::V1,
            digest_algorithms: digest_algs,
            encap_content_info: EncapsulatedContentInfo {
                econtent_type: ObjectIdentifier::from_str(OID_DATA).unwrap(),
                econtent: None,
            },
            certificates: Some(CertificateSet(certs)),
            crls: None,
            signer_infos: SignerInfos(signer_infos),
        };
        let ci = ContentInfo {
            content_type: ObjectIdentifier::from_str(OID_SIGNED_DATA).unwrap(),
            content: Any::from_der(&sd.to_der().unwrap()).unwrap(),
        };
        let hex = bytes_to_hex_upper(&ci.to_der().unwrap());
        pdf[contents_off..contents_off + hex.len()].copy_from_slice(hex.as_bytes());

        let report = inspect_pdf(&pdf, Some("rsa_signed.pdf"), &WebTrustProvider::default())
            .expect("RSA inspect failed");
        assert_eq!(report.signatures.len(), 1);
        assert_eq!(
            report.signatures[0].integrity,
            IntegrityStatus::Valid,
            "{}",
            report.signatures[0].integrity_detail
        );
    }
}
