import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DocumentIrView } from './components/DocumentIrView';
import { InspectorSidebar } from './components/InspectorSidebar';
import { MarkdownWorkspace } from './components/MarkdownWorkspace';
import { OutlineSidebar } from './components/OutlineSidebar';
import { PdfWorkspace } from './components/PdfWorkspace';
import { Toolbar, type MarkdownViewMode } from './components/Toolbar';
import { WelcomeStage } from './components/WelcomeStage';
import { ThemeProvider, useTheme } from './theme/ThemeProvider';
import type {
  EditOperation,
  FormFieldUpdate,
  FormFieldValue,
  OpenedDocument,
  SampleDescriptor,
} from './types';
import { replaceExtension, triggerBlobDownload } from './utils/download';
import { orbClient } from './worker/client';

const OrbAppInner: React.FC = () => {
  const { resolvedTheme, mode } = useTheme();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mdDebounceRef = useRef<number | null>(null);

  const [samples, setSamples] = useState<SampleDescriptor[]>([]);
  const [loadingSampleId, setLoadingSampleId] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [rawBytes, setRawBytes] = useState<Uint8Array | null>(null);
  const [doc, setDoc] = useState<OpenedDocument | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  // Navigation & view state
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(0);
  const [jumpToPageRequest, setJumpToPageRequest] = useState<{
    page: number;
    nonce: number;
  } | null>(null);
  const [mdMode, setMdMode] = useState<MarkdownViewMode>('split');
  const [wordEditMode, setWordEditMode] = useState(false);
  const [showOutline, setShowOutline] = useState(true);
  const [showInspector, setShowInspector] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<'signatures' | 'forms'>('signatures');

  // Editing & verification state
  const [markdownDraft, setMarkdownDraft] = useState('');
  const [dirtyDoc, setDirtyDoc] = useState(false);
  const [pdfFormValues, setPdfFormValues] = useState<Record<string, FormFieldValue>>({});
  const [pdfDirtyFields, setPdfDirtyFields] = useState<Set<string>>(new Set());
  const [trustedRootsPem, setTrustedRootsPem] = useState<string[]>([]);
  const [exportBusy, setExportBusy] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    orbClient
      .listSamples()
      .then(setSamples)
      .catch((err) => {
        setErrorMsg(`Failed to initialize Rust WASM engine: ${err.message}`);
      });
  }, []);

  const hydrateOpened = useCallback(
    (opened: OpenedDocument, name: string, bytes: Uint8Array) => {
      setFilename(name);
      setRawBytes(bytes);
      setDoc(opened);
      setErrorMsg(null);
      setStatusNotice(null);
      setZoom(1);
      setCurrentPage(0);
      setDirtyDoc(false);
      setWordEditMode(false);
      setPdfDirtyFields(new Set());

      if (opened.kind === 'markdown') {
        setMarkdownDraft(opened.rawMarkdown);
        setMdMode('reading');
        setShowInspector(false);
      } else if (opened.kind === 'word') {
        setShowInspector(opened.ir.metadata.diagnostics.length > 0);
      } else if (opened.kind === 'pdf') {
        const initialForms: Record<string, FormFieldValue> = {};
        for (const f of opened.inspection.formFields) {
          initialForms[f.name] = f.value;
        }
        setPdfFormValues(initialForms);
        if (opened.inspection.hasSignatures) {
          setInspectorTab('signatures');
          setShowInspector(true);
        } else if (opened.inspection.hasForms) {
          setInspectorTab('forms');
          setShowInspector(true);
        } else {
          setShowInspector(false);
        }
      }
    },
    [],
  );

  const openBytes = useCallback(
    async (bytes: Uint8Array, name: string) => {
      setErrorMsg(null);
      try {
        const opened = await orbClient.openDocument(bytes, name, trustedRootsPem);
        hydrateOpened(opened, name, bytes);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    },
    [hydrateOpened, trustedRootsPem],
  );

  const handleFileSelected = async (file: File) => {
    const buffer = await file.arrayBuffer();
    await openBytes(new Uint8Array(buffer), file.name);
  };

  const handleLoadSample = async (sampleId: string) => {
    setLoadingSampleId(sampleId);
    setErrorMsg(null);
    try {
      const sample = await orbClient.generateSample(sampleId);
      await openBytes(sample.bytes, sample.filename);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSampleId(null);
    }
  };

  const handleMarkdownChange = (next: string) => {
    setMarkdownDraft(next);
    setDirtyDoc(true);
    if (mdDebounceRef.current) {
      window.clearTimeout(mdDebounceRef.current);
    }
    mdDebounceRef.current = window.setTimeout(async () => {
      try {
        const ir = await orbClient.parseMarkdownLive(next, filename ?? undefined);
        setDoc((prev) =>
          prev?.kind === 'markdown' ? { kind: 'markdown', ir, rawMarkdown: next } : prev,
        );
      } catch {
        // Ignore transient parse error while typing
      }
    }, 90);
  };

  const handleApplyWordEdit = async (op: EditOperation) => {
    if (!doc || doc.kind !== 'word') return;
    try {
      const updatedIr = await orbClient.applyIrEdit(doc.ir, op);
      setDoc({ ...doc, ir: updatedIr });
      setDirtyDoc(true);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePdfFieldChange = (fieldName: string, value: FormFieldValue) => {
    setPdfFormValues((prev) => ({ ...prev, [fieldName]: value }));
    setPdfDirtyFields((prev) => {
      const next = new Set(prev);
      next.add(fieldName);
      return next;
    });
  };

  const handleResetPdfForms = () => {
    if (!doc || doc.kind !== 'pdf') return;
    const restored: Record<string, FormFieldValue> = {};
    for (const f of doc.inspection.formFields) {
      restored[f.name] = f.value;
    }
    setPdfFormValues(restored);
    setPdfDirtyFields(new Set());
  };

  const handleExportPdf = async () => {
    if (!doc || doc.kind !== 'pdf' || !rawBytes) return;
    setExportBusy(true);
    setErrorMsg(null);
    try {
      const updates: FormFieldUpdate[] = Array.from(pdfDirtyFields).map((fieldName) => ({
        fieldName,
        value: pdfFormValues[fieldName] ?? { kind: 'none' },
      }));
      const exported =
        updates.length > 0 ? await orbClient.exportPdfForms(rawBytes, updates) : rawBytes;
      const outName = filename ? replaceExtension(filename, 'filled.pdf') : 'document.filled.pdf';
      triggerBlobDownload(new Uint8Array(exported), outName, 'application/pdf');

      // Re-open the exported bytes so user immediately sees updated incremental revision & coverage!
      if (updates.length > 0) {
        const inspected = await orbClient.reverifyPdf(exported, outName, trustedRootsPem);
        hydrateOpened({ kind: 'pdf', inspection: inspected }, outName, exported);
        setStatusNotice(
          `Exported ${outName} via PDF incremental update (${updates.length} field(s) saved).`,
        );
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setExportBusy(false);
    }
  };

  const handleExportMarkdown = async () => {
    if (!doc || doc.kind === 'pdf') return;
    setExportBusy(true);
    try {
      const md =
        doc.kind === 'markdown'
          ? markdownDraft
          : await orbClient.exportIrToMarkdown(doc.ir);
      const outName = filename ? replaceExtension(filename, 'md') : 'document.md';
      triggerBlobDownload(md, outName, 'text/markdown;charset=utf-8');
      setDirtyDoc(false);
      setStatusNotice(`Exported ${outName}`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setExportBusy(false);
    }
  };

  const handleExportDocx = async () => {
    if (!doc || doc.kind === 'pdf') return;
    setExportBusy(true);
    try {
      const ir =
        doc.kind === 'markdown'
          ? await orbClient.parseMarkdownLive(markdownDraft, filename ?? undefined)
          : doc.ir;
      const bytes = await orbClient.exportIrToDocx(ir);
      const outName = filename ? replaceExtension(filename, 'docx') : 'document.docx';
      triggerBlobDownload(
        new Uint8Array(bytes),
        outName,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      setDirtyDoc(false);
      setStatusNotice(`Exported clean OOXML archive: ${outName}`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setExportBusy(false);
    }
  };

  const reverifyWithRoots = async (nextRoots: string[]) => {
    setTrustedRootsPem(nextRoots);
    if (doc?.kind === 'pdf' && rawBytes) {
      try {
        const inspection = await orbClient.reverifyPdf(
          rawBytes,
          filename ?? undefined,
          nextRoots,
        );
        setDoc({ kind: 'pdf', inspection });
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const handleJumpToBlock = (blockId: string) => {
    const el = document.getElementById(blockId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const handleJumpToPage = (pageIndex: number) => {
    setCurrentPage(pageIndex);
    setJumpToPageRequest({ page: pageIndex, nonce: Date.now() });
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      await handleFileSelected(file);
    }
  };

  const isDirty = doc?.kind === 'pdf' ? pdfDirtyFields.size > 0 : dirtyDoc;

  return (
    <div
      className={`orb-shell ${isDragging ? 'is-dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!isDragging) setIsDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setIsDragging(false);
      }}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        id="orb-hidden-file-input"
        type="file"
        accept=".pdf,.docx,.doc,.md,.markdown,.txt"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            void handleFileSelected(file);
          }
          e.target.value = '';
        }}
      />

      <Toolbar
        filename={filename}
        document={doc}
        dirty={isDirty}
        zoom={zoom}
        onZoomChange={setZoom}
        currentPage={currentPage}
        pageCount={doc?.kind === 'pdf' ? doc.inspection.pageCount : 0}
        onPageChange={handleJumpToPage}
        mdMode={mdMode}
        onMdModeChange={setMdMode}
        wordEditMode={wordEditMode}
        onWordEditModeChange={setWordEditMode}
        showOutline={showOutline}
        onToggleOutline={() => setShowOutline((v) => !v)}
        showInspector={showInspector}
        onToggleInspector={() => setShowInspector((v) => !v)}
        onOpenFileClick={() => fileInputRef.current?.click()}
        onGoHome={() => {
          setDoc(null);
          setFilename(null);
          setRawBytes(null);
          setErrorMsg(null);
          setStatusNotice(null);
        }}
        onExportPdf={handleExportPdf}
        onExportMarkdown={handleExportMarkdown}
        onExportDocx={handleExportDocx}
        exportBusy={exportBusy}
      />

      {errorMsg && (
        <div className="orb-banner danger" role="alert">
          <span>{errorMsg}</span>
          <button type="button" className="orb-btn ghost" onClick={() => setErrorMsg(null)}>
            Dismiss
          </button>
        </div>
      )}

      {statusNotice && (
        <div className="orb-banner positive" role="status">
          <span>{statusNotice}</span>
          <button
            type="button"
            className="orb-btn ghost"
            onClick={() => setStatusNotice(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {!doc ? (
        <WelcomeStage
          samples={samples}
          loadingSampleId={loadingSampleId}
          onOpenFileClick={() => fileInputRef.current?.click()}
          onLoadSample={handleLoadSample}
        />
      ) : (
        <div className="orb-main">
          {showOutline && (
            <OutlineSidebar
              document={doc}
              onJumpToBlock={handleJumpToBlock}
              onJumpToPage={handleJumpToPage}
            />
          )}

          <main className="orb-stage">
            {doc.kind === 'markdown' && (
              <MarkdownWorkspace
                markdown={markdownDraft}
                ir={doc.ir}
                mode={mdMode}
                zoom={zoom}
                onChangeMarkdown={handleMarkdownChange}
              />
            )}

            {doc.kind === 'word' && (
              <>
                {wordEditMode && (
                  <div className="orb-banner warning">
                    <span>
                      Editing Canonical IR — click any heading, paragraph, list item, or table cell
                      to edit. Use Export .docx or .md to save a clean copy.
                    </span>
                  </div>
                )}
                <DocumentIrView
                  ir={doc.ir}
                  zoom={zoom}
                  editable={wordEditMode}
                  onApplyEdit={handleApplyWordEdit}
                />
              </>
            )}

            {doc.kind === 'pdf' && rawBytes && (
              <PdfWorkspace
                rawPdf={rawBytes}
                inspection={doc.inspection}
                zoom={zoom}
                jumpToPageRequest={jumpToPageRequest}
                formValues={pdfFormValues}
                dirtyFields={pdfDirtyFields}
                onFieldChange={handlePdfFieldChange}
                onVisiblePageChange={setCurrentPage}
                onSelectSignature={() => {
                  setInspectorTab('signatures');
                  setShowInspector(true);
                }}
              />
            )}
          </main>

          {showInspector && (
            <InspectorSidebar
              document={doc}
              activeTab={inspectorTab}
              onTabChange={setInspectorTab}
              formValues={pdfFormValues}
              dirtyFields={pdfDirtyFields}
              trustedRootsPem={trustedRootsPem}
              onAddTrustedRoot={(pem) => {
                if (!trustedRootsPem.includes(pem)) {
                  void reverifyWithRoots([...trustedRootsPem, pem]);
                }
              }}
              onClearTrustedRoots={() => void reverifyWithRoots([])}
              onJumpToPage={handleJumpToPage}
              onResetFormEdits={handleResetPdfForms}
              onExportPdf={handleExportPdf}
              exportBusy={exportBusy}
            />
          )}
        </div>
      )}

      <footer className="orb-statusbar">
        <div className="orb-statusbar-group">
          <span>Rust/WASM Core · Client-Side Only</span>
          {doc?.kind === 'pdf' && (
            <span>
              PDF {doc.inspection.pdfVersion} · {doc.inspection.pageCount} page(s) ·{' '}
              {doc.inspection.signatures.length} signature(s)
            </span>
          )}
          {(doc?.kind === 'markdown' || doc?.kind === 'word') && (
            <span>
              {doc.ir.metadata.wordCount.toLocaleString()} words ·{' '}
              {doc.ir.blocks.length} blocks
            </span>
          )}
        </div>
        <div className="orb-statusbar-group">
          <span>
            Theme: {mode} ({resolvedTheme.name}) · 6-color palette
          </span>
        </div>
      </footer>
    </div>
  );
};

export const App: React.FC = () => (
  <ThemeProvider>
    <OrbAppInner />
  </ThemeProvider>
);
