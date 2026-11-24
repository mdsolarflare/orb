import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  computeReplaceCurrentOp,
  DocumentIrView,
  type DocumentEditorHandle,
  type EditorSelectionState,
} from './components/DocumentIrView';
import { EditorTopBar } from './components/EditorTopBar';
import { InspectorSidebar } from './components/InspectorSidebar';
import { MarkdownWorkspace } from './components/MarkdownWorkspace';
import { OutlineSidebar } from './components/OutlineSidebar';
import { PdfWorkspace } from './components/PdfWorkspace';
import { Toolbar, type MarkdownViewMode } from './components/Toolbar';
import { WelcomeStage } from './components/WelcomeStage';
import { ThemeProvider, useTheme } from './theme/ThemeProvider';
import type {
  Block,
  DocumentIr,
  EditOperation,
  FormFieldUpdate,
  FormFieldValue,
  OpenedDocument,
  SampleDescriptor,
} from './types';
import { replaceExtension, triggerBlobDownload } from './utils/download';
import { orbClient } from './worker/client';

const MAX_UNDO_DEPTH = 60;

const EMPTY_SELECTION: EditorSelectionState = {
  activeBlockId: null,
  blockType: null,
  headingLevel: null,
  listKind: null,
  align: 'left',
  indentLevel: 0,
  canAlign: false,
  canIndent: false,
  inTable: false,
  tableRow: null,
  tableCol: null,
  tableRowCount: 0,
  tableColCount: 0,
  textStyle: {},
  hasTextSelection: false,
  selectedText: '',
  activeLinkText: '',
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.readAsDataURL(file);
  });
}

function makeBlockUid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

interface HistoryEntry {
  ir: DocumentIr;
  filename: string | null;
}

interface EnqueueWordOpsOptions {
  syncDom?: boolean;
  skipIfUnchanged?: boolean;
  afterFilename?: string;
  skipIfRenameNoop?: boolean;
  onResult?: (changed: boolean) => void;
}

const OrbAppInner: React.FC = () => {
  const { resolvedTheme, mode } = useTheme();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const mdDebounceRef = useRef<number | null>(null);
  const editorRef = useRef<DocumentEditorHandle | null>(null);
  const docRef = useRef<OpenedDocument | null>(null);
  const filenameRef = useRef<string | null>(null);
  const editQueueRef = useRef<Promise<void>>(Promise.resolve());
  const docSessionIdRef = useRef(0);
  const openRequestIdRef = useRef(0);
  const exportRequestIdRef = useRef(0);
  const exportBusyRef = useRef(false);
  const replaceRequestIdRef = useRef(0);
  const replaceBusyRef = useRef(false);
  const rawBytesRef = useRef<Uint8Array | null>(null);
  const trustedRootsPemRef = useRef<string[]>([]);
  const reverifyRequestIdRef = useRef(0);
  const pdfEditRevRef = useRef(0);
  const pdfFieldEditRevsRef = useRef<Map<string, number>>(new Map());
  const findActiveIndexRef = useRef(0);
  const markdownDraftRef = useRef('');
  const undoStackRef = useRef<HistoryEntry[]>([]);
  const redoStackRef = useRef<HistoryEntry[]>([]);

  const [docSessionId, setDocSessionId] = useState(0);
  const [externalSyncRev, setExternalSyncRev] = useState(0);
  const [samples, setSamples] = useState<SampleDescriptor[]>([]);
  const [samplesStatus, setSamplesStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadingSampleId, setLoadingSampleId] = useState<string | null>(null);
  const [creatingDoc, setCreatingDoc] = useState(false);
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
  const [wordEditMode, setWordEditMode] = useState(true);
  const [showFormattingBar, setShowFormattingBar] = useState(true);
  const [showOutline, setShowOutline] = useState(true);
  const [showInspector, setShowInspector] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<'signatures' | 'forms'>('signatures');

  // Editor state
  const [autoFocusNonce, setAutoFocusNonce] = useState(0);
  const [editorSelection, setEditorSelection] = useState<EditorSelectionState>(EMPTY_SELECTION);
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [findFocusNonce, setFindFocusNonce] = useState(0);
  const [findFocusTarget, setFindFocusTarget] = useState<'find' | 'replace'>('find');
  const [findQuery, setFindQuery] = useState('');
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findMatchCount, setFindMatchCount] = useState(0);
  const [findActiveIndex, setFindActiveIndex] = useState(0);
  const [replaceBusy, setReplaceBusy] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  // Editing & verification state
  const [markdownDraft, setMarkdownDraft] = useState('');
  const [dirtyDoc, setDirtyDoc] = useState(false);
  const [pdfFormValues, setPdfFormValues] = useState<Record<string, FormFieldValue>>({});
  const [pdfDirtyFields, setPdfDirtyFields] = useState<Set<string>>(new Set());
  const [trustedRootsPem, setTrustedRootsPem] = useState<string[]>([]);
  const [exportBusy, setExportBusy] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  docRef.current = doc;
  rawBytesRef.current = rawBytes;
  trustedRootsPemRef.current = trustedRootsPem;
  findActiveIndexRef.current = findActiveIndex;
  markdownDraftRef.current = markdownDraft;
  const isDirty = doc?.kind === 'pdf' ? pdfDirtyFields.size > 0 : dirtyDoc;

  const clearMarkdownDebounce = useCallback(() => {
    if (mdDebounceRef.current !== null) {
      window.clearTimeout(mdDebounceRef.current);
      mdDebounceRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearMarkdownDebounce();
    };
  }, [clearMarkdownDebounce]);

  useEffect(() => {
    orbClient
      .listSamples()
      .then((list) => {
        setSamples(list);
        setSamplesStatus('ready');
      })
      .catch((err) => {
        setSamplesStatus('error');
        setErrorMsg(`Failed to initialize Rust WASM engine: ${err.message}`);
      });
  }, []);

  const confirmDiscardIfDirty = useCallback((): boolean => {
    const hasPending = Boolean(editorRef.current?.hasPendingEdits());
    if (!isDirty && !hasPending) return true;
    return window.confirm('You have unsaved edits. Discard them and continue?');
  }, [isDirty]);

  const resetHistory = useCallback(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    setUndoStack([]);
    setRedoStack([]);
  }, []);

  const hydrateOpened = useCallback(
    (
      opened: OpenedDocument,
      name: string,
      bytes: Uint8Array | null,
      options?: { isNewBlank?: boolean },
    ) => {
      // Discard any pending debounce timers from previous document and bump session id
      clearMarkdownDebounce();
      editorRef.current?.discardPendingEdits();
      exportRequestIdRef.current += 1;
      exportBusyRef.current = false;
      setExportBusy(false);
      replaceRequestIdRef.current += 1;
      replaceBusyRef.current = false;
      setReplaceBusy(false);
      reverifyRequestIdRef.current += 1;
      pdfEditRevRef.current = 0;
      pdfFieldEditRevsRef.current.clear();
      setCreatingDoc(false);
      setLoadingSampleId(null);
      docSessionIdRef.current += 1;
      setDocSessionId(docSessionIdRef.current);

      filenameRef.current = name;
      setFilename(name);
      rawBytesRef.current = bytes;
      setRawBytes(bytes);
      setDoc(opened);
      docRef.current = opened;
      setErrorMsg(null);
      setStatusNotice(null);
      setZoom(1);
      setCurrentPage(0);
      setDirtyDoc(false);
      resetHistory();
      setFindOpen(false);
      setFindQuery('');
      setFindCaseSensitive(false);
      setFindMatchCount(0);
      setFindActiveIndex(0);
      setLinkOpen(false);
      setEditorSelection(EMPTY_SELECTION);
      setPdfDirtyFields(new Set());

      if (opened.kind === 'markdown') {
        setMarkdownDraft(opened.rawMarkdown);
        setMdMode('reading');
        setShowOutline(true);
        setShowInspector(false);
      } else if (opened.kind === 'word') {
        const isBlank = Boolean(options?.isNewBlank);
        setWordEditMode(true);
        setShowFormattingBar(true);
        setShowOutline(!isBlank && opened.ir.outline.length > 0);
        setShowInspector(!isBlank && opened.ir.metadata.diagnostics.length > 0);
        if (isBlank) {
          setAutoFocusNonce((n) => n + 1);
        }
      } else if (opened.kind === 'pdf') {
        setShowOutline(true);
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
    [clearMarkdownDebounce, resetHistory],
  );

  const handleNewDocument = useCallback(async () => {
    if (!confirmDiscardIfDirty()) return;
    const reqId = ++openRequestIdRef.current;
    setLoadingSampleId(null);
    setCreatingDoc(true);
    setErrorMsg(null);
    try {
      const opened = await orbClient.createBlankDocument('Untitled');
      if (openRequestIdRef.current !== reqId) return;
      hydrateOpened(opened, 'Untitled.docx', null, { isNewBlank: true });
    } catch (err) {
      if (openRequestIdRef.current !== reqId) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (openRequestIdRef.current === reqId) {
        setCreatingDoc(false);
      }
    }
  }, [confirmDiscardIfDirty, hydrateOpened]);

  const openBytes = useCallback(
    async (bytes: Uint8Array, name: string, existingReqId?: number) => {
      const reqId = existingReqId ?? ++openRequestIdRef.current;
      setErrorMsg(null);
      try {
        const opened = await orbClient.openDocument(bytes, name, trustedRootsPem);
        if (openRequestIdRef.current !== reqId) return;
        hydrateOpened(opened, name, bytes);
      } catch (err) {
        if (openRequestIdRef.current !== reqId) return;
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    },
    [hydrateOpened, trustedRootsPem],
  );

  const handleFileSelected = async (file: File) => {
    if (!confirmDiscardIfDirty()) return;
    const reqId = ++openRequestIdRef.current;
    setCreatingDoc(false);
    setLoadingSampleId(null);
    setErrorMsg(null);
    try {
      const buffer = await file.arrayBuffer();
      if (openRequestIdRef.current !== reqId) return;
      await openBytes(new Uint8Array(buffer), file.name, reqId);
    } catch (err) {
      if (openRequestIdRef.current !== reqId) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleLoadSample = async (sampleId: string) => {
    if (!confirmDiscardIfDirty()) return;
    const reqId = ++openRequestIdRef.current;
    setCreatingDoc(false);
    setLoadingSampleId(sampleId);
    setErrorMsg(null);
    try {
      const sample = await orbClient.generateSample(sampleId);
      if (openRequestIdRef.current !== reqId) return;
      await openBytes(sample.bytes, sample.filename, reqId);
    } catch (err) {
      if (openRequestIdRef.current !== reqId) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (openRequestIdRef.current === reqId) {
        setLoadingSampleId(null);
      }
    }
  };

  const handleGoHome = useCallback(() => {
    if (!confirmDiscardIfDirty()) return;
    openRequestIdRef.current += 1;
    clearMarkdownDebounce();
    editorRef.current?.discardPendingEdits();
    exportRequestIdRef.current += 1;
    exportBusyRef.current = false;
    setExportBusy(false);
    replaceRequestIdRef.current += 1;
    replaceBusyRef.current = false;
    setReplaceBusy(false);
    reverifyRequestIdRef.current += 1;
    pdfEditRevRef.current = 0;
    pdfFieldEditRevsRef.current.clear();
    setCreatingDoc(false);
    setLoadingSampleId(null);
    docSessionIdRef.current += 1;
    setDocSessionId(docSessionIdRef.current);

    setDoc(null);
    docRef.current = null;
    filenameRef.current = null;
    setFilename(null);
    rawBytesRef.current = null;
    setRawBytes(null);
    setErrorMsg(null);
    setStatusNotice(null);
    setDirtyDoc(false);
    resetHistory();
    setFindOpen(false);
    setFindQuery('');
    setFindCaseSensitive(false);
    setFindMatchCount(0);
    setFindActiveIndex(0);
    setLinkOpen(false);
    setPdfDirtyFields(new Set());
  }, [clearMarkdownDebounce, confirmDiscardIfDirty, resetHistory]);

  const handleMarkdownChange = (next: string) => {
    setMarkdownDraft(next);
    setDirtyDoc(true);
    clearMarkdownDebounce();
    const sessionId = docSessionIdRef.current;
    const currentName = filename ?? undefined;
    mdDebounceRef.current = window.setTimeout(async () => {
      mdDebounceRef.current = null;
      if (docSessionIdRef.current !== sessionId) return;
      try {
        const ir = await orbClient.parseMarkdownLive(next, currentName);
        if (docSessionIdRef.current !== sessionId) return;
        setDoc((prev) =>
          prev?.kind === 'markdown' ? { kind: 'markdown', ir, rawMarkdown: next } : prev,
        );
      } catch {
        // Ignore transient parse error while typing
      }
    }, 90);
  };

  const enqueueWordOps = useCallback((ops: EditOperation[], options?: EnqueueWordOpsOptions) => {
    if (ops.length === 0) return;
    const sessionId = docSessionIdRef.current;

    editQueueRef.current = editQueueRef.current.then(async () => {
      if (docSessionIdRef.current !== sessionId) return;
      const current = docRef.current;
      if (!current || current.kind !== 'word') return;
      const beforeIr = current.ir;
      const beforeFilename = filenameRef.current;
      try {
        let nextIr = beforeIr;
        for (const op of ops) {
          nextIr = await orbClient.applyIrEdit(nextIr, op);
          if (docSessionIdRef.current !== sessionId) return;
        }
        if (options?.skipIfUnchanged) {
          const changed = JSON.stringify(beforeIr.blocks) !== JSON.stringify(nextIr.blocks);
          if (!changed) {
            options.onResult?.(false);
            return;
          }
        }
        if (
          options?.skipIfRenameNoop &&
          options.afterFilename === beforeFilename &&
          nextIr.title === beforeIr.title
        ) {
          return;
        }
        const nextDoc: OpenedDocument = { ...current, ir: nextIr };
        docRef.current = nextDoc;
        setDoc(nextDoc);
        if (options?.afterFilename !== undefined && options.afterFilename !== beforeFilename) {
          filenameRef.current = options.afterFilename;
          setFilename(options.afterFilename);
        }

        const nextUndo = [
          ...undoStackRef.current.slice(-(MAX_UNDO_DEPTH - 1)),
          { ir: beforeIr, filename: beforeFilename },
        ];
        undoStackRef.current = nextUndo;
        redoStackRef.current = [];
        setUndoStack(nextUndo);
        setRedoStack([]);
        setDirtyDoc(true);

        if (options?.syncDom) {
          setExternalSyncRev((r) => r + 1);
        }
        options?.onResult?.(true);
      } catch (err) {
        if (docSessionIdRef.current !== sessionId) return;
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setExternalSyncRev((r) => r + 1);
      }
    });
  }, []);

  const handleApplyWordEdit = useCallback(
    (op: EditOperation, options?: { syncDom?: boolean }) => {
      enqueueWordOps([op], options);
    },
    [enqueueWordOps],
  );

  const handleLiveDirty = useCallback(() => {
    setDirtyDoc(true);
  }, []);

  // Serialize Undo and Redo through editQueueRef so flushed pending edits always resolve first
  const handleUndo = useCallback(() => {
    editorRef.current?.flushPendingEdits();
    const sessionId = docSessionIdRef.current;
    editQueueRef.current = editQueueRef.current.then(() => {
      if (docSessionIdRef.current !== sessionId) return;
      const current = docRef.current;
      const stack = undoStackRef.current;
      if (!current || current.kind !== 'word' || stack.length === 0) return;

      const prevEntry = stack[stack.length - 1];
      const nextUndo = stack.slice(0, -1);
      const nextRedo = [
        ...redoStackRef.current.slice(-(MAX_UNDO_DEPTH - 1)),
        { ir: current.ir, filename: filenameRef.current },
      ];
      undoStackRef.current = nextUndo;
      redoStackRef.current = nextRedo;
      setUndoStack(nextUndo);
      setRedoStack(nextRedo);

      const nextDoc: OpenedDocument = { ...current, ir: prevEntry.ir };
      docRef.current = nextDoc;
      setDoc(nextDoc);
      if (prevEntry.filename !== filenameRef.current) {
        filenameRef.current = prevEntry.filename;
        setFilename(prevEntry.filename);
      }
      setDirtyDoc(true);
      setExternalSyncRev((r) => r + 1);
    });
  }, []);

  const handleRedo = useCallback(() => {
    editorRef.current?.flushPendingEdits();
    const sessionId = docSessionIdRef.current;
    editQueueRef.current = editQueueRef.current.then(() => {
      if (docSessionIdRef.current !== sessionId) return;
      const current = docRef.current;
      const stack = redoStackRef.current;
      if (!current || current.kind !== 'word' || stack.length === 0) return;

      const nextEntry = stack[stack.length - 1];
      const nextRedo = stack.slice(0, -1);
      const nextUndo = [
        ...undoStackRef.current.slice(-(MAX_UNDO_DEPTH - 1)),
        { ir: current.ir, filename: filenameRef.current },
      ];
      undoStackRef.current = nextUndo;
      redoStackRef.current = nextRedo;
      setUndoStack(nextUndo);
      setRedoStack(nextRedo);

      const nextDoc: OpenedDocument = { ...current, ir: nextEntry.ir };
      docRef.current = nextDoc;
      setDoc(nextDoc);
      if (nextEntry.filename !== filenameRef.current) {
        filenameRef.current = nextEntry.filename;
        setFilename(nextEntry.filename);
      }
      setDirtyDoc(true);
      setExternalSyncRev((r) => r + 1);
    });
  }, []);

  const handleRenameDocument = useCallback(
    (nextName: string) => {
      const cleaned = nextName.trim();
      if (!cleaned) return;
      const hasKnownExt = /\.(docx|doc|md|markdown)$/i.test(cleaned);
      const withExt = hasKnownExt ? cleaned : `${cleaned}.docx`;
      const baseTitle = withExt.replace(/\.(docx|doc|md|markdown)$/i, '');
      if (docRef.current?.kind === 'word') {
        editorRef.current?.flushPendingEdits();
        enqueueWordOps([{ op: 'setTitle', title: baseTitle }], {
          afterFilename: withExt,
          skipIfRenameNoop: true,
        });
      } else if (withExt !== filenameRef.current) {
        filenameRef.current = withExt;
        setFilename(withExt);
      }
    },
    [enqueueWordOps],
  );

  const handleInsertImageFile = async (file: File) => {
    if (!docRef.current || docRef.current.kind !== 'word') return;
    if (!file.type.startsWith('image/')) {
      setErrorMsg('Please select a valid image file (PNG, JPEG, GIF, SVG, or WebP).');
      return;
    }
    const sessionId = docSessionIdRef.current;
    editorRef.current?.flushPendingEdits();
    try {
      const dataBase64 = await fileToBase64(file);
      if (docSessionIdRef.current !== sessionId) return;
      const current = docRef.current;
      if (!current || current.kind !== 'word') return;

      const assetId = makeBlockUid('asset');
      const imgBlockId = makeBlockUid('img');
      const afterBlockId =
        editorRef.current?.getTopLevelBlockId() ??
        current.ir.blocks[current.ir.blocks.length - 1]?.id ??
        null;
      const lastBlockId = current.ir.blocks[current.ir.blocks.length - 1]?.id ?? null;

      const ops: EditOperation[] = [
        {
          op: 'addAsset',
          asset: {
            id: assetId,
            mimeType: file.type,
            dataBase64,
            filename: file.name,
          },
        },
        {
          op: 'insertBlockAfter',
          afterBlockId,
          block: {
            id: imgBlockId,
            type: 'image',
            assetId,
            alt: file.name.replace(/\.[^.]+$/, ''),
            caption: null,
          },
        },
      ];

      if (afterBlockId === null || afterBlockId === lastBlockId) {
        ops.push({
          op: 'insertBlockAfter',
          afterBlockId: imgBlockId,
          block: {
            id: makeBlockUid('p'),
            type: 'paragraph',
            runs: [],
            align: 'left',
            indentLevel: 0,
          },
        });
      }

      enqueueWordOps(ops);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleInsertSpecialBlock = useCallback(
    (kind: 'codeBlock' | 'blockQuote' | 'horizontalRule' | 'pageBreak' | 'footnote') => {
      const id = makeBlockUid(kind);
      let block: Block;
      switch (kind) {
        case 'codeBlock':
          block = { id, type: 'codeBlock', language: null, code: '' };
          break;
        case 'blockQuote':
          block = {
            id,
            type: 'blockQuote',
            blocks: [
              {
                id: `${id}-q0`,
                type: 'paragraph',
                runs: [],
                align: 'left',
                indentLevel: 0,
              },
            ],
          };
          break;
        case 'horizontalRule':
          block = { id, type: 'horizontalRule' };
          break;
        case 'pageBreak':
          block = { id, type: 'pageBreak' };
          break;
        case 'footnote': {
          const existingCount =
            docRef.current?.kind === 'word'
              ? docRef.current.ir.blocks.filter((b) => b.type === 'footnote').length
              : 0;
          block = {
            id,
            type: 'footnote',
            label: String(existingCount + 1),
            blocks: [
              {
                id: `${id}-p0`,
                type: 'paragraph',
                runs: [{ text: 'Footnote text', style: {} }],
                align: 'left',
                indentLevel: 0,
              },
            ],
          };
          break;
        }
      }
      editorRef.current?.insertBlockAfterActive(
        block,
        kind === 'blockQuote' || kind === 'footnote',
      );
    },
    [],
  );

  const handleFindQueryChange = useCallback((q: string) => {
    setFindQuery(q);
    setFindActiveIndex(0);
  }, []);

  const handleFindStep = useCallback(
    (delta: 1 | -1) => {
      if (findMatchCount === 0) return;
      setFindActiveIndex((prev) => (prev + delta + findMatchCount) % findMatchCount);
    },
    [findMatchCount],
  );

  const handleReplaceCurrent = useCallback(
    (find: string, replace: string, caseSensitive: boolean) => {
      if (!wordEditMode || !find || replaceBusyRef.current) return;
      editorRef.current?.flushPendingEdits();
      const reqId = ++replaceRequestIdRef.current;
      replaceBusyRef.current = true;
      setReplaceBusy(true);
      const sessionId = docSessionIdRef.current;

      editQueueRef.current = editQueueRef.current
        .then(async () => {
          if (docSessionIdRef.current !== sessionId || replaceRequestIdRef.current !== reqId) return;
          const current = docRef.current;
          if (!current || current.kind !== 'word') return;
          const beforeIr = current.ir;
          const beforeFilename = filenameRef.current;
          const computed = computeReplaceCurrentOp(
            beforeIr.blocks,
            find,
            replace,
            caseSensitive,
            findActiveIndexRef.current,
          );
          if (!computed) {
            setStatusNotice(`No matches found for "${find}".`);
            return;
          }
          try {
            const nextIr = await orbClient.applyIrEdit(beforeIr, computed.op);
            if (docSessionIdRef.current !== sessionId) return;
            const nextDoc: OpenedDocument = { ...current, ir: nextIr };
            docRef.current = nextDoc;
            setDoc(nextDoc);

            const nextUndo = [
              ...undoStackRef.current.slice(-(MAX_UNDO_DEPTH - 1)),
              { ir: beforeIr, filename: beforeFilename },
            ];
            undoStackRef.current = nextUndo;
            redoStackRef.current = [];
            setUndoStack(nextUndo);
            setRedoStack([]);
            setDirtyDoc(true);
            setExternalSyncRev((r) => r + 1);
            findActiveIndexRef.current = computed.nextIndex;
            setFindActiveIndex(computed.nextIndex);
          } catch (err) {
            if (docSessionIdRef.current !== sessionId) return;
            setErrorMsg(err instanceof Error ? err.message : String(err));
            setExternalSyncRev((r) => r + 1);
          }
        })
        .finally(() => {
          if (replaceRequestIdRef.current === reqId) {
            replaceBusyRef.current = false;
            setReplaceBusy(false);
          }
        });
    },
    [wordEditMode],
  );

  const handleReplaceAll = useCallback(
    (find: string, replace: string, caseSensitive: boolean) => {
      if (!wordEditMode || !find) return;
      editorRef.current?.flushPendingEdits();
      enqueueWordOps([{ op: 'replaceAllText', find, replace, caseSensitive }], {
        syncDom: true,
        skipIfUnchanged: true,
        onResult: (changed) => {
          if (changed) {
            setStatusNotice(`Replaced occurrences of "${find}" with "${replace}".`);
          } else {
            setStatusNotice(`No matches found for "${find}".`);
          }
        },
      });
    },
    [enqueueWordOps, wordEditMode],
  );

  const handlePdfFieldChange = (fieldName: string, value: FormFieldValue) => {
    pdfEditRevRef.current += 1;
    pdfFieldEditRevsRef.current.set(fieldName, pdfEditRevRef.current);
    setPdfFormValues((prev) => ({ ...prev, [fieldName]: value }));
    setPdfDirtyFields((prev) => {
      const next = new Set(prev);
      next.add(fieldName);
      return next;
    });
  };

  const handleResetPdfForms = () => {
    if (!doc || doc.kind !== 'pdf') return;
    pdfEditRevRef.current += 1;
    pdfFieldEditRevsRef.current.clear();
    const restored: Record<string, FormFieldValue> = {};
    for (const f of doc.inspection.formFields) {
      restored[f.name] = f.value;
    }
    setPdfFormValues(restored);
    setPdfDirtyFields(new Set());
  };

  const handleExportPdf = async () => {
    if (!doc || doc.kind !== 'pdf' || !rawBytes || exportBusyRef.current) return;
    const sessionId = docSessionIdRef.current;
    const reqId = ++exportRequestIdRef.current;
    const editRevAtStart = pdfEditRevRef.current;
    const exportFilename = filenameRef.current;
    exportBusyRef.current = true;
    setExportBusy(true);
    setErrorMsg(null);
    try {
      const updates: FormFieldUpdate[] = Array.from(pdfDirtyFields).map((fieldName) => ({
        fieldName,
        value: pdfFormValues[fieldName] ?? { kind: 'none' },
      }));
      const exported =
        updates.length > 0 ? await orbClient.exportPdfForms(rawBytes, updates) : rawBytes;
      if (docSessionIdRef.current !== sessionId || exportRequestIdRef.current !== reqId) return;
      const outName = exportFilename
        ? replaceExtension(exportFilename, 'filled.pdf')
        : 'document.filled.pdf';
      triggerBlobDownload(new Uint8Array(exported), outName, 'application/pdf');

      if (updates.length > 0) {
        rawBytesRef.current = exported;
        setRawBytes(exported);
        filenameRef.current = outName;
        setFilename(outName);
        const revId = ++reverifyRequestIdRef.current;
        const inspected = await orbClient.reverifyPdf(
          exported,
          outName,
          trustedRootsPemRef.current,
        );
        if (docSessionIdRef.current !== sessionId || exportRequestIdRef.current !== reqId) return;
        if (reverifyRequestIdRef.current === revId) {
          const nextDoc: OpenedDocument = { kind: 'pdf', inspection: inspected };
          docRef.current = nextDoc;
          setDoc(nextDoc);
        }

        const baseForms: Record<string, FormFieldValue> = {};
        for (const f of inspected.formFields) {
          baseForms[f.name] = f.value;
        }
        if (pdfEditRevRef.current === editRevAtStart) {
          pdfFieldEditRevsRef.current.clear();
          setPdfFormValues(baseForms);
          setPdfDirtyFields(new Set());
        } else {
          // Preserve any form edits made while export/re-verification was in flight
          const newerDirty = new Set<string>();
          for (const [fieldName, rev] of pdfFieldEditRevsRef.current.entries()) {
            if (rev > editRevAtStart) {
              newerDirty.add(fieldName);
            } else {
              pdfFieldEditRevsRef.current.delete(fieldName);
            }
          }
          setPdfFormValues((prev) => {
            const merged = { ...baseForms };
            for (const fieldName of newerDirty) {
              if (fieldName in prev) merged[fieldName] = prev[fieldName];
            }
            return merged;
          });
          setPdfDirtyFields(newerDirty);
        }

        setStatusNotice(
          `Exported ${outName} via PDF incremental update (${updates.length} field(s) saved).`,
        );
      }
    } catch (err) {
      if (docSessionIdRef.current !== sessionId || exportRequestIdRef.current !== reqId) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (exportRequestIdRef.current === reqId) {
        exportBusyRef.current = false;
        setExportBusy(false);
      }
    }
  };

  const handleExportMarkdown = useCallback(async () => {
    if (exportBusyRef.current) return;
    const sessionId = docSessionIdRef.current;
    const reqId = ++exportRequestIdRef.current;
    exportBusyRef.current = true;
    setExportBusy(true);
    try {
      editorRef.current?.flushPendingEdits();
      await editQueueRef.current;
      if (docSessionIdRef.current !== sessionId || exportRequestIdRef.current !== reqId) return;
      const current = docRef.current;
      if (!current || current.kind === 'pdf') return;
      const exportedIr = current.kind === 'word' ? current.ir : null;
      const exportedDraft = current.kind === 'markdown' ? markdownDraftRef.current : null;
      const outName = filenameRef.current
        ? replaceExtension(filenameRef.current, 'md')
        : 'Untitled.md';
      const md =
        exportedDraft !== null
          ? exportedDraft
          : await orbClient.exportIrToMarkdown(current.ir);
      if (docSessionIdRef.current !== sessionId || exportRequestIdRef.current !== reqId) return;
      triggerBlobDownload(md, outName, 'text/markdown;charset=utf-8');
      const unchanged =
        !editorRef.current?.hasPendingEdits() &&
        ((exportedIr !== null && docRef.current?.kind === 'word' && docRef.current.ir === exportedIr) ||
          (exportedDraft !== null &&
            docRef.current?.kind === 'markdown' &&
            markdownDraftRef.current === exportedDraft));
      if (unchanged) {
        setDirtyDoc(false);
      }
      setStatusNotice(`Exported ${outName}`);
    } catch (err) {
      if (docSessionIdRef.current !== sessionId || exportRequestIdRef.current !== reqId) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (exportRequestIdRef.current === reqId) {
        exportBusyRef.current = false;
        setExportBusy(false);
      }
    }
  }, []);

  const handleExportDocx = useCallback(async () => {
    if (exportBusyRef.current) return;
    const sessionId = docSessionIdRef.current;
    const reqId = ++exportRequestIdRef.current;
    exportBusyRef.current = true;
    setExportBusy(true);
    try {
      editorRef.current?.flushPendingEdits();
      await editQueueRef.current;
      if (docSessionIdRef.current !== sessionId || exportRequestIdRef.current !== reqId) return;
      const current = docRef.current;
      if (!current || current.kind === 'pdf') return;
      const exportedIr = current.kind === 'word' ? current.ir : null;
      const exportedDraft = current.kind === 'markdown' ? markdownDraftRef.current : null;
      const currentName = filenameRef.current;
      const outName = currentName ? replaceExtension(currentName, 'docx') : 'Untitled.docx';
      const ir =
        exportedDraft !== null
          ? await orbClient.parseMarkdownLive(exportedDraft, currentName ?? undefined)
          : current.ir;
      if (docSessionIdRef.current !== sessionId || exportRequestIdRef.current !== reqId) return;
      const bytes = await orbClient.exportIrToDocx(ir);
      if (docSessionIdRef.current !== sessionId || exportRequestIdRef.current !== reqId) return;
      triggerBlobDownload(
        new Uint8Array(bytes),
        outName,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      const unchanged =
        !editorRef.current?.hasPendingEdits() &&
        ((exportedIr !== null && docRef.current?.kind === 'word' && docRef.current.ir === exportedIr) ||
          (exportedDraft !== null &&
            docRef.current?.kind === 'markdown' &&
            markdownDraftRef.current === exportedDraft));
      if (unchanged) {
        setDirtyDoc(false);
      }
      setStatusNotice(`Exported clean OOXML archive: ${outName}`);
    } catch (err) {
      if (docSessionIdRef.current !== sessionId || exportRequestIdRef.current !== reqId) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (exportRequestIdRef.current === reqId) {
        exportBusyRef.current = false;
        setExportBusy(false);
      }
    }
  }, []);

  // Global keyboard shortcuts (Ctrl/Cmd+N, O, S, P, F, H, Z, Y)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();

      if (key === 'n') {
        e.preventDefault();
        void handleNewDocument();
        return;
      }
      if (key === 'o') {
        e.preventDefault();
        fileInputRef.current?.click();
        return;
      }
      if (key === 's' && docRef.current?.kind === 'word') {
        e.preventDefault();
        void handleExportDocx();
        return;
      }
      if (key === 'p' && docRef.current?.kind === 'word') {
        e.preventDefault();
        window.print();
        return;
      }
      if ((key === 'f' || key === 'h') && docRef.current?.kind === 'word') {
        e.preventDefault();
        setFindOpen(true);
        setFindFocusTarget(key === 'h' ? 'replace' : 'find');
        setFindFocusNonce((n) => n + 1);
        return;
      }
      if (docRef.current?.kind === 'word' && wordEditMode) {
        const target = e.target as HTMLElement | null;
        const inPlainInput =
          target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
        if (!inPlainInput) {
          if (key === 'z' && !e.shiftKey) {
            e.preventDefault();
            handleUndo();
            return;
          }
          if ((key === 'z' && e.shiftKey) || key === 'y') {
            e.preventDefault();
            handleRedo();
            return;
          }
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleExportDocx, handleNewDocument, handleRedo, handleUndo, wordEditMode]);

  const reverifyWithRoots = async (nextRoots: string[]) => {
    trustedRootsPemRef.current = nextRoots;
    setTrustedRootsPem(nextRoots);
    const bytes = rawBytesRef.current;
    if (docRef.current?.kind === 'pdf' && bytes) {
      const sessionId = docSessionIdRef.current;
      const revId = ++reverifyRequestIdRef.current;
      try {
        const inspection = await orbClient.reverifyPdf(
          bytes,
          filenameRef.current ?? undefined,
          nextRoots,
        );
        if (docSessionIdRef.current !== sessionId || reverifyRequestIdRef.current !== revId) {
          return;
        }
        const updated: OpenedDocument = { kind: 'pdf', inspection };
        docRef.current = updated;
        setDoc(updated);
      } catch (err) {
        if (docSessionIdRef.current !== sessionId || reverifyRequestIdRef.current !== revId) {
          return;
        }
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

      <input
        ref={imageInputRef}
        id="orb-hidden-image-input"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/svg+xml,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            void handleInsertImageFile(file);
          }
          e.target.value = '';
        }}
      />

      {doc?.kind === 'word' ? (
        <EditorTopBar
          filename={filename ?? 'Untitled.docx'}
          ir={doc.ir}
          dirty={isDirty}
          editMode={wordEditMode}
          onEditModeChange={(next) => {
            setWordEditMode(next);
            if (!next) setLinkOpen(false);
          }}
          showFormattingBar={showFormattingBar}
          onToggleFormattingBar={() => setShowFormattingBar((v) => !v)}
          showOutline={showOutline}
          onToggleOutline={() => setShowOutline((v) => !v)}
          showInspector={showInspector}
          onToggleInspector={() => setShowInspector((v) => !v)}
          zoom={zoom}
          onZoomChange={setZoom}
          canUndo={undoStack.length > 0}
          canRedo={redoStack.length > 0}
          onUndo={handleUndo}
          onRedo={handleRedo}
          selection={editorSelection}
          exportBusy={exportBusy}
          replaceBusy={replaceBusy}
          findOpen={findOpen}
          findFocusNonce={findFocusNonce}
          findFocusTarget={findFocusTarget}
          findQuery={findQuery}
          findCaseSensitive={findCaseSensitive}
          findMatchCount={findMatchCount}
          findActiveIndex={findActiveIndex}
          onFindOpenChange={setFindOpen}
          onFindQueryChange={handleFindQueryChange}
          onFindCaseSensitiveChange={(cs) => {
            setFindCaseSensitive(cs);
            setFindActiveIndex(0);
          }}
          onFindStep={handleFindStep}
          onReplaceCurrent={handleReplaceCurrent}
          onReplaceAll={handleReplaceAll}
          linkOpen={linkOpen}
          onLinkOpenChange={setLinkOpen}
          onGoHome={handleGoHome}
          onNewDocument={() => void handleNewDocument()}
          onOpenFile={() => fileInputRef.current?.click()}
          onRenameDocument={handleRenameDocument}
          onExportDocx={() => void handleExportDocx()}
          onExportMarkdown={() => void handleExportMarkdown()}
          onPrint={() => window.print()}
          onClipboard={(cmd) => {
            void editorRef.current?.clipboardCommand(cmd).catch(() => {
              setStatusNotice('Clipboard access requires browser permission or keyboard shortcut.');
            });
          }}
          onSelectAll={() => editorRef.current?.selectAllContent()}
          onToggleInlineStyle={(flag) => editorRef.current?.toggleInlineStyle(flag)}
          onSetFontSize={(pt) => editorRef.current?.setFontSize(pt)}
          onApplyLink={(href, label) => editorRef.current?.applyLink(href, label)}
          onClearFormatting={() => editorRef.current?.clearFormatting()}
          onSetAlignment={(align) => editorRef.current?.setAlignment(align)}
          onChangeIndent={(delta) => editorRef.current?.changeIndent(delta)}
          onConvertBlock={(target) => editorRef.current?.convertActiveBlock(target)}
          onInsertImageClick={() => imageInputRef.current?.click()}
          onInsertTable={(rows, cols) => editorRef.current?.insertTable(rows, cols)}
          onInsertSpecialBlock={handleInsertSpecialBlock}
          onTableAction={(action) => {
            if (action === 'addRow') editorRef.current?.addTableRow();
            else if (action === 'deleteRow') editorRef.current?.deleteTableRow();
            else if (action === 'addCol') editorRef.current?.addTableColumn();
            else if (action === 'deleteCol') editorRef.current?.deleteTableColumn();
          }}
          onRestoreFocus={() => editorRef.current?.focusEditor()}
        />
      ) : (
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
          showOutline={showOutline}
          onToggleOutline={() => setShowOutline((v) => !v)}
          showInspector={showInspector}
          onToggleInspector={() => setShowInspector((v) => !v)}
          onNewDocumentClick={() => void handleNewDocument()}
          onOpenFileClick={() => fileInputRef.current?.click()}
          onGoHome={handleGoHome}
          onExportPdf={handleExportPdf}
          onExportMarkdown={handleExportMarkdown}
          onExportDocx={handleExportDocx}
          exportBusy={exportBusy}
        />
      )}

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
          samplesStatus={samplesStatus}
          loadingSampleId={loadingSampleId}
          creatingDoc={creatingDoc}
          onNewDocumentClick={() => void handleNewDocument()}
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
              <DocumentIrView
                key={docSessionId}
                ref={editorRef}
                ir={doc.ir}
                zoom={zoom}
                editable={wordEditMode}
                autoFocusNonce={autoFocusNonce}
                externalSyncRev={externalSyncRev}
                findQuery={findOpen ? findQuery : ''}
                findCaseSensitive={findCaseSensitive}
                activeFindMatchIndex={findActiveIndex}
                onFindMatchCountChange={setFindMatchCount}
                onLiveDirty={handleLiveDirty}
                onApplyEdit={handleApplyWordEdit}
                onApplyEditsBatch={enqueueWordOps}
                onSelectionStateChange={setEditorSelection}
                onRequestLinkDialog={() => setLinkOpen(true)}
              />
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
