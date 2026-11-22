import React from 'react';
import type { SampleDescriptor } from '../types';
import { FileDocIcon, UploadIcon } from './Icons';

interface WelcomeStageProps {
  samples: SampleDescriptor[];
  loadingSampleId: string | null;
  onOpenFileClick: () => void;
  onLoadSample: (sampleId: string) => void;
}

export const WelcomeStage: React.FC<WelcomeStageProps> = ({
  samples,
  loadingSampleId,
  onOpenFileClick,
  onLoadSample,
}) => {
  return (
    <main className="orb-welcome">
      <div className="orb-welcome-inner">
        <div className="orb-welcome-hero">
          <h1>Orb Document Studio</h1>
          <p>
            Static, client-side viewer and editor for PDF (with cryptographic signature inspection
            and AcroForm filling), Microsoft Word (.docx &amp; legacy .doc), and Markdown. Every
            file is processed locally in Rust WebAssembly.
          </p>
        </div>

        <div
          id="orb-welcome-dropzone"
          className="orb-dropzone"
          role="button"
          tabIndex={0}
          onClick={onOpenFileClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpenFileClick();
            }
          }}
        >
          <div className="orb-dropzone-text">
            <h2>Open a document from your device</h2>
            <p>Drag and drop anywhere, or click to browse — PDF, .docx, .doc, or .md</p>
          </div>
          <span className="orb-btn primary">
            <UploadIcon size={14} />
            Choose File
          </span>
        </div>

        <h3 className="orb-section-label">Built-In Verification Fixtures</h3>
        <div className="orb-sample-list">
          {samples.map((sample) => {
            const busy = loadingSampleId === sample.id;
            return (
              <button
                key={sample.id}
                id={`orb-sample-${sample.id}`}
                type="button"
                className="orb-sample-item"
                disabled={loadingSampleId !== null}
                onClick={() => onLoadSample(sample.id)}
              >
                <div className="orb-sample-top">
                  <span className="orb-sample-title">
                    {busy ? 'Generating…' : sample.label}
                  </span>
                  <span className="orb-format-tag">{sample.format}</span>
                </div>
                <span className="orb-sample-desc">{sample.description}</span>
              </button>
            );
          })}
          {samples.length === 0 && (
            <div className="orb-empty-note">
              <FileDocIcon size={14} /> Loading WASM core…
            </div>
          )}
        </div>
      </div>
    </main>
  );
};
