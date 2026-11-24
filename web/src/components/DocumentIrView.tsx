import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  Block,
  BlockConvertTarget,
  DocumentIr,
  EditOperation,
  InlineRun,
  MediaAsset,
  TextAlign,
  TextStyle,
} from '../types';
import {
  clearStyleInRange,
  countTextOccurrences,
  domToRuns,
  FONT_SIZE_MAX_PT,
  FONT_SIZE_MIN_PT,
  getLinkRunAtOffset,
  getSelectionOffsetsInElement,
  getStyleAtRange,
  insertStyledTextAtRange,
  isSafeHref,
  mergeRuns,
  normalizeStyle,
  replaceNthOccurrenceInRuns,
  runsEqual,
  runsToPlainText,
  runsToSafeHtml,
  setFontSizeInRange,
  setLinkInRange,
  setSelectionOffsetsInElement,
  splitRunsAtOffset,
  toggleStyleFlag,
  toggleStyleInRange,
  type InlineStyleFlag,
} from '../utils/editorRuns';
import { PlusIcon, TrashIcon } from './Icons';

export interface EditorSelectionState {
  activeBlockId: string | null;
  blockType: Block['type'] | null;
  headingLevel: number | null;
  listKind: 'bullet' | 'ordered' | 'checklist' | null;
  align: TextAlign;
  indentLevel: number;
  canAlign: boolean;
  canIndent: boolean;
  inTable: boolean;
  tableRow: number | null;
  tableCol: number | null;
  tableRowCount: number;
  tableColCount: number;
  textStyle: TextStyle;
  hasTextSelection: boolean;
  selectedText: string;
  activeLinkText: string;
}

export interface ReplaceCurrentResult {
  replaced: boolean;
  nextIndex: number;
}

export interface DocumentEditorHandle {
  focusEditor: () => void;
  focusBlock: (blockId: string, offset?: number) => void;
  flushPendingEdits: () => void;
  discardPendingEdits: () => void;
  hasPendingEdits: () => boolean;
  getTopLevelBlockId: () => string | null;
  toggleInlineStyle: (flag: InlineStyleFlag) => void;
  setFontSize: (sizePt: number | null) => void;
  applyLink: (href: string | null, label?: string) => void;
  clearFormatting: () => void;
  setAlignment: (align: TextAlign) => void;
  changeIndent: (delta: 1 | -1) => void;
  convertActiveBlock: (target: BlockConvertTarget) => void;
  insertBlockAfterActive: (block: Block, focusNew?: boolean) => void;
  insertTable: (rows: number, cols: number) => void;
  addTableRow: () => void;
  deleteTableRow: () => void;
  addTableColumn: () => void;
  deleteTableColumn: () => void;
  selectAllContent: () => void;
  clipboardCommand: (cmd: 'cut' | 'copy' | 'paste' | 'pastePlain') => Promise<void>;
  replaceCurrentMatch: (
    find: string,
    replace: string,
    caseSensitive: boolean,
  ) => ReplaceCurrentResult;
  getActiveSelectionState: () => EditorSelectionState;
}

interface DocumentIrViewProps {
  ir: DocumentIr;
  zoom: number;
  editable?: boolean;
  autoFocusNonce?: number;
  externalSyncRev?: number;
  findQuery?: string;
  findCaseSensitive?: boolean;
  activeFindMatchIndex?: number;
  onFindMatchCountChange?: (count: number) => void;
  onLiveDirty?: () => void;
  onApplyEdit?: (op: EditOperation, options?: { syncDom?: boolean }) => void | Promise<void>;
  onApplyEditsBatch?: (
    ops: EditOperation[],
    options?: { syncDom?: boolean },
  ) => void | Promise<void>;
  onSelectionStateChange?: (state: EditorSelectionState) => void;
  onRequestLinkDialog?: () => void;
}

interface CachedTarget {
  blockId: string;
  listItemIndex?: number;
  tableRow?: number;
  tableCol?: number;
  start: number;
  end: number;
}

interface EditableElEntry {
  el: HTMLElement;
  setSyncedRuns: (runs: InlineRun[]) => void;
}

interface PendingStyleState {
  key: string;
  offset: number;
  style: TextStyle;
}

interface ActiveCellEdit {
  cellId: string;
  blockId: string;
  row: number;
  col: number;
  originalPlain: string;
  draft: string;
}

interface ActiveCodeEdit {
  blockId: string;
  language: string | null;
  originalCode: string;
  draft: string;
}

interface FindMatchEntry {
  topBlockId: string;
  kind: 'runs' | 'listItem' | 'codeBlock';
  blockId: string;
  listItemIndex?: number;
  checked?: boolean | null;
  localIndex: number;
}

const DEFAULT_SELECTION_STATE: EditorSelectionState = {
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

const InlineRunsView: React.FC<{ runs: InlineRun[] }> = ({ runs }) => (
  <>
    {runs.map((run, idx) => {
      const s = run.style;
      let node: React.ReactNode = run.text;

      if (s.code) node = <code>{node}</code>;
      if (s.bold) node = <strong>{node}</strong>;
      if (s.italic) node = <em>{node}</em>;
      if (s.underline) node = <u>{node}</u>;
      if (s.strikethrough) node = <del>{node}</del>;
      if (s.superscript) node = <sup>{node}</sup>;
      if (s.subscript) node = <sub>{node}</sub>;
      if (s.href && isSafeHref(s.href)) {
        const isAnchor = s.href.startsWith('#');
        node = (
          <a
            href={s.href}
            target={isAnchor ? undefined : '_blank'}
            rel={isAnchor ? undefined : 'noopener noreferrer'}
          >
            {node}
          </a>
        );
      }

      const inlineStyle: React.CSSProperties | undefined = s.fontSizePt
        ? {
            fontSize: `${Math.min(Math.max(s.fontSizePt, FONT_SIZE_MIN_PT), FONT_SIZE_MAX_PT)}pt`,
          }
        : undefined;

      return (
        <span key={idx} style={inlineStyle}>
          {node}
        </span>
      );
    })}
  </>
);

interface EditableRunsProps {
  tag: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'span';
  runs: InlineRun[];
  externalSyncRev: number;
  className?: string;
  style?: React.CSSProperties;
  placeholder?: string;
  registerEntry: (entry: EditableElEntry | null) => void;
  getPendingStyle: () => { offset: number; style: TextStyle } | null;
  onAdvancePendingStyle: (nextOffset: number) => void;
  onLiveInput: (runs: InlineRun[], el: HTMLElement) => void;
  onCommit: (runs: InlineRun[]) => void;
  onFocusEl: (el: HTMLElement) => void;
  onKeyDownEl: (e: React.KeyboardEvent<HTMLElement>, el: HTMLElement) => void;
}

const EditableRuns: React.FC<EditableRunsProps> = ({
  tag,
  runs,
  externalSyncRev,
  className,
  style,
  placeholder,
  registerEntry,
  getPendingStyle,
  onAdvancePendingStyle,
  onLiveInput,
  onCommit,
  onFocusEl,
  onKeyDownEl,
}) => {
  const localRef = useRef<HTMLElement | null>(null);
  const lastSyncedRunsRef = useRef<InlineRun[]>(mergeRuns(runs));
  const initializedRef = useRef(false);
  const lastExternalSyncRevRef = useRef(externalSyncRev);
  const isComposingRef = useRef(false);
  const compositionPendingRef = useRef<{ offset: number; style: TextStyle } | null>(null);

  const getPendingStyleRef = useRef(getPendingStyle);
  getPendingStyleRef.current = getPendingStyle;
  const onAdvancePendingStyleRef = useRef(onAdvancePendingStyle);
  onAdvancePendingStyleRef.current = onAdvancePendingStyle;
  const onLiveInputRef = useRef(onLiveInput);
  onLiveInputRef.current = onLiveInput;

  const setRef = useCallback(
    (el: HTMLElement | null) => {
      localRef.current = el;
      if (el) {
        registerEntry({
          el,
          setSyncedRuns: (next) => {
            lastSyncedRunsRef.current = mergeRuns(next);
          },
        });
      } else {
        registerEntry(null);
      }
    },
    [registerEntry],
  );

  // Sync DOM from IR runs ONLY on mount, externalSyncRev changes (undo/redo/replace/error),
  // or when the element is NOT actively focused (preventing in-flight worker edits from clobbering typing).
  useEffect(() => {
    const el = localRef.current;
    if (!el) return;

    const isExternalSync = externalSyncRev !== lastExternalSyncRevRef.current;
    const isFocused = document.activeElement === el;

    if (!initializedRef.current || isExternalSync) {
      const savedSel = isFocused ? getSelectionOffsetsInElement(el) : null;
      const merged = mergeRuns(runs);
      el.innerHTML = runsToSafeHtml(merged);
      lastSyncedRunsRef.current = merged;
      initializedRef.current = true;
      lastExternalSyncRevRef.current = externalSyncRev;
      if (isFocused && savedSel) {
        const maxLen = runsToPlainText(merged).length;
        setSelectionOffsetsInElement(
          el,
          Math.min(savedSel.start, maxLen),
          Math.min(savedSel.end, maxLen),
        );
      }
      return;
    }

    if (!isFocused && !runsEqual(runs, lastSyncedRunsRef.current)) {
      const merged = mergeRuns(runs);
      el.innerHTML = runsToSafeHtml(merged);
      lastSyncedRunsRef.current = merged;
    }
  }, [externalSyncRev, runs]);

  // Native beforeinput handler so stored marks (pendingStyle) apply to newly typed text
  // even in empty paragraphs or at a collapsed caret.
  useEffect(() => {
    const el = localRef.current;
    if (!el) return;

    const handleBeforeInput = (e: InputEvent) => {
      if (e.isComposing || isComposingRef.current) return;
      if (e.inputType !== 'insertText' || typeof e.data !== 'string' || e.data.length === 0) {
        return;
      }
      const pending = getPendingStyleRef.current();
      if (!pending) return;

      const sel = getSelectionOffsetsInElement(el);
      if (!sel) return;
      if (sel.start !== sel.end || sel.start !== pending.offset) return;

      e.preventDefault();
      const current = domToRuns(el);
      const next = insertStyledTextAtRange(current, sel.start, sel.end, e.data, pending.style);
      el.innerHTML = runsToSafeHtml(next);
      lastSyncedRunsRef.current = next;
      const nextCaret = sel.start + e.data.length;
      // Advance pending offset BEFORE setting selection so synchronous selectionchange keeps it valid
      onAdvancePendingStyleRef.current(nextCaret);
      setSelectionOffsetsInElement(el, nextCaret, nextCaret);
      onLiveInputRef.current(next, el);
    };

    el.addEventListener('beforeinput', handleBeforeInput as EventListener);
    return () => el.removeEventListener('beforeinput', handleBeforeInput as EventListener);
  }, []);

  const Tag = tag as React.ElementType;

  return (
    <Tag
      ref={setRef}
      className={className}
      style={style}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      data-placeholder={placeholder}
      onFocus={(e: React.FocusEvent<HTMLElement>) => onFocusEl(e.currentTarget)}
      onCompositionStart={(e: React.CompositionEvent<HTMLElement>) => {
        isComposingRef.current = true;
        const el = e.currentTarget;
        const pending = getPendingStyleRef.current();
        const sel = getSelectionOffsetsInElement(el);
        if (pending && sel && sel.start === sel.end && sel.start === pending.offset) {
          compositionPendingRef.current = { offset: pending.offset, style: pending.style };
        } else {
          compositionPendingRef.current = null;
        }
      }}
      onCompositionEnd={(e: React.CompositionEvent<HTMLElement>) => {
        isComposingRef.current = false;
        const el = e.currentTarget;
        const composed = (e.data ?? '').replace(/\r\n?/g, '\n');
        const pending = compositionPendingRef.current;
        compositionPendingRef.current = null;

        if (pending && composed.length > 0) {
          const current = domToRuns(el);
          const endOffset = Math.min(
            runsToPlainText(current).length,
            pending.offset + composed.length,
          );
          const next = insertStyledTextAtRange(
            current,
            pending.offset,
            endOffset,
            composed,
            pending.style,
          );
          el.innerHTML = runsToSafeHtml(next);
          lastSyncedRunsRef.current = next;
          const nextCaret = pending.offset + composed.length;
          onAdvancePendingStyleRef.current(nextCaret);
          setSelectionOffsetsInElement(el, nextCaret, nextCaret);
          onLiveInputRef.current(next, el);
          return;
        }

        const parsed = domToRuns(el);
        lastSyncedRunsRef.current = parsed;
        onLiveInputRef.current(parsed, el);
      }}
      onInput={(e: React.FormEvent<HTMLElement>) => {
        if (isComposingRef.current) return;
        const el = e.currentTarget;
        const parsed = domToRuns(el);
        lastSyncedRunsRef.current = parsed;
        onLiveInput(parsed, el);
      }}
      onBlur={(e: React.FocusEvent<HTMLElement>) => {
        isComposingRef.current = false;
        compositionPendingRef.current = null;
        const parsed = domToRuns(e.currentTarget);
        lastSyncedRunsRef.current = parsed;
        onCommit(parsed);
      }}
      onPaste={(e: React.ClipboardEvent<HTMLElement>) => {
        e.preventDefault();
        const plain = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
        if (!plain) return;
        const el = e.currentTarget;
        const sel = getSelectionOffsetsInElement(el);
        const current = domToRuns(el);
        const total = runsToPlainText(current).length;
        const start = sel?.start ?? total;
        const end = sel?.end ?? total;
        const pending = getPendingStyleRef.current();
        const inherited =
          pending && start === end && start === pending.offset
            ? pending.style
            : getStyleAtRange(current, start, start);
        const next = insertStyledTextAtRange(current, start, end, plain, inherited);
        el.innerHTML = runsToSafeHtml(next);
        lastSyncedRunsRef.current = next;
        const nextCaret = start + plain.length;
        if (pending && start === end && start === pending.offset) {
          onAdvancePendingStyleRef.current(nextCaret);
        }
        setSelectionOffsetsInElement(el, nextCaret, nextCaret);
        onLiveInput(next, el);
      }}
      onKeyDown={(e: React.KeyboardEvent<HTMLElement>) => {
        if (e.nativeEvent.isComposing || isComposingRef.current) return;
        onKeyDownEl(e, e.currentTarget);
      }}
    />
  );
};

function findBlockById(blocks: Block[], id: string | null): Block | null {
  if (!id) return null;
  for (const b of blocks) {
    if (b.id === id) return b;
    if (b.type === 'blockQuote' || b.type === 'footnote') {
      const found = findBlockById(b.blocks, id);
      if (found) return found;
    } else if (b.type === 'list') {
      for (const item of b.items) {
        const found = findBlockById(item.children, id);
        if (found) return found;
      }
    } else if (b.type === 'table') {
      for (const row of b.rows) {
        for (const cell of row.cells) {
          const found = findBlockById(cell.blocks, id);
          if (found) return found;
        }
      }
    }
  }
  return null;
}

function findTopLevelAncestor(blocks: Block[], id: string | null): Block | null {
  if (!id) return null;
  for (const top of blocks) {
    if (top.id === id || findBlockById([top], id)) {
      return top;
    }
  }
  return null;
}

function findImmediateContainer(
  blocks: Block[],
  targetId: string,
): Extract<Block, { type: 'blockQuote' }> | Extract<Block, { type: 'footnote' }> | null {
  for (const b of blocks) {
    if (b.type === 'blockQuote' || b.type === 'footnote') {
      if (b.blocks.some((child) => child.id === targetId)) {
        return b;
      }
      const nested = findImmediateContainer(b.blocks, targetId);
      if (nested) return nested;
    } else if (b.type === 'list') {
      for (const item of b.items) {
        const nested = findImmediateContainer(item.children, targetId);
        if (nested) return nested;
      }
    } else if (b.type === 'table') {
      for (const row of b.rows) {
        for (const cell of row.cells) {
          const nested = findImmediateContainer(cell.blocks, targetId);
          if (nested) return nested;
        }
      }
    }
  }
  return null;
}

function isNonTextBlock(block: Block): boolean {
  return (
    block.type === 'table' ||
    block.type === 'image' ||
    block.type === 'horizontalRule' ||
    block.type === 'pageBreak' ||
    block.type === 'codeBlock' ||
    block.type === 'footnote'
  );
}

function makeUid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function collectFindMatches(
  blocks: Block[],
  query: string,
  caseSensitive: boolean,
): { matchedTopIds: Set<string>; matches: FindMatchEntry[] } {
  const matchedTopIds = new Set<string>();
  const matches: FindMatchEntry[] = [];
  if (!query) return { matchedTopIds, matches };

  const visit = (block: Block, topBlockId: string) => {
    if (block.type === 'paragraph' || block.type === 'heading') {
      const count = countTextOccurrences(runsToPlainText(block.runs), query, caseSensitive);
      if (count > 0) {
        matchedTopIds.add(topBlockId);
        for (let i = 0; i < count; i++) {
          matches.push({ topBlockId, kind: 'runs', blockId: block.id, localIndex: i });
        }
      }
    } else if (block.type === 'list') {
      block.items.forEach((item, idx) => {
        const count = countTextOccurrences(runsToPlainText(item.runs), query, caseSensitive);
        if (count > 0) {
          matchedTopIds.add(topBlockId);
          for (let i = 0; i < count; i++) {
            matches.push({
              topBlockId,
              kind: 'listItem',
              blockId: block.id,
              listItemIndex: idx,
              checked: item.checked ?? null,
              localIndex: i,
            });
          }
        }
        item.children.forEach((child) => visit(child, topBlockId));
      });
    } else if (block.type === 'codeBlock') {
      const count = countTextOccurrences(block.code, query, caseSensitive);
      if (count > 0) {
        matchedTopIds.add(topBlockId);
        for (let i = 0; i < count; i++) {
          matches.push({ topBlockId, kind: 'codeBlock', blockId: block.id, localIndex: i });
        }
      }
    } else if (block.type === 'blockQuote' || block.type === 'footnote') {
      block.blocks.forEach((inner) => visit(inner, topBlockId));
    } else if (block.type === 'table') {
      // Recurse into inner blocks of each cell so Find & Replace preserves inline styles and multi-block cells
      block.rows.forEach((row) => {
        row.cells.forEach((cell) => {
          cell.blocks.forEach((cb) => visit(cb, topBlockId));
        });
      });
    }
  };

  for (const top of blocks) {
    visit(top, top.id);
  }

  return { matchedTopIds, matches };
}

function replaceNthInPlainString(
  text: string,
  needle: string,
  replacement: string,
  caseSensitive: boolean,
  targetIndex: number,
): { text: string; replaced: boolean } {
  if (!needle || targetIndex < 0) return { text, replaced: false };
  const h = caseSensitive ? text : text.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();
  let occ = 0;
  let pos = 0;
  while (pos <= h.length - n.length) {
    const idx = h.indexOf(n, pos);
    if (idx === -1) break;
    if (occ === targetIndex) {
      return {
        text: text.slice(0, idx) + replacement + text.slice(idx + needle.length),
        replaced: true,
      };
    }
    occ += 1;
    pos = idx + Math.max(1, n.length);
  }
  return { text, replaced: false };
}

export function computeReplaceCurrentOp(
  blocks: Block[],
  find: string,
  replace: string,
  caseSensitive: boolean,
  activeIndex: number,
): { op: EditOperation; nextIndex: number } | null {
  if (!find) return null;
  const { matches } = collectFindMatches(blocks, find, caseSensitive);
  if (matches.length === 0) return null;
  const safeIdx = ((activeIndex % matches.length) + matches.length) % matches.length;
  const match = matches[safeIdx];
  if (!match) return null;
  const block = findBlockById(blocks, match.blockId);
  if (!block) return null;

  const advanceBy = countTextOccurrences(replace, find, caseSensitive);
  const nextIndex = safeIdx + advanceBy;

  if (match.kind === 'runs' && (block.type === 'paragraph' || block.type === 'heading')) {
    const res = replaceNthOccurrenceInRuns(
      block.runs,
      find,
      replace,
      caseSensitive,
      match.localIndex,
    );
    if (!res.replaced) return null;
    return {
      op: { op: 'updateBlockRuns', blockId: block.id, runs: res.runs },
      nextIndex,
    };
  }

  if (match.kind === 'listItem' && block.type === 'list' && match.listItemIndex !== undefined) {
    const item = block.items[match.listItemIndex];
    if (!item) return null;
    const res = replaceNthOccurrenceInRuns(
      item.runs,
      find,
      replace,
      caseSensitive,
      match.localIndex,
    );
    if (!res.replaced) return null;
    return {
      op: {
        op: 'updateListItem',
        blockId: block.id,
        itemIndex: match.listItemIndex,
        runs: res.runs,
        checked: item.checked ?? null,
      },
      nextIndex,
    };
  }

  if (match.kind === 'codeBlock' && block.type === 'codeBlock') {
    const res = replaceNthInPlainString(
      block.code,
      find,
      replace,
      caseSensitive,
      match.localIndex,
    );
    if (!res.replaced) return null;
    return {
      op: {
        op: 'updateCodeBlock',
        blockId: block.id,
        language: block.language ?? null,
        code: res.text,
      },
      nextIndex,
    };
  }

  return null;
}

function extractCellPlainText(blocks: Block[]): string {
  return blocks
    .map((b) => {
      if (b.type === 'paragraph' || b.type === 'heading') {
        return runsToPlainText(b.runs);
      }
      if (b.type === 'list') {
        return b.items
          .map((item) => {
            const own = runsToPlainText(item.runs);
            const nested = item.children.length > 0 ? extractCellPlainText(item.children) : '';
            return nested ? (own ? `${own}\n${nested}` : nested) : own;
          })
          .join('\n');
      }
      if (b.type === 'codeBlock') {
        return b.code;
      }
      if (b.type === 'blockQuote' || b.type === 'footnote') {
        return extractCellPlainText(b.blocks);
      }
      if (b.type === 'table') {
        return b.rows
          .map((row) => row.cells.map((cell) => extractCellPlainText(cell.blocks)).join(' | '))
          .filter((line) => line.trim().length > 0)
          .join('\n');
      }
      if (b.type === 'image') {
        return b.caption ?? b.alt ?? '';
      }
      return '';
    })
    .filter((s) => s.length > 0)
    .join('\n');
}

export const DocumentIrView = forwardRef<DocumentEditorHandle, DocumentIrViewProps>(
  (
    {
      ir,
      zoom,
      editable = false,
      autoFocusNonce = 0,
      externalSyncRev = 0,
      findQuery = '',
      findCaseSensitive = false,
      activeFindMatchIndex = 0,
      onFindMatchCountChange,
      onLiveDirty,
      onApplyEdit,
      onApplyEditsBatch,
      onSelectionStateChange,
      onRequestLinkDialog,
    },
    ref,
  ) => {
    const sheetRef = useRef<HTMLElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const editableEntriesRef = useRef<Map<string, EditableElEntry>>(new Map());
    const pendingCommitRef = useRef<{
      timer: number | null;
      op: EditOperation | null;
    }>({ timer: null, op: null });
    const cachedTargetRef = useRef<CachedTarget | null>(null);
    const pendingFocusRef = useRef<{ key: string; offset: number } | null>(null);
    const lastAutoFocusedNonceRef = useRef(0);
    const pendingStyleRef = useRef<PendingStyleState | null>(null);
    const editingCellRef = useRef<ActiveCellEdit | null>(null);
    const editingCodeRef = useRef<ActiveCodeEdit | null>(null);

    const [activeBlockId, setActiveBlockId] = useState<string | null>(
      ir.blocks[0]?.id ?? null,
    );
    const [editingCodeId, setEditingCodeId] = useState<string | null>(null);
    const [codeDraft, setCodeDraft] = useState('');
    const [editingCellId, setEditingCellId] = useState<string | null>(null);
    const [cellDraft, setCellDraft] = useState('');

    const assetMap = useMemo(() => {
      const m = new Map<string, MediaAsset>();
      for (const a of ir.assets) {
        m.set(a.id, a);
      }
      return m;
    }, [ir.assets]);

    const findResults = useMemo(
      () => collectFindMatches(ir.blocks, findQuery, findCaseSensitive),
      [findCaseSensitive, findQuery, ir.blocks],
    );

    useEffect(() => {
      onFindMatchCountChange?.(findResults.matches.length);
    }, [findResults.matches.length, onFindMatchCountChange]);

    const activeMatchTopBlockId = useMemo(() => {
      if (findResults.matches.length === 0) return null;
      const safeIdx =
        ((activeFindMatchIndex % findResults.matches.length) + findResults.matches.length) %
        findResults.matches.length;
      return findResults.matches[safeIdx]?.topBlockId ?? null;
    }, [activeFindMatchIndex, findResults.matches]);

    useEffect(() => {
      if (!activeMatchTopBlockId || !findQuery) return;
      const el = document.getElementById(activeMatchTopBlockId);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, [activeMatchTopBlockId, activeFindMatchIndex, findQuery]);

    const dispatchEdit = useCallback(
      (op: EditOperation, options?: { syncDom?: boolean }) => {
        if (!onApplyEdit) return;
        void onApplyEdit(op, options);
      },
      [onApplyEdit],
    );

    const dispatchBatch = useCallback(
      (ops: EditOperation[], options?: { syncDom?: boolean }) => {
        if (ops.length === 0) return;
        if (onApplyEditsBatch) {
          void onApplyEditsBatch(ops, options);
        } else if (onApplyEdit) {
          for (const op of ops) {
            void onApplyEdit(op, options);
          }
        }
      },
      [onApplyEdit, onApplyEditsBatch],
    );

    const cancelActiveCellAndCodeEdits = useCallback(() => {
      editingCellRef.current = null;
      editingCodeRef.current = null;
      setEditingCellId(null);
      setEditingCodeId(null);
    }, []);

    const commitActiveCellAndCodeEdits = useCallback(() => {
      if (editingCellRef.current) {
        const active = editingCellRef.current;
        editingCellRef.current = null;
        setEditingCellId(null);
        if (active.draft !== active.originalPlain) {
          dispatchEdit({
            op: 'updateTableCell',
            blockId: active.blockId,
            row: active.row,
            col: active.col,
            text: active.draft,
          });
        }
      }
      if (editingCodeRef.current) {
        const active = editingCodeRef.current;
        editingCodeRef.current = null;
        setEditingCodeId(null);
        if (active.draft !== active.originalCode) {
          dispatchEdit({
            op: 'updateCodeBlock',
            blockId: active.blockId,
            language: active.language,
            code: active.draft,
          });
        }
      }
    }, [dispatchEdit]);

    const clearPendingEdit = useCallback(() => {
      if (pendingCommitRef.current.timer !== null) {
        window.clearTimeout(pendingCommitRef.current.timer);
        pendingCommitRef.current.timer = null;
      }
      pendingCommitRef.current.op = null;
      cancelActiveCellAndCodeEdits();
    }, [cancelActiveCellAndCodeEdits]);

    const flushPendingEdits = useCallback(() => {
      if (pendingCommitRef.current.timer !== null) {
        window.clearTimeout(pendingCommitRef.current.timer);
        pendingCommitRef.current.timer = null;
      }
      const op = pendingCommitRef.current.op;
      pendingCommitRef.current.op = null;
      if (op) {
        dispatchEdit(op);
      }
      commitActiveCellAndCodeEdits();
    }, [commitActiveCellAndCodeEdits, dispatchEdit]);

    // Clear stale stored marks and active textarea editors on external sync (Undo/Redo/Replace/Error)
    useEffect(() => {
      pendingStyleRef.current = null;
      cancelActiveCellAndCodeEdits();
    }, [externalSyncRev, cancelActiveCellAndCodeEdits]);

    const scheduleCommit = useCallback(
      (op: EditOperation) => {
        onLiveDirty?.();
        if (pendingCommitRef.current.timer !== null) {
          window.clearTimeout(pendingCommitRef.current.timer);
        }
        pendingCommitRef.current.op = op;
        pendingCommitRef.current.timer = window.setTimeout(() => {
          pendingCommitRef.current.timer = null;
          const next = pendingCommitRef.current.op;
          pendingCommitRef.current.op = null;
          if (next) {
            dispatchEdit(next);
          }
        }, 260);
      },
      [dispatchEdit, onLiveDirty],
    );

    useEffect(() => {
      return () => {
        if (pendingCommitRef.current.timer !== null) {
          window.clearTimeout(pendingCommitRef.current.timer);
        }
      };
    }, []);

    const getKeyForTarget = (blockId: string, listItemIndex?: number): string =>
      listItemIndex !== undefined ? `li:${blockId}:${listItemIndex}` : `block:${blockId}`;

    const registerEditableEntry = useCallback(
      (key: string) => (entry: EditableElEntry | null) => {
        if (entry) {
          editableEntriesRef.current.set(key, entry);
        } else {
          editableEntriesRef.current.delete(key);
        }
      },
      [],
    );

    // Focus requested block after render
    useEffect(() => {
      if (!editable || !pendingFocusRef.current) return;
      const { key, offset } = pendingFocusRef.current;
      const entry = editableEntriesRef.current.get(key);
      if (entry) {
        pendingFocusRef.current = null;
        entry.el.focus();
        setSelectionOffsetsInElement(entry.el, offset, offset);
      }
    });

    // Auto-focus first block ONCE per brand-new document nonce
    useEffect(() => {
      if (
        !editable ||
        autoFocusNonce === 0 ||
        autoFocusNonce === lastAutoFocusedNonceRef.current
      ) {
        return;
      }
      const first = ir.blocks[0];
      if (!first) return;
      lastAutoFocusedNonceRef.current = autoFocusNonce;

      const key =
        first.type === 'list'
          ? getKeyForTarget(first.id, 0)
          : first.type === 'blockQuote' && first.blocks[0]
            ? getKeyForTarget(first.blocks[0].id)
            : getKeyForTarget(first.id);
      setActiveBlockId(first.id);
      cachedTargetRef.current = {
        blockId:
          first.type === 'blockQuote' && first.blocks[0] ? first.blocks[0].id : first.id,
        listItemIndex: first.type === 'list' ? 0 : undefined,
        start: 0,
        end: 0,
      };
      const entry = editableEntriesRef.current.get(key);
      if (entry) {
        entry.el.focus();
        setSelectionOffsetsInElement(entry.el, 0, 0);
      } else {
        pendingFocusRef.current = { key, offset: 0 };
      }
    }, [autoFocusNonce, editable, ir.blocks]);

    const resolveValidTargetBlockId = useCallback((): string | null => {
      const cachedId = cachedTargetRef.current?.blockId ?? null;
      if (cachedId && findBlockById(ir.blocks, cachedId)) {
        return cachedId;
      }
      if (activeBlockId && findBlockById(ir.blocks, activeBlockId)) {
        return activeBlockId;
      }
      return ir.blocks[0]?.id ?? null;
    }, [activeBlockId, ir.blocks]);

    // Sanitize cachedTargetRef metadata and keep activeBlockId valid when blocks change or convert
    useEffect(() => {
      const cached = cachedTargetRef.current;
      if (cached) {
        const existing = findBlockById(ir.blocks, cached.blockId);
        if (!existing) {
          cachedTargetRef.current = null;
        } else if (existing.type === 'list') {
          cachedTargetRef.current = {
            blockId: existing.id,
            listItemIndex:
              existing.items.length > 0
                ? Math.max(0, Math.min(cached.listItemIndex ?? 0, existing.items.length - 1))
                : undefined,
            start: cached.start,
            end: cached.end,
          };
        } else if (existing.type === 'table') {
          const rowCount = existing.rows.length;
          const colCount = existing.rows[0]?.cells.length ?? 0;
          cachedTargetRef.current = {
            blockId: existing.id,
            tableRow: rowCount > 0 ? Math.max(0, Math.min(cached.tableRow ?? 0, rowCount - 1)) : 0,
            tableCol: colCount > 0 ? Math.max(0, Math.min(cached.tableCol ?? 0, colCount - 1)) : 0,
            start: 0,
            end: 0,
          };
        } else if (
          (existing.type === 'blockQuote' || existing.type === 'footnote') &&
          existing.blocks[0] &&
          (existing.blocks[0].type === 'paragraph' || existing.blocks[0].type === 'heading')
        ) {
          cachedTargetRef.current = {
            blockId: existing.blocks[0].id,
            start: cached.start,
            end: cached.end,
          };
        } else {
          cachedTargetRef.current = {
            blockId: existing.id,
            start: cached.start,
            end: cached.end,
          };
        }
      }
      setActiveBlockId((prev) => {
        if (prev && findBlockById(ir.blocks, prev)) return prev;
        return ir.blocks[0]?.id ?? null;
      });
    }, [ir.blocks]);

    const computeSelectionState = useCallback((): EditorSelectionState => {
      const rawBlockId = resolveValidTargetBlockId();
      const topBlock = findTopLevelAncestor(ir.blocks, rawBlockId);
      const rawBlock = findBlockById(ir.blocks, rawBlockId);
      const block = topBlock ?? rawBlock;
      if (!block) return DEFAULT_SELECTION_STATE;
      const rawTarget = cachedTargetRef.current;
      const target =
        rawTarget &&
        (rawTarget.blockId === rawBlockId ||
          rawTarget.blockId === block.id ||
          findTopLevelAncestor(ir.blocks, rawTarget.blockId)?.id === block.id)
          ? rawTarget
          : null;

      let headingLevel: number | null = null;
      let listKind: 'bullet' | 'ordered' | 'checklist' | null = null;
      let align: TextAlign = 'left';
      let indentLevel = 0;
      let runs: InlineRun[] = [];
      let elKey = getKeyForTarget(block.id);

      if (block.type === 'heading') {
        headingLevel = block.level;
        align = block.align;
        runs = block.runs;
        elKey = getKeyForTarget(block.id);
      } else if (block.type === 'paragraph') {
        align = block.align;
        indentLevel = block.indentLevel;
        runs = block.runs;
        elKey = getKeyForTarget(block.id);
      } else if (block.type === 'list') {
        const isChecklist = block.items.some(
          (i) => i.checked !== null && i.checked !== undefined,
        );
        listKind = isChecklist ? 'checklist' : block.ordered ? 'ordered' : 'bullet';
        const idx = Math.min(target?.listItemIndex ?? 0, Math.max(0, block.items.length - 1));
        runs = block.items[idx]?.runs ?? [];
        elKey = getKeyForTarget(block.id, idx);
      } else if (block.type === 'blockQuote' || block.type === 'footnote') {
        const inner =
          rawBlock && rawBlock.id !== block.id ? rawBlock : (block.blocks[0] ?? null);
        if (inner && (inner.type === 'paragraph' || inner.type === 'heading')) {
          align = inner.align;
          if (inner.type === 'paragraph') indentLevel = inner.indentLevel;
          runs = inner.runs;
          elKey = getKeyForTarget(inner.id);
        }
      }

      const entry = editableEntriesRef.current.get(elKey);
      let start = target?.start ?? 0;
      let end = target?.end ?? 0;
      if (entry) {
        runs = domToRuns(entry.el);
        const liveSel = getSelectionOffsetsInElement(entry.el);
        if (liveSel) {
          start = liveSel.start;
          end = liveSel.end;
        }
      }

      const plain = runsToPlainText(runs);
      const selectedText = end > start ? plain.slice(start, end) : '';
      let textStyle = getStyleAtRange(runs, start, end);
      const activeLinkText =
        end > start
          ? textStyle.href
            ? selectedText
            : ''
          : (getLinkRunAtOffset(runs, start)?.text ?? '');

      const pending = pendingStyleRef.current;
      if (start === end && pending && pending.key === elKey && pending.offset === start) {
        textStyle = pending.style;
      }

      const canAlign =
        block.type === 'paragraph' || block.type === 'heading' || block.type === 'blockQuote';
      const canIndent = block.type === 'paragraph' || block.type === 'blockQuote';
      const tableRowCount = block.type === 'table' ? block.rows.length : 0;
      const tableColCount = block.type === 'table' ? (block.rows[0]?.cells.length ?? 0) : 0;

      return {
        activeBlockId: block.id,
        blockType: block.type,
        headingLevel,
        listKind,
        align,
        indentLevel,
        canAlign,
        canIndent,
        inTable: block.type === 'table',
        tableRow: block.type === 'table' ? (target?.tableRow ?? 0) : null,
        tableCol: block.type === 'table' ? (target?.tableCol ?? 0) : null,
        tableRowCount,
        tableColCount,
        textStyle,
        hasTextSelection: end > start,
        selectedText,
        activeLinkText,
      };
    }, [ir.blocks, resolveValidTargetBlockId]);

    const emitSelectionState = useCallback(() => {
      if (onSelectionStateChange) {
        onSelectionStateChange(computeSelectionState());
      }
    }, [computeSelectionState, onSelectionStateChange]);

    // Track browser selection changes inside editable blocks
    useEffect(() => {
      if (!editable) return;
      const handleSelectionChange = () => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const anchor = sel.anchorNode;
        if (!anchor || !sheetRef.current?.contains(anchor)) return;

        for (const [key, entry] of editableEntriesRef.current.entries()) {
          if (entry.el.contains(anchor)) {
            const offsets = getSelectionOffsetsInElement(entry.el);
            if (!offsets) return;

            // Invalidate stored marks if caret moved elsewhere
            if (
              pendingStyleRef.current &&
              (pendingStyleRef.current.key !== key ||
                offsets.start !== offsets.end ||
                pendingStyleRef.current.offset !== offsets.start)
            ) {
              pendingStyleRef.current = null;
            }

            if (key.startsWith('li:')) {
              const parts = key.split(':');
              const itemIdx = Number.parseInt(parts[parts.length - 1], 10);
              const blockId = parts.slice(1, -1).join(':');
              cachedTargetRef.current = {
                blockId,
                listItemIndex: itemIdx,
                start: offsets.start,
                end: offsets.end,
              };
              setActiveBlockId(blockId);
            } else if (key.startsWith('block:')) {
              const blockId = key.slice('block:'.length);
              cachedTargetRef.current = {
                blockId,
                start: offsets.start,
                end: offsets.end,
              };
              const top = findTopLevelAncestor(ir.blocks, blockId);
              setActiveBlockId(top?.id ?? blockId);
            }
            emitSelectionState();
            return;
          }
        }
      };

      document.addEventListener('selectionchange', handleSelectionChange);
      return () => document.removeEventListener('selectionchange', handleSelectionChange);
    }, [editable, emitSelectionState, ir.blocks]);

    useEffect(() => {
      emitSelectionState();
    }, [ir, activeBlockId, emitSelectionState]);

    const getEditableTarget = useCallback((): {
      block: Block;
      targetBlockId: string;
      elKey: string;
      listItemIndex?: number;
      entry: EditableElEntry | null;
      runs: InlineRun[];
      start: number;
      end: number;
    } | null => {
      const blockId = resolveValidTargetBlockId();
      const block = findBlockById(ir.blocks, blockId);
      if (!block) return null;
      const rawCached = cachedTargetRef.current;
      const cached =
        rawCached &&
        (rawCached.blockId === block.id ||
          ((block.type === 'blockQuote' || block.type === 'footnote') &&
            block.blocks[0]?.id === rawCached.blockId))
          ? rawCached
          : null;

      if (block.type === 'paragraph' || block.type === 'heading') {
        const elKey = getKeyForTarget(block.id);
        const entry = editableEntriesRef.current.get(elKey) ?? null;
        const runs = entry ? domToRuns(entry.el) : block.runs;
        const live = entry ? getSelectionOffsetsInElement(entry.el) : null;
        return {
          block,
          targetBlockId: block.id,
          elKey,
          entry,
          runs,
          start: live?.start ?? cached?.start ?? 0,
          end: live?.end ?? cached?.end ?? 0,
        };
      }

      if (block.type === 'list') {
        const itemIndex = Math.min(cached?.listItemIndex ?? 0, Math.max(0, block.items.length - 1));
        const item = block.items[itemIndex];
        if (!item) return null;
        const elKey = getKeyForTarget(block.id, itemIndex);
        const entry = editableEntriesRef.current.get(elKey) ?? null;
        const runs = entry ? domToRuns(entry.el) : item.runs;
        const live = entry ? getSelectionOffsetsInElement(entry.el) : null;
        return {
          block,
          targetBlockId: block.id,
          elKey,
          listItemIndex: itemIndex,
          entry,
          runs,
          start: live?.start ?? cached?.start ?? 0,
          end: live?.end ?? cached?.end ?? 0,
        };
      }

      if ((block.type === 'blockQuote' || block.type === 'footnote') && block.blocks[0]) {
        const inner = block.blocks[0];
        if (inner.type === 'paragraph' || inner.type === 'heading') {
          const elKey = getKeyForTarget(inner.id);
          const entry = editableEntriesRef.current.get(elKey) ?? null;
          const runs = entry ? domToRuns(entry.el) : inner.runs;
          const live = entry ? getSelectionOffsetsInElement(entry.el) : null;
          return {
            block: inner,
            targetBlockId: inner.id,
            elKey,
            entry,
            runs,
            start: live?.start ?? cached?.start ?? 0,
            end: live?.end ?? cached?.end ?? 0,
          };
        }
      }

      return null;
    }, [ir.blocks, resolveValidTargetBlockId]);

    const commitRunsForTarget = useCallback(
      (
        ctx: NonNullable<ReturnType<typeof getEditableTarget>>,
        nextRuns: InlineRun[],
        nextStart: number,
        nextEnd: number,
      ) => {
        const maxLen = runsToPlainText(nextRuns).length;
        const clampedStart = Math.max(0, Math.min(nextStart, maxLen));
        const clampedEnd = Math.max(clampedStart, Math.min(nextEnd, maxLen));

        if (ctx.entry) {
          ctx.entry.el.innerHTML = runsToSafeHtml(nextRuns);
          ctx.entry.setSyncedRuns(nextRuns);
          ctx.entry.el.focus();
          setSelectionOffsetsInElement(ctx.entry.el, clampedStart, clampedEnd);
        }

        cachedTargetRef.current = {
          blockId: ctx.targetBlockId,
          listItemIndex: ctx.listItemIndex,
          start: clampedStart,
          end: clampedEnd,
        };

        if (ctx.block.type === 'list' && ctx.listItemIndex !== undefined) {
          const item = ctx.block.items[ctx.listItemIndex];
          dispatchEdit({
            op: 'updateListItem',
            blockId: ctx.targetBlockId,
            itemIndex: ctx.listItemIndex,
            runs: nextRuns,
            checked: item?.checked ?? null,
          });
        } else {
          dispatchEdit({
            op: 'updateBlockRuns',
            blockId: ctx.targetBlockId,
            runs: nextRuns,
          });
        }
        emitSelectionState();
      },
      [dispatchEdit, emitSelectionState],
    );

    const applyRangeInlineMutation = useCallback(
      (
        transform: (runs: InlineRun[], start: number, end: number) => InlineRun[],
        onCollapsed?: (baseStyle: TextStyle) => TextStyle,
      ) => {
        if (!editable) return;
        flushPendingEdits();
        const ctx = getEditableTarget();
        if (!ctx) return;

        // Collapsed caret or empty paragraph -> update stored marks without reformatting the whole paragraph
        if (ctx.start === ctx.end && onCollapsed) {
          const existing =
            pendingStyleRef.current &&
            pendingStyleRef.current.key === ctx.elKey &&
            pendingStyleRef.current.offset === ctx.start
              ? pendingStyleRef.current.style
              : getStyleAtRange(ctx.runs, ctx.start, ctx.start);
          const nextStyle = normalizeStyle(onCollapsed(existing));
          pendingStyleRef.current = {
            key: ctx.elKey,
            offset: ctx.start,
            style: nextStyle,
          };
          if (ctx.entry) {
            ctx.entry.el.focus();
            setSelectionOffsetsInElement(ctx.entry.el, ctx.start, ctx.start);
          }
          cachedTargetRef.current = {
            blockId: ctx.targetBlockId,
            listItemIndex: ctx.listItemIndex,
            start: ctx.start,
            end: ctx.start,
          };
          emitSelectionState();
          return;
        }

        pendingStyleRef.current = null;
        const nextRuns = transform(ctx.runs, ctx.start, ctx.end);
        const deltaLen = runsToPlainText(nextRuns).length - runsToPlainText(ctx.runs).length;
        const nextEnd = Math.max(ctx.start, ctx.end + deltaLen);
        commitRunsForTarget(ctx, nextRuns, ctx.start, nextEnd);
      },
      [commitRunsForTarget, editable, emitSelectionState, flushPendingEdits, getEditableTarget],
    );

    const resolveTopLevelBlockId = useCallback((): string | null => {
      const cachedId = cachedTargetRef.current?.blockId ?? null;
      if (cachedId) {
        const topFromCache = findTopLevelAncestor(ir.blocks, cachedId);
        if (topFromCache) return topFromCache.id;
      }
      if (activeBlockId) {
        const topFromActive = findTopLevelAncestor(ir.blocks, activeBlockId);
        if (topFromActive) return topFromActive.id;
      }
      return ir.blocks[ir.blocks.length - 1]?.id ?? null;
    }, [activeBlockId, ir.blocks]);

    const getBlockEndFocusTarget = useCallback(
      (b: Block): { key: string; blockId: string; listItemIndex?: number; offset: number } | null => {
        if (b.type === 'paragraph' || b.type === 'heading') {
          const key = getKeyForTarget(b.id);
          const entry = editableEntriesRef.current.get(key);
          const runs = entry ? domToRuns(entry.el) : b.runs;
          return {
            key,
            blockId: b.id,
            offset: runsToPlainText(runs).length,
          };
        }
        if (b.type === 'list' && b.items.length > 0) {
          const lastIdx = b.items.length - 1;
          const key = getKeyForTarget(b.id, lastIdx);
          const entry = editableEntriesRef.current.get(key);
          const runs = entry ? domToRuns(entry.el) : b.items[lastIdx].runs;
          return {
            key,
            blockId: b.id,
            listItemIndex: lastIdx,
            offset: runsToPlainText(runs).length,
          };
        }
        if (b.type === 'blockQuote' || b.type === 'footnote') {
          const lastInner = b.blocks[b.blocks.length - 1];
          if (lastInner && (lastInner.type === 'paragraph' || lastInner.type === 'heading')) {
            const key = getKeyForTarget(lastInner.id);
            const entry = editableEntriesRef.current.get(key);
            const runs = entry ? domToRuns(entry.el) : lastInner.runs;
            return {
              key,
              blockId: lastInner.id,
              offset: runsToPlainText(runs).length,
            };
          }
        }
        return null;
      },
      [],
    );

    const focusBlock = useCallback(
      (blockId: string, offset = 0) => {
        if (!editable) return;
        const block = findBlockById(ir.blocks, blockId);
        const firstChild =
          block?.type === 'blockQuote' || block?.type === 'footnote'
            ? (block.blocks[0] ?? null)
            : null;
        let targetId = blockId;
        let listItemIndex: number | undefined = block?.type === 'list' ? 0 : undefined;
        let canQueueEditableFocus =
          !block ||
          block.type === 'paragraph' ||
          block.type === 'heading' ||
          block.type === 'list';

        if (firstChild) {
          if (firstChild.type === 'paragraph' || firstChild.type === 'heading') {
            targetId = firstChild.id;
            listItemIndex = undefined;
            canQueueEditableFocus = true;
          } else if (firstChild.type === 'list') {
            targetId = firstChild.id;
            listItemIndex = 0;
            canQueueEditableFocus = true;
          } else {
            targetId = blockId;
            listItemIndex = undefined;
            canQueueEditableFocus = false;
          }
        }

        const key = getKeyForTarget(targetId, listItemIndex);
        const top = findTopLevelAncestor(ir.blocks, blockId);
        setActiveBlockId(top?.id ?? blockId);
        cachedTargetRef.current = {
          blockId: targetId,
          listItemIndex,
          start: offset,
          end: offset,
        };
        const entry = editableEntriesRef.current.get(key);
        if (entry) {
          entry.el.focus();
          setSelectionOffsetsInElement(entry.el, offset, offset);
        } else if (canQueueEditableFocus) {
          pendingFocusRef.current = { key, offset };
        }
      },
      [editable, ir.blocks],
    );

    const insertBlockAfterActive = useCallback(
      (block: Block, focusNew = true) => {
        if (!editable) return;
        flushPendingEdits();
        const afterBlockId = resolveTopLevelBlockId();
        const lastTopId = ir.blocks[ir.blocks.length - 1]?.id ?? null;
        const insertingAtEnd = afterBlockId === null || afterBlockId === lastTopId;
        const needsTrailingPara = insertingAtEnd && isNonTextBlock(block);

        const ops: EditOperation[] = [
          {
            op: 'insertBlockAfter',
            afterBlockId,
            block,
          },
        ];

        let trailingParaId: string | null = null;
        if (needsTrailingPara) {
          trailingParaId = makeUid('p');
          ops.push({
            op: 'insertBlockAfter',
            afterBlockId: block.id,
            block: {
              id: trailingParaId,
              type: 'paragraph',
              runs: [],
              align: 'left',
              indentLevel: 0,
            },
          });
        }

        if (focusNew) {
          const focusKey =
            block.type === 'list'
              ? getKeyForTarget(block.id, 0)
              : (block.type === 'blockQuote' || block.type === 'footnote') && block.blocks[0]
                ? getKeyForTarget(block.blocks[0].id)
                : getKeyForTarget(block.id);
          pendingFocusRef.current = { key: focusKey, offset: 0 };
          setActiveBlockId(block.id);
        } else if (
          trailingParaId &&
          (block.type === 'horizontalRule' || block.type === 'pageBreak')
        ) {
          pendingFocusRef.current = { key: getKeyForTarget(trailingParaId), offset: 0 };
          setActiveBlockId(trailingParaId);
        } else {
          setActiveBlockId(block.id);
          cachedTargetRef.current = {
            blockId: block.id,
            tableRow: block.type === 'table' ? 0 : undefined,
            tableCol: block.type === 'table' ? 0 : undefined,
            start: 0,
            end: 0,
          };
        }

        if (ops.length === 1) {
          dispatchEdit(ops[0]);
        } else {
          dispatchBatch(ops);
        }
      },
      [dispatchBatch, dispatchEdit, editable, flushPendingEdits, ir.blocks, resolveTopLevelBlockId],
    );

    const replaceCurrentMatch = useCallback(
      (find: string, replace: string, caseSensitive: boolean): ReplaceCurrentResult => {
        if (!editable || !find || findResults.matches.length === 0) {
          return { replaced: false, nextIndex: 0 };
        }
        flushPendingEdits();
        const safeIdx =
          ((activeFindMatchIndex % findResults.matches.length) + findResults.matches.length) %
          findResults.matches.length;
        const match = findResults.matches[safeIdx];
        if (!match) return { replaced: false, nextIndex: 0 };

        const block = findBlockById(ir.blocks, match.blockId);
        if (!block) return { replaced: false, nextIndex: 0 };

        const advanceBy = countTextOccurrences(replace, find, caseSensitive);
        const nextIndex = safeIdx + advanceBy;

        if (match.kind === 'runs' && (block.type === 'paragraph' || block.type === 'heading')) {
          const res = replaceNthOccurrenceInRuns(
            block.runs,
            find,
            replace,
            caseSensitive,
            match.localIndex,
          );
          if (!res.replaced) return { replaced: false, nextIndex: 0 };
          dispatchEdit(
            { op: 'updateBlockRuns', blockId: block.id, runs: res.runs },
            { syncDom: true },
          );
          return { replaced: true, nextIndex };
        }

        if (match.kind === 'listItem' && block.type === 'list' && match.listItemIndex !== undefined) {
          const item = block.items[match.listItemIndex];
          if (!item) return { replaced: false, nextIndex: 0 };
          const res = replaceNthOccurrenceInRuns(
            item.runs,
            find,
            replace,
            caseSensitive,
            match.localIndex,
          );
          if (!res.replaced) return { replaced: false, nextIndex: 0 };
          dispatchEdit(
            {
              op: 'updateListItem',
              blockId: block.id,
              itemIndex: match.listItemIndex,
              runs: res.runs,
              checked: item.checked ?? null,
            },
            { syncDom: true },
          );
          return { replaced: true, nextIndex };
        }

        if (match.kind === 'codeBlock' && block.type === 'codeBlock') {
          const res = replaceNthInPlainString(
            block.code,
            find,
            replace,
            caseSensitive,
            match.localIndex,
          );
          if (!res.replaced) return { replaced: false, nextIndex: 0 };
          dispatchEdit(
            {
              op: 'updateCodeBlock',
              blockId: block.id,
              language: block.language ?? null,
              code: res.text,
            },
            { syncDom: true },
          );
          return { replaced: true, nextIndex };
        }

        return { replaced: false, nextIndex: 0 };
      },
      [
        activeFindMatchIndex,
        dispatchEdit,
        editable,
        findResults.matches,
        flushPendingEdits,
        ir.blocks,
      ],
    );

    useImperativeHandle(
      ref,
      () => ({
        focusEditor: () => {
          if (!editable) return;
          const target = cachedTargetRef.current;
          if (target) {
            const existing = findBlockById(ir.blocks, target.blockId);
            if (existing) {
              const key =
                existing.type === 'list'
                  ? getKeyForTarget(
                      existing.id,
                      Math.max(
                        0,
                        Math.min(target.listItemIndex ?? 0, Math.max(0, existing.items.length - 1)),
                      ),
                    )
                  : (existing.type === 'blockQuote' || existing.type === 'footnote') &&
                      existing.blocks[0]
                    ? getKeyForTarget(existing.blocks[0].id)
                    : getKeyForTarget(existing.id);
              const entry = editableEntriesRef.current.get(key);
              if (entry) {
                entry.el.focus();
                const maxLen = runsToPlainText(domToRuns(entry.el)).length;
                setSelectionOffsetsInElement(
                  entry.el,
                  Math.max(0, Math.min(target.start, maxLen)),
                  Math.max(0, Math.min(target.end, maxLen)),
                );
                return;
              }
              if (isNonTextBlock(existing) && existing.type !== 'footnote') {
                return;
              }
              focusBlock(existing.id, target.start);
              return;
            }
          }
          if (activeBlockId && findBlockById(ir.blocks, activeBlockId)) {
            focusBlock(activeBlockId, 0);
            return;
          }
          const first = ir.blocks[0];
          if (first) focusBlock(first.id, 0);
        },
        focusBlock,
        flushPendingEdits,
        discardPendingEdits: clearPendingEdit,
        hasPendingEdits: () =>
          pendingCommitRef.current.op !== null ||
          (editingCodeRef.current !== null &&
            editingCodeRef.current.draft !== editingCodeRef.current.originalCode) ||
          (editingCellRef.current !== null &&
            editingCellRef.current.draft !== editingCellRef.current.originalPlain),
        getTopLevelBlockId: resolveTopLevelBlockId,
        toggleInlineStyle: (flag) => {
          applyRangeInlineMutation(
            (runs, s, e) => toggleStyleInRange(runs, s, e, flag),
            (base) => toggleStyleFlag(base, flag),
          );
        },
        setFontSize: (sizePt) => {
          applyRangeInlineMutation(
            (runs, s, e) => setFontSizeInRange(runs, s, e, sizePt),
            (base) => ({ ...base, fontSizePt: sizePt }),
          );
        },
        applyLink: (href, label) => {
          if (!editable) return;
          flushPendingEdits();
          const ctx = getEditableTarget();
          if (!ctx) return;
          pendingStyleRef.current = null;
          const existingLink =
            ctx.start === ctx.end ? getLinkRunAtOffset(ctx.runs, ctx.start) : null;
          const nextRuns = setLinkInRange(ctx.runs, ctx.start, ctx.end, href, label);
          if (runsEqual(nextRuns, ctx.runs)) return;
          const nextPlainLen = runsToPlainText(nextRuns).length;
          const deltaLen = nextPlainLen - runsToPlainText(ctx.runs).length;
          let nextStart: number;
          let nextEnd: number;
          if (ctx.start === ctx.end) {
            if (existingLink) {
              const targetOffset =
                href === null || href.trim() === ''
                  ? ctx.start
                  : Math.min(existingLink.end + deltaLen, nextPlainLen);
              nextStart = Math.max(0, targetOffset);
              nextEnd = nextStart;
            } else {
              nextStart = ctx.start + Math.max(0, deltaLen);
              nextEnd = nextStart;
            }
          } else {
            nextStart = ctx.start;
            nextEnd = Math.max(ctx.start, ctx.end + deltaLen);
          }
          commitRunsForTarget(ctx, nextRuns, nextStart, nextEnd);
        },
        clearFormatting: () => {
          applyRangeInlineMutation(
            (runs, s, e) => clearStyleInRange(runs, s, e),
            () => ({}),
          );
        },
        setAlignment: (align) => {
          if (!editable) return;
          flushPendingEdits();
          const blockId = resolveTopLevelBlockId();
          const block = findBlockById(ir.blocks, blockId);
          if (
            !block ||
            (block.type !== 'paragraph' &&
              block.type !== 'heading' &&
              block.type !== 'blockQuote')
          ) {
            return;
          }
          dispatchEdit({ op: 'setBlockAlign', blockId: block.id, align });
        },
        changeIndent: (delta) => {
          if (!editable) return;
          flushPendingEdits();
          const blockId = resolveTopLevelBlockId();
          const block = findBlockById(ir.blocks, blockId);
          if (!block || (block.type !== 'paragraph' && block.type !== 'blockQuote')) {
            return;
          }
          const current =
            block.type === 'paragraph'
              ? block.indentLevel
              : block.blocks[0]?.type === 'paragraph'
                ? block.blocks[0].indentLevel
                : 0;
          const next = Math.max(0, Math.min(6, current + delta));
          if (next === current) return;
          dispatchEdit({ op: 'setBlockIndent', blockId: block.id, indentLevel: next });
        },
        convertActiveBlock: (target) => {
          if (!editable) return;
          flushPendingEdits();
          const blockId = resolveTopLevelBlockId();
          const block = findBlockById(ir.blocks, blockId);
          if (!block) {
            const id = makeUid('blk');
            const newBlock: Block =
              target.kind === 'heading'
                ? { id, type: 'heading', level: target.level, runs: [], align: 'left' }
                : target.kind === 'codeBlock'
                  ? { id, type: 'codeBlock', language: null, code: '' }
                  : target.kind === 'blockQuote'
                    ? {
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
                      }
                    : target.kind === 'list'
                      ? {
                          id,
                          type: 'list',
                          ordered: target.ordered,
                          start: 1,
                          items: [
                            {
                              id: `${id}-li0`,
                              checked: target.checklist ? false : null,
                              runs: [],
                              children: [],
                            },
                          ],
                        }
                      : { id, type: 'paragraph', runs: [], align: 'left', indentLevel: 0 };
            insertBlockAfterActive(newBlock, target.kind !== 'codeBlock');
            return;
          }
          if (
            block.type === 'table' ||
            block.type === 'image' ||
            block.type === 'horizontalRule' ||
            block.type === 'pageBreak' ||
            block.type === 'footnote'
          ) {
            return;
          }
          if (target.kind === 'codeBlock') {
            pendingFocusRef.current = null;
            setActiveBlockId(block.id);
            cachedTargetRef.current = { blockId: block.id, start: 0, end: 0 };
          } else {
            const focusKey =
              target.kind === 'list'
                ? getKeyForTarget(block.id, 0)
                : target.kind === 'blockQuote'
                  ? getKeyForTarget(`${block.id}-q0`)
                  : getKeyForTarget(block.id);
            pendingFocusRef.current = { key: focusKey, offset: 0 };
          }
          dispatchEdit({ op: 'convertBlockKind', blockId: block.id, target });
        },
        insertBlockAfterActive,
        insertTable: (rowCount, colCount) => {
          const rows = Math.max(1, Math.min(rowCount, 12));
          const cols = Math.max(1, Math.min(colCount, 10));
          const tblId = makeUid('tbl');
          const tableBlock: Block = {
            id: tblId,
            type: 'table',
            rows: Array.from({ length: rows }, (_, r) => ({
              header: r === 0,
              cells: Array.from({ length: cols }, (_, c) => {
                const cellId = `${tblId}-r${r}-c${c}`;
                return {
                  id: cellId,
                  colSpan: 1,
                  rowSpan: 1,
                  align: 'left' as TextAlign,
                  blocks: [
                    {
                      id: `${cellId}-p0`,
                      type: 'paragraph',
                      runs: [{ text: r === 0 ? `Column ${c + 1}` : '', style: {} }],
                      align: 'left' as TextAlign,
                      indentLevel: 0,
                    },
                  ],
                };
              }),
            })),
          };
          insertBlockAfterActive(tableBlock, false);
        },
        addTableRow: () => {
          flushPendingEdits();
          const topId = resolveTopLevelBlockId();
          const block = findBlockById(ir.blocks, topId);
          if (!block || block.type !== 'table') return;
          dispatchEdit({
            op: 'addTableRow',
            blockId: block.id,
            afterRow: Math.min(
              cachedTargetRef.current?.tableRow ?? block.rows.length - 1,
              Math.max(0, block.rows.length - 1),
            ),
          });
        },
        deleteTableRow: () => {
          flushPendingEdits();
          const topId = resolveTopLevelBlockId();
          const block = findBlockById(ir.blocks, topId);
          if (!block || block.type !== 'table' || block.rows.length <= 1) return;
          const row = Math.min(
            cachedTargetRef.current?.tableRow ?? block.rows.length - 1,
            block.rows.length - 1,
          );
          if (cachedTargetRef.current?.blockId === block.id) {
            cachedTargetRef.current = {
              ...cachedTargetRef.current,
              tableRow: Math.max(0, Math.min(row, block.rows.length - 2)),
            };
          }
          dispatchEdit({ op: 'deleteTableRow', blockId: block.id, row });
        },
        addTableColumn: () => {
          flushPendingEdits();
          const topId = resolveTopLevelBlockId();
          const block = findBlockById(ir.blocks, topId);
          if (!block || block.type !== 'table') return;
          const colCount = block.rows[0]?.cells.length ?? 0;
          const rawCol = cachedTargetRef.current?.tableCol;
          const afterCol =
            rawCol !== undefined ? Math.min(rawCol, Math.max(0, colCount - 1)) : null;
          dispatchEdit({
            op: 'addTableColumn',
            blockId: block.id,
            afterCol,
          });
        },
        deleteTableColumn: () => {
          flushPendingEdits();
          const topId = resolveTopLevelBlockId();
          const block = findBlockById(ir.blocks, topId);
          if (!block || block.type !== 'table') return;
          const colCount = block.rows[0]?.cells.length ?? 0;
          if (colCount <= 1) return;
          const col = Math.min(cachedTargetRef.current?.tableCol ?? 0, colCount - 1);
          if (cachedTargetRef.current?.blockId === block.id) {
            cachedTargetRef.current = {
              ...cachedTargetRef.current,
              tableCol: Math.max(0, Math.min(col, colCount - 2)),
            };
          }
          dispatchEdit({ op: 'deleteTableColumn', blockId: block.id, col });
        },
        selectAllContent: () => {
          const container = contentRef.current ?? sheetRef.current;
          if (!container) return;
          const sel = window.getSelection();
          if (!sel) return;
          const range = document.createRange();
          range.selectNodeContents(container);
          sel.removeAllRanges();
          sel.addRange(range);
        },
        clipboardCommand: async (cmd) => {
          const ctx = getEditableTarget();
          const domSel = window.getSelection()?.toString() ?? '';

          if (cmd === 'copy') {
            const selected =
              domSel ||
              (ctx && ctx.end > ctx.start
                ? runsToPlainText(ctx.runs).slice(ctx.start, ctx.end)
                : '');
            if (selected && navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(selected);
            }
            return;
          }

          if (cmd === 'cut') {
            const selected =
              ctx && ctx.end > ctx.start
                ? runsToPlainText(ctx.runs).slice(ctx.start, ctx.end)
                : domSel;
            if (selected && navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(selected);
            }
            if (editable && ctx && ctx.end > ctx.start) {
              flushPendingEdits();
              const nextRuns = insertStyledTextAtRange(ctx.runs, ctx.start, ctx.end, '', {});
              commitRunsForTarget(ctx, nextRuns, ctx.start, ctx.start);
            }
            return;
          }

          if ((cmd === 'paste' || cmd === 'pastePlain') && editable && ctx) {
            if (!navigator.clipboard?.readText) return;
            const rawText = await navigator.clipboard.readText();
            const text = rawText.replace(/\r\n?/g, '\n');
            if (!text) return;
            flushPendingEdits();
            const pending = pendingStyleRef.current;
            const style =
              cmd === 'pastePlain'
                ? {}
                : pending &&
                    ctx.start === ctx.end &&
                    pending.key === ctx.elKey &&
                    pending.offset === ctx.start
                  ? pending.style
                  : getStyleAtRange(ctx.runs, ctx.start, ctx.start);
            const nextRuns = insertStyledTextAtRange(ctx.runs, ctx.start, ctx.end, text, style);
            const caret = ctx.start + text.length;
            commitRunsForTarget(ctx, nextRuns, caret, caret);
          }
        },
        replaceCurrentMatch,
        getActiveSelectionState: computeSelectionState,
      }),
      [
        activeBlockId,
        applyRangeInlineMutation,
        clearPendingEdit,
        commitRunsForTarget,
        computeSelectionState,
        dispatchEdit,
        editable,
        flushPendingEdits,
        focusBlock,
        getEditableTarget,
        insertBlockAfterActive,
        ir.blocks,
        replaceCurrentMatch,
        resolveTopLevelBlockId,
      ],
    );

    const handleRichKeyDown = useCallback(
      (
        e: React.KeyboardEvent<HTMLElement>,
        el: HTMLElement,
        block: Block,
        isTopLevel: boolean,
        listItemIndex?: number,
      ) => {
        const mod = e.metaKey || e.ctrlKey;
        const key = e.key.toLowerCase();

        // Inline formatting shortcuts
        if (mod && !e.altKey) {
          if (key === 'b') {
            e.preventDefault();
            applyRangeInlineMutation(
              (runs, s, en) => toggleStyleInRange(runs, s, en, 'bold'),
              (base) => toggleStyleFlag(base, 'bold'),
            );
            return;
          }
          if (key === 'i') {
            e.preventDefault();
            applyRangeInlineMutation(
              (runs, s, en) => toggleStyleInRange(runs, s, en, 'italic'),
              (base) => toggleStyleFlag(base, 'italic'),
            );
            return;
          }
          if (key === 'u') {
            e.preventDefault();
            applyRangeInlineMutation(
              (runs, s, en) => toggleStyleInRange(runs, s, en, 'underline'),
              (base) => toggleStyleFlag(base, 'underline'),
            );
            return;
          }
          if (key === '\\') {
            e.preventDefault();
            applyRangeInlineMutation(
              (runs, s, en) => clearStyleInRange(runs, s, en),
              () => ({}),
            );
            return;
          }
          if (key === 'k') {
            e.preventDefault();
            onRequestLinkDialog?.();
            return;
          }
          if (key === 'enter') {
            e.preventDefault();
            const pbId = makeUid('pb');
            const nextParaId = makeUid('p');
            flushPendingEdits();
            pendingFocusRef.current = { key: getKeyForTarget(nextParaId), offset: 0 };
            setActiveBlockId(nextParaId);
            dispatchBatch([
              {
                op: 'insertBlockAfter',
                afterBlockId: resolveTopLevelBlockId(),
                block: { id: pbId, type: 'pageBreak' },
              },
              {
                op: 'insertBlockAfter',
                afterBlockId: pbId,
                block: {
                  id: nextParaId,
                  type: 'paragraph',
                  runs: [],
                  align: 'left',
                  indentLevel: 0,
                },
              },
            ]);
            return;
          }
        }

        // Tab indentation for paragraphs (and blockQuote inner paragraphs)
        if (e.key === 'Tab' && block.type === 'paragraph') {
          const top = findTopLevelAncestor(ir.blocks, block.id);
          if (top && (top.type === 'paragraph' || top.type === 'blockQuote')) {
            e.preventDefault();
            flushPendingEdits();
            const delta = e.shiftKey ? -1 : 1;
            const nextIndent = Math.max(0, Math.min(6, block.indentLevel + delta));
            if (nextIndent !== block.indentLevel) {
              dispatchEdit({ op: 'setBlockIndent', blockId: top.id, indentLevel: nextIndent });
            }
            return;
          }
        }

        // Enter in list item -> add new item (or exit empty last item)
        if (e.key === 'Enter' && !e.shiftKey && block.type === 'list' && listItemIndex !== undefined) {
          e.preventDefault();
          clearPendingEdit();
          pendingStyleRef.current = null;
          const liveRuns = domToRuns(el);
          const item = block.items[listItemIndex];
          const plain = runsToPlainText(liveRuns);
          if (plain.trim() === '' && listItemIndex === block.items.length - 1) {
            if (block.items.length === 1) {
              pendingFocusRef.current = { key: getKeyForTarget(block.id), offset: 0 };
              setActiveBlockId(block.id);
              dispatchEdit({
                op: 'convertBlockKind',
                blockId: block.id,
                target: { kind: 'paragraph' },
              });
            } else {
              const nextParaId = makeUid('p');
              const afterBlockId =
                findTopLevelAncestor(ir.blocks, block.id)?.id ?? resolveTopLevelBlockId();
              pendingFocusRef.current = { key: getKeyForTarget(nextParaId), offset: 0 };
              setActiveBlockId(nextParaId);
              dispatchBatch([
                { op: 'deleteListItem', blockId: block.id, itemIndex: listItemIndex },
                {
                  op: 'insertBlockAfter',
                  afterBlockId,
                  block: {
                    id: nextParaId,
                    type: 'paragraph',
                    runs: [],
                    align: 'left',
                    indentLevel: 0,
                  },
                },
              ]);
            }
            return;
          }

          const sel = getSelectionOffsetsInElement(el);
          const start = sel?.start ?? plain.length;
          const end = sel?.end ?? start;
          const [before] = splitRunsAtOffset(liveRuns, start);
          const [, after] = splitRunsAtOffset(liveRuns, end);
          const newItemId = makeUid('li');
          const curEntry = editableEntriesRef.current.get(getKeyForTarget(block.id, listItemIndex));
          if (curEntry) {
            curEntry.el.innerHTML = runsToSafeHtml(before);
            curEntry.setSyncedRuns(before);
          }
          pendingFocusRef.current = {
            key: getKeyForTarget(block.id, listItemIndex + 1),
            offset: 0,
          };
          dispatchBatch([
            {
              op: 'updateListItem',
              blockId: block.id,
              itemIndex: listItemIndex,
              runs: before,
              checked: item?.checked ?? null,
            },
            {
              op: 'addListItem',
              blockId: block.id,
              afterIndex: listItemIndex,
              item: {
                id: newItemId,
                checked: item?.checked !== null && item?.checked !== undefined ? false : null,
                runs: after,
                children: [],
              },
            },
          ]);
          return;
        }

        // Enter inside BlockQuote or Footnote inner paragraph -> exit/split into new top-level paragraph below container
        if (
          e.key === 'Enter' &&
          !e.shiftKey &&
          !isTopLevel &&
          (block.type === 'paragraph' || block.type === 'heading')
        ) {
          const top = findTopLevelAncestor(ir.blocks, block.id);
          if (top && (top.type === 'blockQuote' || top.type === 'footnote')) {
            e.preventDefault();
            clearPendingEdit();
            pendingStyleRef.current = null;
            const liveRuns = domToRuns(el);
            const sel = getSelectionOffsetsInElement(el);
            const start = sel?.start ?? runsToPlainText(liveRuns).length;
            const end = sel?.end ?? start;
            const [before] = splitRunsAtOffset(liveRuns, start);
            const [, after] = splitRunsAtOffset(liveRuns, end);
            const curEntry = editableEntriesRef.current.get(getKeyForTarget(block.id));
            if (curEntry) {
              curEntry.el.innerHTML = runsToSafeHtml(before);
              curEntry.setSyncedRuns(before);
            }
            const newId = makeUid('p');
            pendingFocusRef.current = { key: getKeyForTarget(newId), offset: 0 };
            setActiveBlockId(newId);
            dispatchBatch([
              { op: 'updateBlockRuns', blockId: block.id, runs: before },
              {
                op: 'insertBlockAfter',
                afterBlockId: top.id,
                block: {
                  id: newId,
                  type: 'paragraph',
                  runs: after,
                  align: 'left',
                  indentLevel: 0,
                },
              },
            ]);
            return;
          }
        }

        // Enter in top-level paragraph or heading -> split into new paragraph (deleting selected range)
        if (
          e.key === 'Enter' &&
          !e.shiftKey &&
          isTopLevel &&
          (block.type === 'paragraph' || block.type === 'heading')
        ) {
          e.preventDefault();
          clearPendingEdit();
          pendingStyleRef.current = null;
          const liveRuns = domToRuns(el);
          const sel = getSelectionOffsetsInElement(el);
          const start = sel?.start ?? runsToPlainText(liveRuns).length;
          const end = sel?.end ?? start;
          const [before] = splitRunsAtOffset(liveRuns, start);
          const [, after] = splitRunsAtOffset(liveRuns, end);
          const curEntry = editableEntriesRef.current.get(getKeyForTarget(block.id));
          if (curEntry) {
            curEntry.el.innerHTML = runsToSafeHtml(before);
            curEntry.setSyncedRuns(before);
          }
          const newId = makeUid('p');
          pendingFocusRef.current = { key: getKeyForTarget(newId), offset: 0 };
          setActiveBlockId(newId);
          dispatchBatch([
            { op: 'updateBlockRuns', blockId: block.id, runs: before },
            {
              op: 'insertBlockAfter',
              afterBlockId: block.id,
              block: {
                id: newId,
                type: 'paragraph',
                runs: after,
                align: block.align,
                indentLevel: block.type === 'paragraph' ? block.indentLevel : 0,
              },
            },
          ]);
          return;
        }

        // Backspace at offset 0 -> delete/convert/merge cleanly
        if (e.key === 'Backspace') {
          const liveRuns = domToRuns(el);
          const sel = getSelectionOffsetsInElement(el);
          const atStart = !sel || (sel.start === 0 && sel.end === 0);
          if (!atStart) return;

          const isEmpty = runsToPlainText(liveRuns).length === 0;

          // List item Backspace at start (works even when list is the ONLY block)
          if (block.type === 'list' && listItemIndex !== undefined) {
            if (listItemIndex === 0) {
              if (block.items.length === 1) {
                e.preventDefault();
                clearPendingEdit();
                pendingFocusRef.current = { key: getKeyForTarget(block.id), offset: 0 };
                setActiveBlockId(block.id);
                const item = block.items[0];
                dispatchBatch(
                  [
                    {
                      op: 'updateListItem',
                      blockId: block.id,
                      itemIndex: 0,
                      runs: liveRuns,
                      checked: item?.checked ?? null,
                    },
                    {
                      op: 'convertBlockKind',
                      blockId: block.id,
                      target: { kind: 'paragraph' },
                    },
                  ],
                  { syncDom: true },
                );
                return;
              }
              if (isTopLevel) {
                e.preventDefault();
                clearPendingEdit();
                const idx = ir.blocks.findIndex((b) => b.id === block.id);
                if (idx > 0) {
                  const paraId = makeUid('p');
                  pendingFocusRef.current = { key: getKeyForTarget(paraId), offset: 0 };
                  setActiveBlockId(paraId);
                  dispatchBatch(
                    [
                      {
                        op: 'insertBlockAfter',
                        afterBlockId: ir.blocks[idx - 1].id,
                        block: {
                          id: paraId,
                          type: 'paragraph',
                          runs: liveRuns,
                          align: 'left',
                          indentLevel: 0,
                        },
                      },
                      { op: 'deleteListItem', blockId: block.id, itemIndex: 0 },
                    ],
                    { syncDom: true },
                  );
                  return;
                }
                if (idx === 0) {
                  const restListId = makeUid('list');
                  const ops: EditOperation[] = [
                    {
                      op: 'insertBlockAfter',
                      afterBlockId: block.id,
                      block: {
                        id: restListId,
                        type: 'list',
                        ordered: block.ordered,
                        start: block.start,
                        items: block.items.slice(1),
                      },
                    },
                    {
                      op: 'updateListItem',
                      blockId: block.id,
                      itemIndex: 0,
                      runs: liveRuns,
                      checked: block.items[0]?.checked ?? null,
                    },
                  ];
                  for (let i = block.items.length - 1; i >= 1; i -= 1) {
                    ops.push({ op: 'deleteListItem', blockId: block.id, itemIndex: i });
                  }
                  ops.push({
                    op: 'convertBlockKind',
                    blockId: block.id,
                    target: { kind: 'paragraph' },
                  });
                  pendingFocusRef.current = { key: getKeyForTarget(block.id), offset: 0 };
                  setActiveBlockId(block.id);
                  dispatchBatch(ops, { syncDom: true });
                  return;
                }
              }
            }
            if (listItemIndex > 0) {
              e.preventDefault();
              clearPendingEdit();
              const prevIdx = listItemIndex - 1;
              const prevItem = block.items[prevIdx];
              const prevEntry = editableEntriesRef.current.get(getKeyForTarget(block.id, prevIdx));
              const prevRuns = prevEntry ? domToRuns(prevEntry.el) : (prevItem?.runs ?? []);
              const prevLen = runsToPlainText(prevRuns).length;
              pendingFocusRef.current = {
                key: getKeyForTarget(block.id, prevIdx),
                offset: prevLen,
              };
              if (isEmpty) {
                dispatchEdit({ op: 'deleteListItem', blockId: block.id, itemIndex: listItemIndex });
              } else {
                const merged = mergeRuns([...prevRuns, ...liveRuns]);
                dispatchBatch(
                  [
                    {
                      op: 'updateListItem',
                      blockId: block.id,
                      itemIndex: prevIdx,
                      runs: merged,
                      checked: prevItem?.checked ?? null,
                    },
                    { op: 'deleteListItem', blockId: block.id, itemIndex: listItemIndex },
                  ],
                  { syncDom: true },
                );
              }
              return;
            }
          }

          // BlockQuote or Footnote inner paragraph/heading at offset 0
          if (!isTopLevel && (block.type === 'paragraph' || block.type === 'heading')) {
            const parent = findImmediateContainer(ir.blocks, block.id);
            const top = findTopLevelAncestor(ir.blocks, block.id);
            if (parent) {
              const innerIdx = parent.blocks.findIndex((b) => b.id === block.id);
              if (parent.blocks.length > 1 && innerIdx !== -1) {
                if (isEmpty) {
                  e.preventDefault();
                  clearPendingEdit();
                  const fallback = innerIdx > 0 ? parent.blocks[innerIdx - 1] : parent.blocks[1];
                  const target = fallback ? getBlockEndFocusTarget(fallback) : null;
                  if (target) {
                    pendingFocusRef.current = { key: target.key, offset: target.offset };
                  }
                  dispatchEdit({ op: 'deleteBlock', blockId: block.id });
                  return;
                }
                if (innerIdx > 0) {
                  const prevInner = parent.blocks[innerIdx - 1];
                  if (prevInner.type === 'paragraph' || prevInner.type === 'heading') {
                    e.preventDefault();
                    clearPendingEdit();
                    const prevEntry = editableEntriesRef.current.get(getKeyForTarget(prevInner.id));
                    const prevRuns = prevEntry ? domToRuns(prevEntry.el) : prevInner.runs;
                    const prevLen = runsToPlainText(prevRuns).length;
                    const merged = mergeRuns([...prevRuns, ...liveRuns]);
                    pendingFocusRef.current = { key: getKeyForTarget(prevInner.id), offset: prevLen };
                    dispatchBatch(
                      [
                        { op: 'updateBlockRuns', blockId: prevInner.id, runs: merged },
                        { op: 'deleteBlock', blockId: block.id },
                      ],
                      { syncDom: true },
                    );
                    return;
                  }
                }
              }
              if (
                isEmpty &&
                block.type === 'paragraph' &&
                innerIdx !== -1 &&
                parent.blocks.length <= 1
              ) {
                if (parent.type === 'blockQuote') {
                  e.preventDefault();
                  clearPendingEdit();
                  pendingFocusRef.current = { key: getKeyForTarget(parent.id), offset: 0 };
                  if (top && parent.id === top.id) {
                    setActiveBlockId(top.id);
                  }
                  dispatchEdit({
                    op: 'convertBlockKind',
                    blockId: parent.id,
                    target: { kind: 'paragraph' },
                  });
                  return;
                }
                if (parent.type === 'footnote' && top && parent.id === top.id) {
                  e.preventDefault();
                  clearPendingEdit();
                  const topIdx = ir.blocks.findIndex((b) => b.id === top.id);
                  if (ir.blocks.length > 1) {
                    const fallback = topIdx > 0 ? ir.blocks[topIdx - 1] : ir.blocks[1];
                    const target = fallback ? getBlockEndFocusTarget(fallback) : null;
                    if (target) {
                      pendingFocusRef.current = { key: target.key, offset: target.offset };
                    } else if (fallback) {
                      cachedTargetRef.current = {
                        blockId: fallback.id,
                        tableRow: fallback.type === 'table' ? 0 : undefined,
                        tableCol: fallback.type === 'table' ? 0 : undefined,
                        start: 0,
                        end: 0,
                      };
                    }
                    if (fallback) setActiveBlockId(fallback.id);
                    dispatchEdit({ op: 'deleteBlock', blockId: top.id });
                    if (!target && fallback) emitSelectionState();
                  } else {
                    const paraId = makeUid('p');
                    pendingFocusRef.current = { key: getKeyForTarget(paraId), offset: 0 };
                    setActiveBlockId(paraId);
                    dispatchBatch([
                      {
                        op: 'insertBlockAfter',
                        afterBlockId: top.id,
                        block: {
                          id: paraId,
                          type: 'paragraph',
                          runs: [],
                          align: 'left',
                          indentLevel: 0,
                        },
                      },
                      { op: 'deleteBlock', blockId: top.id },
                    ]);
                  }
                  return;
                }
              }
            }
          }

          // Top-level heading/paragraph at start
          if (isTopLevel) {
            const idx = ir.blocks.findIndex((b) => b.id === block.id);
            if (idx === 0 && isEmpty && block.type === 'heading') {
              e.preventDefault();
              clearPendingEdit();
              pendingFocusRef.current = { key: getKeyForTarget(block.id), offset: 0 };
              dispatchEdit({
                op: 'convertBlockKind',
                blockId: block.id,
                target: { kind: 'paragraph' },
              });
              return;
            }
            if (idx > 0 && ir.blocks.length > 1) {
              const prevBlock = ir.blocks[idx - 1];
              if (isEmpty) {
                e.preventDefault();
                clearPendingEdit();
                const prevTarget = getBlockEndFocusTarget(prevBlock);
                if (prevTarget) {
                  pendingFocusRef.current = { key: prevTarget.key, offset: prevTarget.offset };
                } else {
                  cachedTargetRef.current = {
                    blockId: prevBlock.id,
                    tableRow: prevBlock.type === 'table' ? 0 : undefined,
                    tableCol: prevBlock.type === 'table' ? 0 : undefined,
                    start: 0,
                    end: 0,
                  };
                }
                setActiveBlockId(prevBlock.id);
                dispatchEdit({ op: 'deleteBlock', blockId: block.id });
                if (!prevTarget) emitSelectionState();
                return;
              }
              // Non-empty paragraph/heading at offset 0 -> merge with previous paragraph/heading (reading live DOM runs)
              if (
                (block.type === 'paragraph' || block.type === 'heading') &&
                (prevBlock.type === 'paragraph' || prevBlock.type === 'heading')
              ) {
                e.preventDefault();
                clearPendingEdit();
                const prevEntry = editableEntriesRef.current.get(getKeyForTarget(prevBlock.id));
                const prevRuns = prevEntry ? domToRuns(prevEntry.el) : prevBlock.runs;
                const prevLen = runsToPlainText(prevRuns).length;
                const merged = mergeRuns([...prevRuns, ...liveRuns]);
                pendingFocusRef.current = { key: getKeyForTarget(prevBlock.id), offset: prevLen };
                setActiveBlockId(prevBlock.id);
                dispatchBatch(
                  [
                    { op: 'updateBlockRuns', blockId: prevBlock.id, runs: merged },
                    { op: 'deleteBlock', blockId: block.id },
                  ],
                  { syncDom: true },
                );
              }
            }
          }
        }
      },
      [
        applyRangeInlineMutation,
        clearPendingEdit,
        dispatchBatch,
        dispatchEdit,
        emitSelectionState,
        flushPendingEdits,
        getBlockEndFocusTarget,
        ir.blocks,
        onRequestLinkDialog,
        resolveTopLevelBlockId,
      ],
    );

    const handleEditableFocus = useCallback(
      (el: HTMLElement, blockId: string, listItemIndex?: number) => {
        const liveSel = getSelectionOffsetsInElement(el);
        const prev = cachedTargetRef.current;
        const sameTarget =
          prev && prev.blockId === blockId && prev.listItemIndex === listItemIndex;
        cachedTargetRef.current = {
          blockId,
          listItemIndex,
          start: liveSel?.start ?? (sameTarget ? prev.start : 0),
          end: liveSel?.end ?? (sameTarget ? prev.end : 0),
        };
        const top = findTopLevelAncestor(ir.blocks, blockId);
        setActiveBlockId(top?.id ?? blockId);
        emitSelectionState();
      },
      [emitSelectionState, ir.blocks],
    );

    const handleTailClick = useCallback(() => {
      if (!editable || !onApplyEdit) return;
      const last = ir.blocks[ir.blocks.length - 1];
      if (!last) {
        insertBlockAfterActive(
          {
            id: makeUid('p'),
            type: 'paragraph',
            runs: [],
            align: 'left',
            indentLevel: 0,
          },
          true,
        );
        return;
      }
      if (last.type === 'paragraph') {
        const end = getBlockEndFocusTarget(last);
        if (end) {
          focusBlock(last.id, end.offset);
          return;
        }
      }
      // Last block is non-text or non-paragraph -> append a fresh paragraph and focus it
      flushPendingEdits();
      const newId = makeUid('p');
      pendingFocusRef.current = { key: getKeyForTarget(newId), offset: 0 };
      setActiveBlockId(newId);
      dispatchEdit({
        op: 'insertBlockAfter',
        afterBlockId: last.id,
        block: {
          id: newId,
          type: 'paragraph',
          runs: [],
          align: 'left',
          indentLevel: 0,
        },
      });
    }, [
      dispatchEdit,
      editable,
      flushPendingEdits,
      focusBlock,
      getBlockEndFocusTarget,
      insertBlockAfterActive,
      ir.blocks,
      onApplyEdit,
    ]);

    const renderReadOnlyCellBlock = (cb: Block): React.ReactNode => {
      if (cb.type === 'paragraph') {
        return (
          <p key={cb.id} style={{ textAlign: cb.align }}>
            <InlineRunsView runs={cb.runs} />
          </p>
        );
      }
      if (cb.type === 'heading') {
        const Tag = `h${Math.min(Math.max(cb.level, 1), 6)}` as
          | 'h1'
          | 'h2'
          | 'h3'
          | 'h4'
          | 'h5'
          | 'h6';
        return (
          <Tag key={cb.id} style={{ textAlign: cb.align }}>
            <InlineRunsView runs={cb.runs} />
          </Tag>
        );
      }
      if (cb.type === 'list') {
        const ListTag = cb.ordered ? 'ol' : 'ul';
        const isChecklist = cb.items.some((it) => it.checked !== null && it.checked !== undefined);
        return (
          <ListTag
            key={cb.id}
            start={cb.ordered ? cb.start : undefined}
            className={isChecklist ? 'orb-checklist' : undefined}
          >
            {cb.items.map((it) => (
              <li key={it.id}>
                {it.checked !== null && it.checked !== undefined && (
                  <input
                    type="checkbox"
                    checked={it.checked}
                    readOnly
                    style={{ marginRight: '6px' }}
                  />
                )}
                <InlineRunsView runs={it.runs} />
                {it.children.map((child) => renderReadOnlyCellBlock(child))}
              </li>
            ))}
          </ListTag>
        );
      }
      if (cb.type === 'codeBlock') {
        return (
          <pre key={cb.id}>
            <code>{cb.code}</code>
          </pre>
        );
      }
      if (cb.type === 'blockQuote') {
        return (
          <blockquote key={cb.id}>
            {cb.blocks.map((inner) => renderReadOnlyCellBlock(inner))}
          </blockquote>
        );
      }
      if (cb.type === 'footnote') {
        return (
          <div key={cb.id} className="orb-footnote-block">
            <span className="orb-footnote-label">[{cb.label}]</span>
            <div className="orb-footnote-body">
              {cb.blocks.map((inner) => renderReadOnlyCellBlock(inner))}
            </div>
          </div>
        );
      }
      if (cb.type === 'table') {
        return (
          <table key={cb.id}>
            <tbody>
              {cb.rows.map((row, rIdx) => (
                <tr key={rIdx}>
                  {row.cells.map((cell) => {
                    const CellTag = row.header ? 'th' : 'td';
                    return (
                      <CellTag
                        key={cell.id}
                        colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                        rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                        style={{ textAlign: cell.align }}
                      >
                        {cell.blocks.map((inner) => renderReadOnlyCellBlock(inner))}
                      </CellTag>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        );
      }
      if (cb.type === 'image') {
        const asset = assetMap.get(cb.assetId);
        if (!asset) return null;
        return (
          <figure key={cb.id} className="orb-image-figure">
            <img
              src={`data:${asset.mimeType};base64,${asset.dataBase64}`}
              alt={cb.alt ?? asset.filename ?? 'Embedded image'}
              width={cb.widthPx ?? undefined}
              height={cb.heightPx ?? undefined}
            />
            {cb.caption && <figcaption>{cb.caption}</figcaption>}
          </figure>
        );
      }
      if (cb.type === 'horizontalRule') {
        return <hr key={cb.id} />;
      }
      if (cb.type === 'pageBreak') {
        return (
          <div key={cb.id} className="orb-page-break">
            Page Break
          </div>
        );
      }
      return null;
    };

    const renderBlock = (block: Block, isTopLevel: boolean, index: number): React.ReactNode => {
      const isSelected = editable && isTopLevel && activeBlockId === block.id;
      const isMatch = isTopLevel && findResults.matchedTopIds.has(block.id);
      const isActiveMatch = isTopLevel && activeMatchTopBlockId === block.id;
      const matchCls = isActiveMatch
        ? 'is-find-match is-find-active'
        : isMatch
          ? 'is-find-match'
          : '';
      const wrapperCls = editable
        ? `orb-edit-block ${isSelected ? 'is-active' : ''} ${matchCls}`.trim()
        : matchCls || undefined;

      const deleteBtn =
        editable && isTopLevel && ir.blocks.length > 1 && onApplyEdit ? (
          <div className="orb-edit-actions">
            <button
              type="button"
              className="orb-btn icon-only ghost"
              title="Delete block"
              aria-label="Delete block"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                flushPendingEdits();
                if (
                  cachedTargetRef.current &&
                  (cachedTargetRef.current.blockId === block.id ||
                    findTopLevelAncestor(ir.blocks, cachedTargetRef.current.blockId)?.id ===
                      block.id)
                ) {
                  cachedTargetRef.current = null;
                }
                dispatchEdit({ op: 'deleteBlock', blockId: block.id });
              }}
            >
              <TrashIcon size={13} />
            </button>
          </div>
        ) : null;

      switch (block.type) {
        case 'heading': {
          const Tag = `h${Math.min(Math.max(block.level, 1), 6)}` as
            | 'h1'
            | 'h2'
            | 'h3'
            | 'h4'
            | 'h5'
            | 'h6';
          const key = getKeyForTarget(block.id);
          return (
            <div key={block.id} id={block.id} className={wrapperCls}>
              {deleteBtn}
              {editable ? (
                <EditableRuns
                  tag={Tag}
                  runs={block.runs}
                  externalSyncRev={externalSyncRev}
                  className="orb-editable-runs"
                  style={{ textAlign: block.align }}
                  placeholder="Heading…"
                  registerEntry={registerEditableEntry(key)}
                  getPendingStyle={() =>
                    pendingStyleRef.current && pendingStyleRef.current.key === key
                      ? {
                          offset: pendingStyleRef.current.offset,
                          style: pendingStyleRef.current.style,
                        }
                      : null
                  }
                  onAdvancePendingStyle={(nextOffset) => {
                    if (pendingStyleRef.current && pendingStyleRef.current.key === key) {
                      pendingStyleRef.current = { ...pendingStyleRef.current, offset: nextOffset };
                    }
                  }}
                  onFocusEl={(el) => handleEditableFocus(el, block.id)}
                  onLiveInput={(nextRuns) => {
                    scheduleCommit({
                      op: 'updateBlockRuns',
                      blockId: block.id,
                      runs: nextRuns,
                    });
                    emitSelectionState();
                  }}
                  onCommit={(nextRuns) => {
                    clearPendingEdit();
                    if (!runsEqual(nextRuns, block.runs)) {
                      dispatchEdit({
                        op: 'updateBlockRuns',
                        blockId: block.id,
                        runs: nextRuns,
                      });
                    }
                  }}
                  onKeyDownEl={(e, el) => handleRichKeyDown(e, el, block, isTopLevel)}
                />
              ) : (
                <Tag style={{ textAlign: block.align }}>
                  <InlineRunsView runs={block.runs} />
                </Tag>
              )}
            </div>
          );
        }

        case 'paragraph': {
          const key = getKeyForTarget(block.id);
          const paraStyle: React.CSSProperties = {
            textAlign: block.align,
            paddingLeft: block.indentLevel ? `${block.indentLevel * 1.5}em` : undefined,
          };
          return (
            <div key={block.id} id={block.id} className={wrapperCls}>
              {deleteBtn}
              {editable ? (
                <EditableRuns
                  tag="p"
                  runs={block.runs}
                  externalSyncRev={externalSyncRev}
                  className="orb-editable-runs"
                  style={paraStyle}
                  placeholder={isTopLevel && index === 0 ? 'Start typing your document…' : undefined}
                  registerEntry={registerEditableEntry(key)}
                  getPendingStyle={() =>
                    pendingStyleRef.current && pendingStyleRef.current.key === key
                      ? {
                          offset: pendingStyleRef.current.offset,
                          style: pendingStyleRef.current.style,
                        }
                      : null
                  }
                  onAdvancePendingStyle={(nextOffset) => {
                    if (pendingStyleRef.current && pendingStyleRef.current.key === key) {
                      pendingStyleRef.current = { ...pendingStyleRef.current, offset: nextOffset };
                    }
                  }}
                  onFocusEl={(el) => handleEditableFocus(el, block.id)}
                  onLiveInput={(nextRuns) => {
                    scheduleCommit({
                      op: 'updateBlockRuns',
                      blockId: block.id,
                      runs: nextRuns,
                    });
                    emitSelectionState();
                  }}
                  onCommit={(nextRuns) => {
                    clearPendingEdit();
                    if (!runsEqual(nextRuns, block.runs)) {
                      dispatchEdit({
                        op: 'updateBlockRuns',
                        blockId: block.id,
                        runs: nextRuns,
                      });
                    }
                  }}
                  onKeyDownEl={(e, el) => handleRichKeyDown(e, el, block, isTopLevel)}
                />
              ) : (
                <p style={paraStyle}>
                  <InlineRunsView runs={block.runs} />
                </p>
              )}
            </div>
          );
        }

        case 'list': {
          const ListTag = block.ordered ? 'ol' : 'ul';
          const isChecklist = block.items.some(
            (i) => i.checked !== null && i.checked !== undefined,
          );
          return (
            <div key={block.id} id={block.id} className={wrapperCls}>
              {deleteBtn}
              <ListTag
                start={block.ordered ? block.start : undefined}
                className={isChecklist ? 'orb-checklist' : undefined}
              >
                {block.items.map((item, idx) => {
                  const key = getKeyForTarget(block.id, idx);
                  return (
                    <li key={item.id}>
                      {item.checked !== null && item.checked !== undefined && (
                        <input
                          type="checkbox"
                          checked={item.checked}
                          readOnly={!editable}
                          style={{ marginRight: '8px' }}
                          onChange={(e) => {
                            if (editable && onApplyEdit) {
                              const liveEntry = editableEntriesRef.current.get(key);
                              const currentRuns = liveEntry ? domToRuns(liveEntry.el) : item.runs;
                              const pendingOp = pendingCommitRef.current.op;
                              if (
                                pendingOp &&
                                pendingOp.op === 'updateListItem' &&
                                pendingOp.blockId === block.id &&
                                pendingOp.itemIndex === idx
                              ) {
                                clearPendingEdit();
                              } else {
                                flushPendingEdits();
                              }
                              dispatchEdit({
                                op: 'updateListItem',
                                blockId: block.id,
                                itemIndex: idx,
                                runs: currentRuns,
                                checked: e.target.checked,
                              });
                            }
                          }}
                        />
                      )}
                      {editable ? (
                        <EditableRuns
                          tag="span"
                          runs={item.runs}
                          externalSyncRev={externalSyncRev}
                          className="orb-editable-runs orb-editable-inline"
                          placeholder="List item…"
                          registerEntry={registerEditableEntry(key)}
                          getPendingStyle={() =>
                            pendingStyleRef.current && pendingStyleRef.current.key === key
                              ? {
                                  offset: pendingStyleRef.current.offset,
                                  style: pendingStyleRef.current.style,
                                }
                              : null
                          }
                          onAdvancePendingStyle={(nextOffset) => {
                            if (pendingStyleRef.current && pendingStyleRef.current.key === key) {
                              pendingStyleRef.current = {
                                ...pendingStyleRef.current,
                                offset: nextOffset,
                              };
                            }
                          }}
                          onFocusEl={(el) => handleEditableFocus(el, block.id, idx)}
                          onLiveInput={(nextRuns) => {
                            scheduleCommit({
                              op: 'updateListItem',
                              blockId: block.id,
                              itemIndex: idx,
                              runs: nextRuns,
                              checked: item.checked ?? null,
                            });
                            emitSelectionState();
                          }}
                          onCommit={(nextRuns) => {
                            clearPendingEdit();
                            if (!runsEqual(nextRuns, item.runs)) {
                              dispatchEdit({
                                op: 'updateListItem',
                                blockId: block.id,
                                itemIndex: idx,
                                runs: nextRuns,
                                checked: item.checked ?? null,
                              });
                            }
                          }}
                          onKeyDownEl={(e, el) =>
                            handleRichKeyDown(e, el, block, isTopLevel, idx)
                          }
                        />
                      ) : (
                        <span>
                          <InlineRunsView runs={item.runs} />
                        </span>
                      )}
                      {item.children.map((child, cIdx) => renderBlock(child, false, cIdx))}
                    </li>
                  );
                })}
              </ListTag>
            </div>
          );
        }

        case 'table': {
          const colCount = block.rows[0]?.cells.length ?? 0;
          return (
            <div
              key={block.id}
              id={block.id}
              className={wrapperCls}
              onClick={() => {
                if (editable) {
                  setActiveBlockId(block.id);
                  if (cachedTargetRef.current?.blockId !== block.id) {
                    cachedTargetRef.current = {
                      blockId: block.id,
                      tableRow: 0,
                      tableCol: 0,
                      start: 0,
                      end: 0,
                    };
                  }
                  emitSelectionState();
                }
              }}
            >
              {deleteBtn}
              <table>
                <tbody>
                  {block.rows.map((row, rIdx) => (
                    <tr key={rIdx}>
                      {row.cells.map((cell, cIdx) => {
                        const CellTag = row.header ? 'th' : 'td';
                        const cellPlain = extractCellPlainText(cell.blocks);

                        return (
                          <CellTag
                            key={cell.id}
                            colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                            rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                            style={{ textAlign: cell.align }}
                            onClick={(e) => {
                              if (!editable) return;
                              e.stopPropagation();
                              if (editingCellRef.current?.cellId !== cell.id) {
                                flushPendingEdits();
                              }
                              setActiveBlockId(block.id);
                              cachedTargetRef.current = {
                                blockId: block.id,
                                tableRow: rIdx,
                                tableCol: cIdx,
                                start: 0,
                                end: 0,
                              };
                              editingCellRef.current = {
                                cellId: cell.id,
                                blockId: block.id,
                                row: rIdx,
                                col: cIdx,
                                originalPlain: cellPlain,
                                draft: cellPlain,
                              };
                              setEditingCellId(cell.id);
                              setCellDraft(cellPlain);
                              emitSelectionState();
                            }}
                          >
                            {editable && editingCellId === cell.id ? (
                              <textarea
                                className="orb-inline-textarea orb-cell-textarea"
                                value={cellDraft}
                                autoFocus
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setCellDraft(val);
                                  if (editingCellRef.current?.cellId === cell.id) {
                                    editingCellRef.current.draft = val;
                                  }
                                }}
                                onBlur={() => {
                                  if (editingCellRef.current?.cellId === cell.id) {
                                    const active = editingCellRef.current;
                                    editingCellRef.current = null;
                                    setEditingCellId(null);
                                    if (active.draft !== active.originalPlain) {
                                      dispatchEdit({
                                        op: 'updateTableCell',
                                        blockId: active.blockId,
                                        row: active.row,
                                        col: active.col,
                                        text: active.draft,
                                      });
                                    }
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    e.nativeEvent.stopPropagation();
                                    editingCellRef.current = null;
                                    setEditingCellId(null);
                                  }
                                  if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    if (editingCellRef.current?.cellId === cell.id) {
                                      const active = editingCellRef.current;
                                      editingCellRef.current = null;
                                      setEditingCellId(null);
                                      if (active.draft !== active.originalPlain) {
                                        dispatchEdit({
                                          op: 'updateTableCell',
                                          blockId: active.blockId,
                                          row: active.row,
                                          col: active.col,
                                          text: active.draft,
                                        });
                                      }
                                    }
                                  }
                                }}
                              />
                            ) : cell.blocks.length > 0 &&
                              (cellPlain.length > 0 ||
                                cell.blocks.some(
                                  (b) => b.type !== 'paragraph' && b.type !== 'heading',
                                )) ? (
                              cell.blocks.map((cb) => renderReadOnlyCellBlock(cb))
                            ) : (
                              <span className="orb-cell-empty">&nbsp;</span>
                            )}
                          </CellTag>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              {editable && isSelected && (
                <div className="orb-table-mini-controls">
                  <button
                    type="button"
                    className="orb-btn ghost"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      flushPendingEdits();
                      dispatchEdit({
                        op: 'addTableRow',
                        blockId: block.id,
                        afterRow: Math.min(
                          cachedTargetRef.current?.tableRow ?? block.rows.length - 1,
                          Math.max(0, block.rows.length - 1),
                        ),
                      });
                    }}
                  >
                    + Row
                  </button>
                  <button
                    type="button"
                    className="orb-btn ghost"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      flushPendingEdits();
                      dispatchEdit({
                        op: 'addTableColumn',
                        blockId: block.id,
                        afterCol:
                          cachedTargetRef.current?.tableCol !== undefined
                            ? Math.min(cachedTargetRef.current.tableCol, Math.max(0, colCount - 1))
                            : null,
                      });
                    }}
                  >
                    + Column
                  </button>
                  {block.rows.length > 1 && (
                    <button
                      type="button"
                      className="orb-btn ghost"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        flushPendingEdits();
                        const row = Math.min(
                          cachedTargetRef.current?.tableRow ?? block.rows.length - 1,
                          block.rows.length - 1,
                        );
                        if (cachedTargetRef.current?.blockId === block.id) {
                          cachedTargetRef.current = {
                            ...cachedTargetRef.current,
                            tableRow: Math.max(0, Math.min(row, block.rows.length - 2)),
                          };
                        }
                        dispatchEdit({
                          op: 'deleteTableRow',
                          blockId: block.id,
                          row,
                        });
                      }}
                    >
                      - Row
                    </button>
                  )}
                  {colCount > 1 && (
                    <button
                      type="button"
                      className="orb-btn ghost"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        flushPendingEdits();
                        const col = Math.min(cachedTargetRef.current?.tableCol ?? 0, colCount - 1);
                        if (cachedTargetRef.current?.blockId === block.id) {
                          cachedTargetRef.current = {
                            ...cachedTargetRef.current,
                            tableCol: Math.max(0, Math.min(col, colCount - 2)),
                          };
                        }
                        dispatchEdit({
                          op: 'deleteTableColumn',
                          blockId: block.id,
                          col,
                        });
                      }}
                    >
                      - Column
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        }

        case 'blockQuote':
          return (
            <div key={block.id} id={block.id} className={wrapperCls}>
              {deleteBtn}
              <blockquote>
                {block.blocks.map((b, bIdx) => renderBlock(b, false, bIdx))}
              </blockquote>
            </div>
          );

        case 'codeBlock': {
          if (editable && editingCodeId === block.id) {
            return (
              <div key={block.id} id={block.id} className={wrapperCls}>
                <textarea
                  className="orb-inline-textarea"
                  style={{ fontFamily: 'var(--orb-font-mono)', minHeight: '110px' }}
                  value={codeDraft}
                  autoFocus
                  onChange={(e) => {
                    const val = e.target.value;
                    setCodeDraft(val);
                    if (editingCodeRef.current?.blockId === block.id) {
                      editingCodeRef.current.draft = val;
                    }
                  }}
                  onBlur={() => {
                    if (editingCodeRef.current?.blockId === block.id) {
                      const active = editingCodeRef.current;
                      editingCodeRef.current = null;
                      setEditingCodeId(null);
                      if (active.draft !== active.originalCode) {
                        dispatchEdit({
                          op: 'updateCodeBlock',
                          blockId: active.blockId,
                          language: active.language,
                          code: active.draft,
                        });
                      }
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      e.nativeEvent.stopPropagation();
                      editingCodeRef.current = null;
                      setEditingCodeId(null);
                    }
                  }}
                />
              </div>
            );
          }
          return (
            <div
              key={block.id}
              id={block.id}
              className={wrapperCls}
              onClick={() => {
                if (!editable) return;
                if (editingCodeRef.current?.blockId !== block.id) {
                  flushPendingEdits();
                }
                setActiveBlockId(block.id);
                cachedTargetRef.current = { blockId: block.id, start: 0, end: 0 };
                editingCodeRef.current = {
                  blockId: block.id,
                  language: block.language ?? null,
                  originalCode: block.code,
                  draft: block.code,
                };
                setEditingCodeId(block.id);
                setCodeDraft(block.code);
                emitSelectionState();
              }}
            >
              {deleteBtn}
              <pre>
                <code>{block.code || (editable ? '// Click to edit code…' : '')}</code>
              </pre>
            </div>
          );
        }

        case 'image': {
          const asset = assetMap.get(block.assetId);
          if (!asset) return null;
          return (
            <div
              key={block.id}
              id={block.id}
              className={wrapperCls}
              onClick={() => {
                if (editable) {
                  setActiveBlockId(block.id);
                  cachedTargetRef.current = { blockId: block.id, start: 0, end: 0 };
                  emitSelectionState();
                }
              }}
            >
              {deleteBtn}
              <figure className="orb-image-figure">
                <img
                  src={`data:${asset.mimeType};base64,${asset.dataBase64}`}
                  alt={block.alt}
                  width={block.widthPx ?? undefined}
                  height={block.heightPx ?? undefined}
                />
                {block.caption && <figcaption>{block.caption}</figcaption>}
              </figure>
            </div>
          );
        }

        case 'horizontalRule':
          return (
            <div
              key={block.id}
              id={block.id}
              className={wrapperCls}
              onClick={() => {
                if (editable) {
                  setActiveBlockId(block.id);
                  cachedTargetRef.current = { blockId: block.id, start: 0, end: 0 };
                  emitSelectionState();
                }
              }}
            >
              {deleteBtn}
              <hr />
            </div>
          );

        case 'pageBreak':
          return (
            <div
              key={block.id}
              id={block.id}
              className={`orb-page-break ${wrapperCls ?? ''}`}
              onClick={() => {
                if (editable) {
                  setActiveBlockId(block.id);
                  cachedTargetRef.current = { blockId: block.id, start: 0, end: 0 };
                  emitSelectionState();
                }
              }}
            >
              {deleteBtn}
              Page Break
            </div>
          );

        case 'footnote':
          return (
            <aside key={block.id} id={block.id} className={`orb-diag-card info ${wrapperCls ?? ''}`}>
              {deleteBtn}
              <span className="orb-diag-code">Footnote [{block.label}]</span>
              {block.blocks.map((b, bIdx) => renderBlock(b, false, bIdx))}
            </aside>
          );
      }
    };

    return (
      <div className="orb-doc-scroll">
        <article
          ref={sheetRef}
          className={`orb-sheet ${editable ? 'is-editable' : ''}`}
          style={{
            fontSize: `${Math.round(15.5 * zoom * 10) / 10}px`,
          }}
        >
          <div ref={contentRef} className="orb-sheet-content">
            {ir.blocks.length === 0 ? (
              editable && onApplyEdit ? (
                <div className="orb-add-block-bar">
                  <button
                    id="orb-add-paragraph-btn"
                    type="button"
                    className="orb-btn"
                    onClick={() =>
                      insertBlockAfterActive(
                        {
                          id: makeUid('p'),
                          type: 'paragraph',
                          runs: [],
                          align: 'left',
                          indentLevel: 0,
                        },
                        true,
                      )
                    }
                  >
                    <PlusIcon />
                    Add Paragraph
                  </button>
                </div>
              ) : (
                <p className="orb-empty-note">Empty document.</p>
              )
            ) : (
              ir.blocks.map((block, idx) => renderBlock(block, true, idx))
            )}
          </div>
          {editable && <div className="orb-sheet-tail" onClick={handleTailClick} />}
        </article>
      </div>
    );
  },
);

DocumentIrView.displayName = 'DocumentIrView';
