use der::{Decode, DecodePem, Encode};
use p256::ecdsa::{Signature as P256Sig, VerifyingKey as P256Key};
use p384::ecdsa::{Signature as P384Sig, VerifyingKey as P384Key};
use rsa::pkcs1v15::{Signature as RsaSig, VerifyingKey as RsaVerifyingKey};
use rsa::RsaPublicKey;
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Sha256, Sha384, Sha512};
use signature::Verifier;
use spki::DecodePublicKey;
use x509_cert::Certificate;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrustStatus {
    TrustedByUserRoot,
    SelfSigned,
    UnverifiedIssuer,
    InvalidCertificate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustEvaluation {
    pub status: TrustStatus,
    pub detail: String,
    pub matched_root_subject: Option<String>,
}

/// Platform-portable certificate trust evaluation boundary.
///
/// Web builds use `WebTrustProvider` (explicit identity warnings + optional user-imported PEM roots).
/// Future native Windows/macOS apps plug in OS trust stores (CryptoAPI / Security.framework).
pub trait CertificateTrustProvider {
    fn evaluate_chain(&self, chain_der: &[Vec<u8>]) -> TrustEvaluation;
}

#[derive(Debug, Default)]
pub struct WebTrustProvider {
    roots: Vec<Certificate>,
}

impl WebTrustProvider {
    pub fn from_pem_list(pems: &[String]) -> Self {
        let mut roots = Vec::new();
        for pem in pems {
            let trimmed = pem.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Support multiple concatenated PEM blocks
            for chunk in trimmed.split("-----END CERTIFICATE-----") {
                if let Some(start) = chunk.find("-----BEGIN CERTIFICATE-----") {
                    let block = format!("{}-----END CERTIFICATE-----", &chunk[start..]);
                    if let Ok(cert) = Certificate::from_pem(&block) {
                        roots.push(cert);
                    }
                }
            }
        }
        Self { roots }
    }
}

impl CertificateTrustProvider for WebTrustProvider {
    fn evaluate_chain(&self, chain_der: &[Vec<u8>]) -> TrustEvaluation {
        let Some(leaf_der) = chain_der.first() else {
            return TrustEvaluation {
                status: TrustStatus::InvalidCertificate,
                detail: "No X.509 certificate embedded in signature.".into(),
                matched_root_subject: None,
            };
        };

        let Ok(leaf) = Certificate::from_der(leaf_der) else {
            return TrustEvaluation {
                status: TrustStatus::InvalidCertificate,
                detail: "Embedded signer certificate could not be parsed as X.509 DER.".into(),
            matched_root_subject: None,
            };
        };

        // Check against user-imported trusted root certificates
        for root in &self.roots {
            if let Ok(root_der) = root.to_der() {
                if &root_der == leaf_der {
                    return TrustEvaluation {
                        status: TrustStatus::TrustedByUserRoot,
                        detail: "Signer certificate directly matches a user-imported trusted root certificate.".into(),
                        matched_root_subject: Some(root.tbs_certificate.subject.to_string()),
                    };
                }
            }
            if leaf.tbs_certificate.issuer == root.tbs_certificate.subject
                && verify_cert_signed_by(&leaf, root)
            {
                return TrustEvaluation {
                    status: TrustStatus::TrustedByUserRoot,
                    detail: "Certificate chain verified against a user-imported trusted root CA.".into(),
                    matched_root_subject: Some(root.tbs_certificate.subject.to_string()),
                };
            }
            // Check intermediate certificates in chain
            for cert_der in chain_der.iter().skip(1) {
                if let Ok(inter) = Certificate::from_der(cert_der) {
                    if inter.tbs_certificate.issuer == root.tbs_certificate.subject
                        && verify_cert_signed_by(&inter, root)
                        && verify_cert_signed_by(&leaf, &inter)
                    {
                        return TrustEvaluation {
                            status: TrustStatus::TrustedByUserRoot,
                            detail: "Certificate chain (via intermediate) verified against a user-imported trusted root CA.".into(),
                            matched_root_subject: Some(root.tbs_certificate.subject.to_string()),
                        };
                    }
                }
            }
        }

        if leaf.tbs_certificate.issuer == leaf.tbs_certificate.subject {
            TrustEvaluation {
                status: TrustStatus::SelfSigned,
                detail: "Certificate is self-signed and not in the trusted root list. Import its PEM certificate to mark it trusted.".into(),
                matched_root_subject: None,
            }
        } else {
            TrustEvaluation {
                status: TrustStatus::UnverifiedIssuer,
                detail: "Browser sandbox has no OS trust-store access; import the issuing root CA PEM to verify chain trust.".into(),
                matched_root_subject: None,
            }
        }
    }
}

pub(crate) fn verify_cert_signed_by(subject: &Certificate, issuer: &Certificate) -> bool {
    let Ok(tbs_der) = subject.tbs_certificate.to_der() else {
        return false;
    };
    let sig_bytes = subject.signature.raw_bytes();
    let spki_der = match issuer.tbs_certificate.subject_public_key_info.to_der() {
        Ok(b) => b,
        Err(_) => return false,
    };
    let oid = subject.signature_algorithm.oid;
    verify_raw_signature(&spki_der, &oid.to_string(), &tbs_der, sig_bytes)
}

pub(crate) fn verify_raw_signature(
    spki_der: &[u8],
    sig_alg_oid: &str,
    message: &[u8],
    sig_bytes: &[u8],
) -> bool {
    match sig_alg_oid {
        // sha256WithRSAEncryption
        "1.2.840.113549.1.1.11" => {
            let Ok(pub_key) = RsaPublicKey::from_public_key_der(spki_der) else {
                return false;
            };
            let vk = RsaVerifyingKey::<Sha256>::new(pub_key);
            let Ok(sig) = RsaSig::try_from(sig_bytes) else {
                return false;
            };
            vk.verify(message, &sig).is_ok()
        }
        // sha384WithRSAEncryption
        "1.2.840.113549.1.1.12" => {
            let Ok(pub_key) = RsaPublicKey::from_public_key_der(spki_der) else {
                return false;
            };
            let vk = RsaVerifyingKey::<Sha384>::new(pub_key);
            let Ok(sig) = RsaSig::try_from(sig_bytes) else {
                return false;
            };
            vk.verify(message, &sig).is_ok()
        }
        // sha512WithRSAEncryption
        "1.2.840.113549.1.1.13" => {
            let Ok(pub_key) = RsaPublicKey::from_public_key_der(spki_der) else {
                return false;
            };
            let vk = RsaVerifyingKey::<Sha512>::new(pub_key);
            let Ok(sig) = RsaSig::try_from(sig_bytes) else {
                return false;
            };
            vk.verify(message, &sig).is_ok()
        }
        // sha1WithRSAEncryption
        "1.2.840.113549.1.1.5" => {
            let Ok(pub_key) = RsaPublicKey::from_public_key_der(spki_der) else {
                return false;
            };
            let vk = RsaVerifyingKey::<Sha1>::new(pub_key);
            let Ok(sig) = RsaSig::try_from(sig_bytes) else {
                return false;
            };
            vk.verify(message, &sig).is_ok()
        }
        // ecdsa-with-SHA256
        "1.2.840.10045.4.3.2" => {
            let Ok(vk) = P256Key::from_public_key_der(spki_der) else {
                return false;
            };
            if let Ok(sig) = P256Sig::from_der(sig_bytes) {
                if vk.verify(message, &sig).is_ok() {
                    return true;
                }
            }
            if let Ok(sig) = P256Sig::from_slice(sig_bytes) {
                return vk.verify(message, &sig).is_ok();
            }
            false
        }
        // ecdsa-with-SHA384
        "1.2.840.10045.4.3.3" => {
            let Ok(vk) = P384Key::from_public_key_der(spki_der) else {
                return false;
            };
            if let Ok(sig) = P384Sig::from_der(sig_bytes) {
                if vk.verify(message, &sig).is_ok() {
                    return true;
                }
            }
            if let Ok(sig) = P384Sig::from_slice(sig_bytes) {
                return vk.verify(message, &sig).is_ok();
            }
            false
        }
        _ => false,
    }
}
