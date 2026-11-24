import React from 'react';
import type { Diagnostic, OpenedDocument } from '../types';

interface OutlineSidebarProps {
  document: OpenedDocument;
  onJumpToBlock: (blockId: string) => void;
  onJumpToPage: (pageIndex: number) => void;
}

export const OutlineSidebar: React.FC<OutlineSidebarProps> = ({
  document: doc,
  onJumpToBlock,
  onJumpToPage,
}) => {
  const diagnostics: Diagnostic[] =
    doc.kind === 'pdf' ? doc.inspection.diagnostics : doc.ir.metadata.diagnostics;

  return (
    <aside className="orb-sidebar" aria-label="Document outline">
      <div className="orb-panel-header">
        <span>Outline</span>
      </div>
      <div className="orb-panel-scroll">
        {doc.kind === 'pdf' ? (
          doc.inspection.outline.length > 0 ? (
            <ul className="orb-outline-list">
              {doc.inspection.outline.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="orb-outline-btn"
                    style={{ paddingLeft: `${8 + (item.level - 1) * 12}px` }}
                    onClick={() => {
                      if (item.pageIndex !== null && item.pageIndex !== undefined) {
                        onJumpToPage(item.pageIndex);
                      }
                    }}
                  >
                    <span>{item.title}</span>
                    {item.pageIndex !== null && item.pageIndex !== undefined && (
                      <span className="orb-counter">p.{item.pageIndex + 1}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="orb-empty-note">No PDF bookmarks found.</p>
          )
        ) : doc.ir.outline.length > 0 ? (
          <ul className="orb-outline-list">
            {doc.ir.outline.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="orb-outline-btn"
                  style={{ paddingLeft: `${8 + (item.level - 1) * 12}px` }}
                  onClick={() => onJumpToBlock(item.blockId)}
                >
                  <span>{item.title}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="orb-empty-note">No headings detected in document.</p>
        )}

        <dl className="orb-meta-dl">
          {doc.kind === 'pdf' ? (
            <>
              <dt>PDF Version</dt>
              <dd>{doc.inspection.pdfVersion}</dd>
              <dt>Pages</dt>
              <dd>{doc.inspection.pageCount}</dd>
              {doc.inspection.author && (
                <>
                  <dt>Author</dt>
                  <dd>{doc.inspection.author}</dd>
                </>
              )}
              <dt>Signatures</dt>
              <dd>{doc.inspection.signatures.length}</dd>
              <dt>Form Fields</dt>
              <dd>
                {doc.inspection.formFields.filter((f) => f.fieldType !== 'signature').length}
              </dd>
            </>
          ) : (
            <>
              <dt>Words</dt>
              <dd>{doc.ir.metadata.wordCount.toLocaleString()}</dd>
              <dt>Characters</dt>
              <dd>{doc.ir.metadata.charCount.toLocaleString()}</dd>
              <dt>Blocks</dt>
              <dd>{doc.ir.blocks.length}</dd>
              {doc.ir.metadata.author && (
                <>
                  <dt>Author</dt>
                  <dd>{doc.ir.metadata.author}</dd>
                </>
              )}
              {doc.ir.metadata.subject && (
                <>
                  <dt>Subject</dt>
                  <dd>{doc.ir.metadata.subject}</dd>
                </>
              )}
            </>
          )}
        </dl>

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
};
