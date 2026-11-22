use std::collections::HashSet;

use cms::cert::CertificateChoices;
use cms::content_info::ContentInfo;
use cms::signed_data::{SignedData, SignerIdentifier};
use der::{Decode, Encode};
use lopdf::{Dictionary, Document, Object, ObjectId};
use rsa::pss::{Signature as PssSignature, VerifyingKey as PssVerifyingKey};
use rsa::RsaPublicKey;
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha384, Sha512};
use signature::Verifier;
use spki::DecodePublicKey;
use x509_cert::Certificate;

use crate::forms::PdfPageMetrics;
use crate::trust::{CertificateTrustProvider, TrustEvaluation, verify_raw_signature};
use crate::{decode_pdf_text_string, read_pdf_string};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntegrityStatus {
    Valid,
    Invalid,
    UnsupportedAlgorithm,
    ParseError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CoverageStatus {
    FullDocument,
    IncrementalUpdatesAfterSigning,
    InvalidByteRange,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateInfo {
    pub common_name: Option<String>,
    pub organization: Option<String>,
    pub subject: String,
    pub issuer: String,
    pub serial_hex: String,
    pub not_before: String,
    pub not_after: String,
    pub sha256_fingerprint: String,
    pub key_algorithm: String,
    pub pem: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSignatureReport {
    pub id: String,
    pub field_name: String,
    pub signer_name: Option<String>,
    pub reason: Option<String>,
    pub location: Option<String>,
    pub contact_info: Option<String>,
    pub signing_time: Option<String>,
    pub sub_filter: Option<String>,
    pub digest_algorithm: Option<String>,
    pub signature_algorithm: Option<String>,
    pub byte_range: Option<[usize; 4]>,
    pub page_index: Option<usize>,
    pub rect: Option<[f32; 4]>,
    pub integrity: IntegrityStatus,
    pub integrity_detail: String,
    pub coverage: CoverageStatus,
    pub coverage_detail: String,
    pub trust: TrustEvaluation,
    pub signer_certificate: Option<CertificateInfo>,
    pub certificate_chain: Vec<CertificateInfo>,
}

struct DiscoveredSig<'a> {
    field_name: String,
    sig_dict: &'a Dictionary,
    page_index: Option<usize>,
    rect: Option<[f32; 4]>,
}

pub fn inspect_signatures(
    raw_pdf: &[u8],
    doc: &Document,
    _pages: &[PdfPageMetrics],
    trust_provider: &dyn CertificateTrustProvider,
) -> Vec<PdfSignatureReport> {
    let mut reports = Vec::new();
    let mut seen_sig_ids: HashSet<ObjectId> = HashSet::new();
    let mut discovered: Vec<DiscoveredSig<'_>> = Vec::new();

    // Map page ObjectId -> 0-based page_index
    let page_map: std::collections::HashMap<ObjectId, usize> = doc
        .get_pages()
        .into_iter()
        .enumerate()
        .map(|(idx, (_, oid))| (oid, idx))
        .collect();

    // 1. Walk page annotations for Widget annotations of /FT /Sig
    for (page_idx, (_, page_id)) in doc.get_pages().into_iter().enumerate() {
        let Ok(page_dict) = doc.get_dictionary(page_id) else {
            continue;
        };
        let Ok(annots_obj) = page_dict.get(b"Annots") else {
            continue;
        };
        let annots = match annots_obj {
            Object::Array(a) => a.as_slice(),
            Object::Reference(id) => match doc.get_object(*id).ok() {
                Some(Object::Array(a)) => a.as_slice(),
                _ => continue,
            },
            _ => continue,
        };
        for annot in annots {
            let annot_dict = match annot {
                Object::Reference(id) => doc.get_dictionary(*id).ok(),
                Object::Dictionary(d) => Some(d),
                _ => None,
            };
            let Some(ad) = annot_dict else {
                continue;
            };
            if is_sig_field(doc, ad) {
                if let Some((sig_oid, sig_dict)) = resolve_sig_value(doc, ad) {
                    if let Some(oid) = sig_oid {
                        if !seen_sig_ids.insert(oid) {
                            continue;
                        }
                    }
                    let field_name = read_pdf_string(ad, b"T")
                        .unwrap_or_else(|| format!("Signature {}", discovered.len() + 1));
                    let rect = extract_rect(ad);
                    discovered.push(DiscoveredSig {
                        field_name,
                        sig_dict,
                        page_index: Some(page_idx),
                        rect,
                    });
                }
            }
        }
    }

    // 2. Walk /AcroForm /Fields for non-widget or unlinked signature fields
    if let Ok(catalog) = doc.catalog() {
        if let Ok(af_obj) = catalog.get(b"AcroForm") {
            let af_dict = match af_obj {
                Object::Reference(id) => doc.get_dictionary(*id).ok(),
                Object::Dictionary(d) => Some(d),
                _ => None,
            };
            if let Some(af) = af_dict {
                if let Ok(fields_obj) = af.get(b"Fields") {
                    let fields = match fields_obj {
                        Object::Array(a) => Some(a.as_slice()),
                        Object::Reference(id) => match doc.get_object(*id).ok() {
                            Some(Object::Array(a)) => Some(a.as_slice()),
                            _ => None,
                        },
                        _ => None,
                    };
                    if let Some(arr) = fields {
                        for item in arr {
                            let fdict = match item {
                                Object::Reference(id) => doc.get_dictionary(*id).ok(),
                                Object::Dictionary(d) => Some(d),
                                _ => None,
                            };
                            if let Some(fd) = fdict {
                                if is_sig_field(doc, fd) {
                                    if let Some((sig_oid, sig_dict)) = resolve_sig_value(doc, fd) {
                                        if let Some(oid) = sig_oid {
                                            if !seen_sig_ids.insert(oid) {
                                                continue;
                                            }
                                        }
                                        let field_name = read_pdf_string(fd, b"T").unwrap_or_else(
                                            || format!("Signature {}", discovered.len() + 1),
                                        );
                                        let page_index = fd
                                            .get(b"P")
                                            .ok()
                                            .and_then(|o| match o {
                                                Object::Reference(pid) => page_map.get(pid).copied(),
                                                _ => None,
                                            });
                                        discovered.push(DiscoveredSig {
                                            field_name,
                                            sig_dict,
                                            page_index,
                                            rect: extract_rect(fd),
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Fallback scan for any indirect /Type /Sig dictionary not linked via fields
    for (&oid, obj) in &doc.objects {
        if seen_sig_ids.contains(&oid) {
            continue;
        }
        if let Object::Dictionary(d) = obj {
            let is_type_sig = d
                .get(b"Type")
                .ok()
                .and_then(|o| o.as_name().ok())
                .map(|n| n == b"Sig" || n == b"DocTimeStamp")
                .unwrap_or(false);
            if is_type_sig && d.has(b"ByteRange") && d.has(b"Contents") {
                seen_sig_ids.insert(oid);
                discovered.push(DiscoveredSig {
                    field_name: format!("Signature {}", discovered.len() + 1),
                    sig_dict: d,
                    page_index: None,
                    rect: None,
                });
            }
        }
    }

    for (idx, item) in discovered.into_iter().enumerate() {
        reports.push(evaluate_signature(
            idx,
            raw_pdf,
            item,
            trust_provider,
        ));
    }

    reports
}

fn is_sig_field(doc: &Document, dict: &Dictionary) -> bool {
    if let Ok(ft) = dict.get(b"FT") {
        if ft.as_name().ok() == Some(b"Sig") {
            return true;
        }
    }
    if let Ok(Object::Reference(parent_id)) = dict.get(b"Parent") {
        if let Ok(parent) = doc.get_dictionary(*parent_id) {
            if let Ok(ft) = parent.get(b"FT") {
                return ft.as_name().ok() == Some(b"Sig");
            }
        }
    }
    false
}

fn resolve_sig_value<'a>(
    doc: &'a Document,
    field_dict: &'a Dictionary,
) -> Option<(Option<ObjectId>, &'a Dictionary)> {
    let v_obj = field_dict.get(b"V").ok().or_else(|| {
        if let Ok(Object::Reference(pid)) = field_dict.get(b"Parent") {
            doc.get_dictionary(*pid).ok()?.get(b"V").ok()
        } else {
            None
        }
    })?;
    match v_obj {
        Object::Reference(oid) => doc.get_dictionary(*oid).ok().map(|d| (Some(*oid), d)),
        Object::Dictionary(d) => Some((None, d)),
        _ => None,
    }
}

fn extract_rect(dict: &Dictionary) -> Option<[f32; 4]> {
    let arr = dict.get(b"Rect").ok()?.as_array().ok()?;
    if arr.len() < 4 {
        return None;
    }
    let to_f32 = |o: &Object| match o {
        Object::Real(r) => Some(*r),
        Object::Integer(i) => Some(*i as f32),
        _ => None,
    };
    Some([
        to_f32(&arr[0])?,
        to_f32(&arr[1])?,
        to_f32(&arr[2])?,
        to_f32(&arr[3])?,
    ])
}

fn evaluate_signature(
    idx: usize,
    raw_pdf: &[u8],
    disc: DiscoveredSig<'_>,
    trust_provider: &dyn CertificateTrustProvider,
) -> PdfSignatureReport {
    let d = disc.sig_dict;
    let signer_name = read_pdf_string(d, b"Name");
    let reason = read_pdf_string(d, b"Reason");
    let location = read_pdf_string(d, b"Location");
    let contact_info = read_pdf_string(d, b"ContactInfo");
    let signing_time = read_pdf_string(d, b"M").map(|m| format_pdf_date(&m));
    let sub_filter = d
        .get(b"SubFilter")
        .ok()
        .and_then(|o| o.as_name().ok())
        .map(|b| String::from_utf8_lossy(b).into_owned());

    let byte_range = extract_byte_range(d);
    let (coverage, coverage_detail) = evaluate_coverage(raw_pdf, byte_range);

    let contents_raw = d.get(b"Contents").ok().and_then(|o| match o {
        Object::String(bytes, _) => Some(bytes.as_slice()),
        _ => None,
    });

    let mut report = PdfSignatureReport {
        id: format!("sig-{}", idx + 1),
        field_name: disc.field_name,
        signer_name,
        reason,
        location,
        contact_info,
        signing_time,
        sub_filter: sub_filter.clone(),
        digest_algorithm: None,
        signature_algorithm: None,
        byte_range,
        page_index: disc.page_index,
        rect: disc.rect,
        integrity: IntegrityStatus::ParseError,
        integrity_detail: String::new(),
        coverage,
        coverage_detail,
        trust: TrustEvaluation {
            status: crate::trust::TrustStatus::InvalidCertificate,
            detail: "Signature certificate could not be evaluated.".into(),
            matched_root_subject: None,
        },
        signer_certificate: None,
        certificate_chain: Vec::new(),
    };

    let Some(br) = byte_range else {
        report.integrity_detail = "Signature dictionary is missing a valid /ByteRange array.".into();
        return report;
    };
    if coverage == CoverageStatus::InvalidByteRange {
        report.integrity = IntegrityStatus::Invalid;
        report.integrity_detail = "Signature /ByteRange bounds are invalid or out of file range.".into();
        return report;
    }

    let Some(contents) = contents_raw else {
        report.integrity_detail = "Signature dictionary is missing /Contents payload.".into();
        return report;
    };

    let Some(der_slice) = trim_der_envelope(contents) else {
        report.integrity_detail = "Signature /Contents is not a valid ASN.1 DER sequence.".into();
        return report;
    };

    let ci = match ContentInfo::from_der(der_slice) {
        Ok(ci) => ci,
        Err(e) => {
            report.integrity_detail = format!("Failed to decode CMS ContentInfo DER: {e}");
            return report;
        }
    };

    let content_der = match ci.content.to_der() {
        Ok(b) => b,
        Err(e) => {
            report.integrity_detail = format!("Failed to extract CMS content bytes: {e}");
            return report;
        }
    };

    let signed_data = match SignedData::from_der(&content_der) {
        Ok(sd) => sd,
        Err(e) => {
            report.integrity_detail = format!("Failed to decode CMS SignedData: {e}");
            return report;
        }
    };

    // Extract embedded X.509 certificates
    let mut parsed_certs: Vec<(Certificate, Vec<u8>)> = Vec::new();
    if let Some(certs) = &signed_data.certificates {
        for choice in certs.0.iter() {
            if let CertificateChoices::Certificate(cert) = choice {
                if let Ok(der_bytes) = cert.to_der() {
                    parsed_certs.push((cert.clone(), der_bytes));
                }
            }
        }
    }

    let Some(signer_info) = signed_data.signer_infos.0.iter().next() else {
        report.integrity_detail = "CMS SignedData contains no SignerInfo entries.".into();
        return report;
    };

    let digest_oid = signer_info.digest_alg.oid.to_string();
    let sig_oid = signer_info.signature_algorithm.oid.to_string();
    report.digest_algorithm = Some(friendly_oid_name(&digest_oid));
    report.signature_algorithm = Some(friendly_oid_name(&sig_oid));

    // Locate signer certificate matching SignerIdentifier
    let signer_idx = find_signer_cert_index(&parsed_certs, &signer_info.sid).unwrap_or(0);
    let mut ordered_certs: Vec<(Certificate, Vec<u8>)> = Vec::new();
    if let Some(leaf) = parsed_certs.get(signer_idx) {
        ordered_certs.push(leaf.clone());
    }
    for (i, pair) in parsed_certs.iter().enumerate() {
        if i != signer_idx {
            ordered_certs.push(pair.clone());
        }
    }

    let chain_der: Vec<Vec<u8>> = ordered_certs.iter().map(|(_, d)| d.clone()).collect();
    report.trust = trust_provider.evaluate_chain(&chain_der);
    report.certificate_chain = ordered_certs
        .iter()
        .map(|(cert, der_bytes)| build_cert_info(cert, der_bytes))
        .collect();
    report.signer_certificate = report.certificate_chain.first().cloned();
    if report.signer_name.is_none() {
        report.signer_name = report
            .signer_certificate
            .as_ref()
            .and_then(|c| c.common_name.clone());
    }

    // Compute digest over the exact two signed byte ranges
    let slice_a = &raw_pdf[br[0]..br[0] + br[1]];
    let slice_b = &raw_pdf[br[2]..br[2] + br[3]];
    let Some(computed_digest) = compute_two_slice_digest(&digest_oid, slice_a, slice_b) else {
        report.integrity = IntegrityStatus::UnsupportedAlgorithm;
        report.integrity_detail = format!("Unsupported digest algorithm OID: {digest_oid}");
        return report;
    };

    let Some((signer_cert, _)) = ordered_certs.first() else {
        report.integrity_detail = "No signer X.509 certificate found in CMS SignedData.".into();
        return report;
    };
    let spki_der = match signer_cert.tbs_certificate.subject_public_key_info.to_der() {
        Ok(b) => b,
        Err(e) => {
            report.integrity_detail = format!("Failed to encode signer public key: {e}");
            return report;
        }
    };

    let sig_bytes = signer_info.signature.as_bytes();

    // Case A: Signed attributes present (standard PKCS#7 / CAdES PDF signatures)
    if let Some(signed_attrs) = &signer_info.signed_attrs {
        // Verify messageDigest attribute (1.2.840.113549.1.9.4) matches computed byte-range digest
        let mut embedded_digest: Option<Vec<u8>> = None;
        for attr in signed_attrs.iter() {
            if attr.oid.to_string() == "1.2.840.113549.1.9.4" {
                if let Some(val) = attr.values.iter().next() {
                    if let Ok(octet) = der::asn1::OctetString::from_der(&val.to_der().unwrap_or_default())
                    {
                        embedded_digest = Some(octet.as_bytes().to_vec());
                    }
                }
            }
        }

        let Some(expected_digest) = embedded_digest else {
            report.integrity = IntegrityStatus::Invalid;
            report.integrity_detail =
                "CMS signed attributes are missing the required messageDigest attribute.".into();
            return report;
        };

        if expected_digest != computed_digest {
            report.integrity = IntegrityStatus::Invalid;
            report.integrity_detail =
                "Document byte-range hash does NOT match the signed messageDigest (document was altered after signing).".into();
            return report;
        }

        // RFC 5652 Section 5.4: re-encode signedAttrs with EXPLICIT SET OF tag (0x31)
        let mut attrs_der = match signed_attrs.to_der() {
            Ok(b) => b,
            Err(e) => {
                report.integrity_detail = format!("Failed to DER-encode signed attributes: {e}");
                return report;
            }
        };
        if let Some(first) = attrs_der.first_mut() {
            *first = 0x31;
        }

        match verify_cms_signature(&spki_der, &digest_oid, &sig_oid, &attrs_der, sig_bytes) {
            VerifyOutcome::Valid => {
                report.integrity = IntegrityStatus::Valid;
                report.integrity_detail = format!(
                    "Byte-range {} digest and {} signature verified cryptographically.",
                    friendly_oid_name(&digest_oid),
                    friendly_oid_name(&sig_oid)
                );
            }
            VerifyOutcome::Invalid => {
                report.integrity = IntegrityStatus::Invalid;
                report.integrity_detail =
                    "Byte-range digest matches, but cryptographic signature verification failed.".into();
            }
            VerifyOutcome::Unsupported(msg) => {
                report.integrity = IntegrityStatus::UnsupportedAlgorithm;
                report.integrity_detail = msg;
            }
        }
    } else {
        // Case B: Direct signature over content slices (no signedAttrs)
        let mut combined = Vec::with_capacity(slice_a.len() + slice_b.len());
        combined.extend_from_slice(slice_a);
        combined.extend_from_slice(slice_b);

        match verify_cms_signature(&spki_der, &digest_oid, &sig_oid, &combined, sig_bytes) {
            VerifyOutcome::Valid => {
                report.integrity = IntegrityStatus::Valid;
                report.integrity_detail =
                    "Direct CMS byte-range signature verified cryptographically.".into();
            }
            VerifyOutcome::Invalid => {
                report.integrity = IntegrityStatus::Invalid;
                report.integrity_detail =
                    "Cryptographic signature verification failed (document may have been tampered).".into();
            }
            VerifyOutcome::Unsupported(msg) => {
                report.integrity = IntegrityStatus::UnsupportedAlgorithm;
                report.integrity_detail = msg;
            }
        }
    }

    report
}

enum VerifyOutcome {
    Valid,
    Invalid,
    Unsupported(String),
}

fn verify_cms_signature(
    spki_der: &[u8],
    digest_oid: &str,
    sig_oid: &str,
    message: &[u8],
    sig_bytes: &[u8],
) -> VerifyOutcome {
    // Handle RSA-PSS explicitly
    if sig_oid == "1.2.840.113549.1.1.10" {
        let Ok(pub_key) = RsaPublicKey::from_public_key_der(spki_der) else {
            return VerifyOutcome::Invalid;
        };
        let Ok(sig) = PssSignature::try_from(sig_bytes) else {
            return VerifyOutcome::Invalid;
        };
        let ok = match digest_oid {
            "2.16.840.1.101.3.4.2.1" => {
                PssVerifyingKey::<Sha256>::new(pub_key).verify(message, &sig).is_ok()
            }
            "2.16.840.1.101.3.4.2.2" => {
                PssVerifyingKey::<Sha384>::new(pub_key).verify(message, &sig).is_ok()
            }
            "2.16.840.1.101.3.4.2.3" => {
                PssVerifyingKey::<Sha512>::new(pub_key).verify(message, &sig).is_ok()
            }
            _ => return VerifyOutcome::Unsupported(format!("Unsupported RSA-PSS digest OID {digest_oid}")),
        };
        return if ok {
            VerifyOutcome::Valid
        } else {
            VerifyOutcome::Invalid
        };
    }

    // Map generic rsaEncryption / id-ecPublicKey + digest OID to combined signature OID
    let resolved_oid: &str = match (sig_oid, digest_oid) {
        ("1.2.840.113549.1.1.1", "2.16.840.1.101.3.4.2.1") => "1.2.840.113549.1.1.11",
        ("1.2.840.113549.1.1.1", "2.16.840.1.101.3.4.2.2") => "1.2.840.113549.1.1.12",
        ("1.2.840.113549.1.1.1", "2.16.840.1.101.3.4.2.3") => "1.2.840.113549.1.1.13",
        ("1.2.840.113549.1.1.1", "1.3.14.3.2.26") => "1.2.840.113549.1.1.5",
        ("1.2.840.10045.2.1", "2.16.840.1.101.3.4.2.1") => "1.2.840.10045.4.3.2",
        ("1.2.840.10045.2.1", "2.16.840.1.101.3.4.2.2") => "1.2.840.10045.4.3.3",
        (specific, _) => specific,
    };

    match resolved_oid {
        "1.2.840.113549.1.1.11"
        | "1.2.840.113549.1.1.12"
        | "1.2.840.113549.1.1.13"
        | "1.2.840.113549.1.1.5"
        | "1.2.840.10045.4.3.2"
        | "1.2.840.10045.4.3.3" => {
            if verify_raw_signature(spki_der, resolved_oid, message, sig_bytes) {
                VerifyOutcome::Valid
            } else {
                VerifyOutcome::Invalid
            }
        }
        other => VerifyOutcome::Unsupported(format!(
            "Unsupported signature algorithm OID: {other} (digest: {digest_oid})"
        )),
    }
}

fn compute_two_slice_digest(digest_oid: &str, a: &[u8], b: &[u8]) -> Option<Vec<u8>> {
    match digest_oid {
        "2.16.840.1.101.3.4.2.1" => {
            let mut h = Sha256::new();
            h.update(a);
            h.update(b);
            Some(h.finalize().to_vec())
        }
        "2.16.840.1.101.3.4.2.2" => {
            let mut h = Sha384::new();
            h.update(a);
            h.update(b);
            Some(h.finalize().to_vec())
        }
        "2.16.840.1.101.3.4.2.3" => {
            let mut h = Sha512::new();
            h.update(a);
            h.update(b);
            Some(h.finalize().to_vec())
        }
        "1.3.14.3.2.26" => {
            let mut h = Sha1::new();
            h.update(a);
            h.update(b);
            Some(h.finalize().to_vec())
        }
        _ => None,
    }
}

fn extract_byte_range(dict: &Dictionary) -> Option<[usize; 4]> {
    let arr = dict.get(b"ByteRange").ok()?.as_array().ok()?;
    if arr.len() != 4 {
        return None;
    }
    let mut vals = [0usize; 4];
    for (i, obj) in arr.iter().enumerate() {
        let n = obj.as_i64().ok()?;
        if n < 0 {
            return None;
        }
        vals[i] = n as usize;
    }
    Some(vals)
}

fn evaluate_coverage(raw_pdf: &[u8], br: Option<[usize; 4]>) -> (CoverageStatus, String) {
    let Some([a, b, c, d]) = br else {
        return (
            CoverageStatus::InvalidByteRange,
            "Missing /ByteRange entry.".into(),
        );
    };
    let end1 = match a.checked_add(b) {
        Some(v) => v,
        None => return (CoverageStatus::InvalidByteRange, "ByteRange overflow.".into()),
    };
    let end2 = match c.checked_add(d) {
        Some(v) => v,
        None => return (CoverageStatus::InvalidByteRange, "ByteRange overflow.".into()),
    };
    if a != 0 || b == 0 || end1 >= c || end2 > raw_pdf.len() {
        return (
            CoverageStatus::InvalidByteRange,
            format!(
                "Invalid ByteRange [{a}, {b}, {c}, {d}] for document length {}.",
                raw_pdf.len()
            ),
        );
    }

    let trailing = &raw_pdf[end2..];
    if trailing.iter().all(|b| b.is_ascii_whitespace()) {
        (
            CoverageStatus::FullDocument,
            "Signature covers the entire document revision up to EOF.".into(),
        )
    } else {
        (
            CoverageStatus::IncrementalUpdatesAfterSigning,
            format!(
                "Signature covers bytes 0..{end2}; {} bytes of incremental updates were appended after signing.",
                trailing.len()
            ),
        )
    }
}

/// Computes the exact DER outer TLV length to discard PDF hex-string zero padding safely.
fn trim_der_envelope(raw: &[u8]) -> Option<&[u8]> {
    if raw.len() < 2 || raw[0] != 0x30 {
        return None;
    }
    let len_byte = raw[1];
    let (header_len, content_len) = if (len_byte & 0x80) == 0 {
        (2usize, usize::from(len_byte))
    } else {
        let count = usize::from(len_byte & 0x7F);
        if count == 0 || count > 4 || raw.len() < 2 + count {
            return None;
        }
        let mut len = 0usize;
        for &b in &raw[2..2 + count] {
            len = (len << 8) | usize::from(b);
        }
        (2 + count, len)
    };
    let total = header_len.checked_add(content_len)?;
    if total <= raw.len() {
        Some(&raw[..total])
    } else {
        None
    }
}

fn find_signer_cert_index(
    certs: &[(Certificate, Vec<u8>)],
    sid: &SignerIdentifier,
) -> Option<usize> {
    match sid {
        SignerIdentifier::IssuerAndSerialNumber(ias) => certs.iter().position(|(c, _)| {
            c.tbs_certificate.issuer == ias.issuer
                && c.tbs_certificate.serial_number == ias.serial_number
        }),
        SignerIdentifier::SubjectKeyIdentifier(_) => Some(0),
    }
}

fn build_cert_info(cert: &Certificate, der_bytes: &[u8]) -> CertificateInfo {
    let subject = cert.tbs_certificate.subject.to_string();
    let issuer = cert.tbs_certificate.issuer.to_string();
    let common_name = extract_rdn_attr(&cert.tbs_certificate.subject, "2.5.4.3");
    let organization = extract_rdn_attr(&cert.tbs_certificate.subject, "2.5.4.10");

    let serial_hex = bytes_to_hex(cert.tbs_certificate.serial_number.as_bytes());
    let not_before = cert.tbs_certificate.validity.not_before.to_string();
    let not_after = cert.tbs_certificate.validity.not_after.to_string();

    let mut hasher = Sha256::new();
    hasher.update(der_bytes);
    let fp = bytes_to_colon_hex(&hasher.finalize());

    let key_oid = cert
        .tbs_certificate
        .subject_public_key_info
        .algorithm
        .oid
        .to_string();
    let key_algorithm = friendly_oid_name(&key_oid);

    let pem = der::pem::encode_string(
        "CERTIFICATE",
        der::pem::LineEnding::LF,
        der_bytes,
    )
    .unwrap_or_default();

    CertificateInfo {
        common_name,
        organization,
        subject,
        issuer,
        serial_hex,
        not_before,
        not_after,
        sha256_fingerprint: fp,
        key_algorithm,
        pem,
    }
}

fn extract_rdn_attr(name: &x509_cert::name::Name, target_oid: &str) -> Option<String> {
    for rdn in &name.0 {
        for atv in rdn.0.iter() {
            if atv.oid.to_string() == target_oid {
                if let Ok(bytes) = atv.value.to_der() {
                    // Strip ASN.1 tag + length for printable/UTF8/IA5 string
                    if bytes.len() >= 2 {
                        let len_b = bytes[1];
                        let start = if (len_b & 0x80) == 0 {
                            2
                        } else {
                            2 + usize::from(len_b & 0x7F)
                        };
                        if start <= bytes.len() {
                            return Some(decode_pdf_text_string(&bytes[start..]));
                        }
                    }
                }
            }
        }
    }
    None
}

fn friendly_oid_name(oid: &str) -> String {
    match oid {
        "2.16.840.1.101.3.4.2.1" => "SHA-256".into(),
        "2.16.840.1.101.3.4.2.2" => "SHA-384".into(),
        "2.16.840.1.101.3.4.2.3" => "SHA-512".into(),
        "1.3.14.3.2.26" => "SHA-1".into(),
        "1.2.840.113549.1.1.1" => "RSA".into(),
        "1.2.840.113549.1.1.5" => "RSA (SHA-1)".into(),
        "1.2.840.113549.1.1.10" => "RSA-PSS".into(),
        "1.2.840.113549.1.1.11" => "RSA (SHA-256)".into(),
        "1.2.840.113549.1.1.12" => "RSA (SHA-384)".into(),
        "1.2.840.113549.1.1.13" => "RSA (SHA-512)".into(),
        "1.2.840.10045.2.1" => "ECDSA".into(),
        "1.2.840.10045.4.3.2" => "ECDSA (P-256 / SHA-256)".into(),
        "1.2.840.10045.4.3.3" => "ECDSA (P-384 / SHA-384)".into(),
        other => other.to_string(),
    }
}

fn format_pdf_date(raw: &str) -> String {
    let s = raw.strip_prefix("D:").unwrap_or(raw);
    if s.len() >= 14 {
        let y = &s[0..4];
        let mo = &s[4..6];
        let d = &s[6..8];
        let h = &s[8..10];
        let mi = &s[10..12];
        let sec = &s[12..14];
        let tz = s[14..].replace('\'', ":").trim_end_matches(':').to_string();
        let tz_str = if tz.is_empty() { "Z".to_string() } else { tz };
        format!("{y}-{mo}-{d}T{h}:{mi}:{sec}{tz_str}")
    } else {
        raw.to_string()
    }
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push_str(&format!("{b:02X}"));
    }
    s
}

fn bytes_to_colon_hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}
