import React, { useState } from 'react';
import type {
  FormFieldValue,
  OpenedDocument,
  PdfFormField,
  PdfSignatureReport,
} from '../types';
import { DownloadIcon, ShieldAlertIcon, ShieldCheckIcon } from './Icons';

interface InspectorSidebarProps {
  document: OpenedDocument;
  activeTab: 'signatures' | 'forms';
  onTabChange: (tab: 'signatures' | 'forms') => void;
  formValues: Record<string, FormFieldValue>;
  dirtyFields: Set<string>;
  trustedRootsPem: string[];
  onAddTrustedRoot: (pem: string) => void;
  onClearTrustedRoots: () => void;
  onJumpToPage: (pageIndex: number) => void;
  onResetFormEdits: () => void;
  onExportPdf: () => void;
  exportBusy: boolean;
}

function integrityBadge(sig: PdfSignatureReport): { cls: string; label: string } {
  switch (sig.integrity) {
    case 'valid':
      return { cls: 'positive', label: 'Integrity Valid' };
    case 'invalid':
      return { cls: 'danger', label: 'Tampered / Invalid' };
    case 'unsupportedAlgorithm':
      return { cls: 'warning', label: 'Unsupported Alg' };
    default:
      return { cls: 'danger', label: 'Parse Error' };
  }
}

function coverageBadge(sig: PdfSignatureReport): { cls: string; label: string } {
  switch (sig.coverage) {
    case 'fullDocument':
      return { cls: 'positive', label: 'Full Document' };
    case 'incrementalUpdatesAfterSigning':
      return { cls: 'warning', label: 'Modified After Signing' };
    default:
      return { cls: 'danger', label: 'Invalid ByteRange' };
  }
}

function trustBadge(sig: PdfSignatureReport): { cls: string; label: string } {
  switch (sig.trust.status) {
    case 'trustedByUserRoot':
      return { cls: 'positive', label: 'Trusted Root' };
    case 'selfSigned':
      return { cls: 'warning', label: 'Self-Signed' };
    case 'unverifiedIssuer':
      return { cls: 'warning', label: 'Issuer Unverified' };
    default:
      return { cls: 'danger', label: 'Invalid Cert' };
  }
}

function formatFieldDisplay(val: FormFieldValue | undefined): string {
  if (!val || val.kind === 'none') return '—';
  if (val.kind === 'bool') return val.value ? 'Checked' : 'Unchecked';
  return val.value || 'Empty';
}

export const InspectorSidebar: React.FC<InspectorSidebarProps> = ({
  document: doc,
  activeTab,
  onTabChange,
  formValues,
  dirtyFields,
  trustedRootsPem,
  onAddTrustedRoot,
  onClearTrustedRoots,
  onJumpToPage,
  onResetFormEdits,
  onExportPdf,
  exportBusy,
}) => {
  const [pemDraft, setPemDraft] = useState('');
  const [expandedCertId, setExpandedCertId] = useState<string | null>(null);

  if (doc.kind !== 'pdf') {
    const diagnostics = doc.ir.metadata.diagnostics;
    return (
      <aside className="orb-inspector" aria-label="Document inspector">
        <div className="orb-panel-header">
          <span>Document Inspector</span>
        </div>
        <div className="orb-panel-scroll">
          <div className="orb-sig-card">
            <div className="orb-sig-name">Canonical IR v{doc.ir.version}</div>
            <div className="orb-sig-sub">
              Source: <strong>{doc.ir.sourceFormat.toUpperCase()}</strong>
            </div>
            <div className="orb-sig-row">
              <span className="orb-sig-row-label">Structure</span>
              <span>
                {doc.ir.blocks.length} blocks · {doc.ir.outline.length} outline entries ·{' '}
                {doc.ir.assets.length} embedded media
              </span>
            </div>
            <div className="orb-sig-row">
              <span className="orb-sig-row-label">Long-Term Archival Export</span>
              <span>
                Export edits as standards-compliant OOXML (.docx) or plain-text Markdown (.md)
                without mutating the original archive.
              </span>
            </div>
          </div>

          {diagnostics.length > 0 && (
            <div className="orb-diag-list">
              {diagnostics.map((d, idx) => (
                <div key={`${d.code}-${idx}`} className={`orb-diag-card ${d.severity}`}>
                  <span className="orb-diag-code">{d.code}</span>
                  {d.message}
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    );
  }

  const { signatures, formFields } = doc.inspection;
  const interactiveFields: PdfFormField[] = formFields.filter((f) => f.fieldType !== 'signature');

  return (
    <aside className="orb-inspector" aria-label="PDF signatures and forms inspector">
      <div className="orb-tabs" role="tablist">
        <button
          id="orb-inspector-tab-signatures"
          type="button"
          role="tab"
          aria-selected={activeTab === 'signatures'}
          className={`orb-tab ${activeTab === 'signatures' ? 'is-active' : ''}`}
          onClick={() => onTabChange('signatures')}
        >
          Signatures ({signatures.length})
        </button>
        <button
          id="orb-inspector-tab-forms"
          type="button"
          role="tab"
          aria-selected={activeTab === 'forms'}
          className={`orb-tab ${activeTab === 'forms' ? 'is-active' : ''}`}
          onClick={() => onTabChange('forms')}
        >
          Forms ({interactiveFields.length})
        </button>
      </div>

      <div className="orb-panel-scroll">
        {activeTab === 'signatures' && (
          <>
            {signatures.length === 0 ? (
              <p className="orb-empty-note">No digital signatures found in this PDF.</p>
            ) : (
              signatures.map((sig) => {
                const integ = integrityBadge(sig);
                const cov = coverageBadge(sig);
                const trust = trustBadge(sig);
                const cert = sig.signerCertificate;
                const certOpen = expandedCertId === sig.id;

                return (
                  <section key={sig.id} className="orb-sig-card" aria-label={sig.fieldName}>
                    <div className="orb-sig-header">
                      <div>
                        <div className="orb-sig-name">
                          {sig.signerName ?? sig.fieldName}
                        </div>
                        <div className="orb-sig-sub">
                          Field: {sig.fieldName}
                          {sig.pageIndex !== null && sig.pageIndex !== undefined
                            ? ` · Page ${sig.pageIndex + 1}`
                            : ''}
                        </div>
                      </div>
                      <span className={`orb-badge ${integ.cls}`}>
                        {sig.integrity === 'valid' ? (
                          <ShieldCheckIcon size={12} />
                        ) : (
                          <ShieldAlertIcon size={12} />
                        )}
                        {integ.label}
                      </span>
                    </div>

                    <div className="orb-sig-row">
                      <span className="orb-sig-row-label">1. Cryptographic Integrity</span>
                      <span>{sig.integrityDetail}</span>
                    </div>

                    <div className="orb-sig-row">
                      <span className="orb-sig-row-label">2. Document Coverage</span>
                      <div>
                        <span className={`orb-badge ${cov.cls}`}>{cov.label}</span>
                      </div>
                      <span>{sig.coverageDetail}</span>
                    </div>

                    <div className="orb-sig-row">
                      <span className="orb-sig-row-label">3. Certificate Trust</span>
                      <div>
                        <span className={`orb-badge ${trust.cls}`}>{trust.label}</span>
                      </div>
                      <span>{sig.trust.detail}</span>
                    </div>

                    {(sig.reason || sig.location || sig.signingTime || sig.subFilter) && (
                      <div className="orb-sig-row">
                        <span className="orb-sig-row-label">Attestation Metadata</span>
                        {sig.reason && <div>Reason: {sig.reason}</div>}
                        {sig.location && <div>Location: {sig.location}</div>}
                        {sig.signingTime && <div>Signed: {sig.signingTime}</div>}
                        {sig.subFilter && <div>SubFilter: {sig.subFilter}</div>}
                        {sig.digestAlgorithm && sig.signatureAlgorithm && (
                          <div>
                            Algorithms: {sig.digestAlgorithm} / {sig.signatureAlgorithm}
                          </div>
                        )}
                      </div>
                    )}

                    {cert && (
                      <div className="orb-sig-row">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span className="orb-sig-row-label">X.509 Certificate</span>
                          <button
                            type="button"
                            className="orb-btn ghost"
                            onClick={() => setExpandedCertId(certOpen ? null : sig.id)}
                          >
                            {certOpen ? 'Hide Details' : 'Inspect Cert'}
                          </button>
                        </div>
                        {certOpen && (
                          <>
                            <div className="orb-mono-block">
                              <div>Subject: {cert.subject}</div>
                              <div>Issuer: {cert.issuer}</div>
                              <div>Serial: {cert.serialHex}</div>
                              <div>Valid: {cert.notBefore} → {cert.notAfter}</div>
                              <div>Key: {cert.keyAlgorithm}</div>
                              <div>SHA-256: {cert.sha256Fingerprint}</div>
                            </div>
                            {sig.trust.status !== 'trustedByUserRoot' && cert.pem && (
                              <button
                                id={`orb-trust-cert-${sig.id}`}
                                type="button"
                                className="orb-btn"
                                onClick={() => onAddTrustedRoot(cert.pem)}
                              >
                                Trust This Certificate (Session)
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </section>
                );
              })
            )}

            <div className="orb-sig-card">
              <div className="orb-sig-name">Trusted Root CA Store (Web Session)</div>
              <div className="orb-sig-sub">
                Browser WASM cannot read OS certificate stores. Paste a PEM root certificate
                below to verify chains locally ({trustedRootsPem.length} loaded).
              </div>
              <textarea
                id="orb-pem-input"
                className="orb-pem-box"
                placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                value={pemDraft}
                onChange={(e) => setPemDraft(e.target.value)}
              />
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  id="orb-add-root-btn"
                  type="button"
                  className="orb-btn"
                  disabled={!pemDraft.includes('BEGIN CERTIFICATE')}
                  onClick={() => {
                    onAddTrustedRoot(pemDraft);
                    setPemDraft('');
                  }}
                >
                  Add Trusted PEM
                </button>
                {trustedRootsPem.length > 0 && (
                  <button
                    type="button"
                    className="orb-btn ghost"
                    onClick={onClearTrustedRoots}
                  >
                    Clear ({trustedRootsPem.length})
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {activeTab === 'forms' && (
          <>
            {interactiveFields.length === 0 ? (
              <p className="orb-empty-note">No fillable AcroForm fields found in this PDF.</p>
            ) : (
              <>
                <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
                  <button
                    type="button"
                    className="orb-btn primary"
                    style={{ flex: 1 }}
                    disabled={exportBusy}
                    onClick={onExportPdf}
                  >
                    <DownloadIcon />
                    Export Filled PDF
                  </button>
                  <button
                    type="button"
                    className="orb-btn"
                    disabled={dirtyFields.size === 0}
                    onClick={onResetFormEdits}
                  >
                    Reset
                  </button>
                </div>

                {interactiveFields.map((field) => {
                  const isDirty = dirtyFields.has(field.name);
                  const val = formValues[field.name] ?? field.value;
                  return (
                    <div key={field.id} className="orb-form-list-item">
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span>{field.name}</span>
                          {isDirty && <span className="orb-badge warning">Edited</span>}
                        </div>
                        <div className="orb-sig-sub">
                          {field.fieldType} · p.{field.pageIndex + 1} · {formatFieldDisplay(val)}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="orb-btn ghost"
                        onClick={() => onJumpToPage(field.pageIndex)}
                      >
                        Go
                      </button>
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
};
