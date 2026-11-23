import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../theme/ThemeProvider';
import type { ThemeMode } from '../theme/themes';
import type { BlockConvertTarget, DocumentIr, TextAlign } from '../types';
import {
  FONT_SIZE_MAX_PT,
  FONT_SIZE_MIN_PT,
  isSafeHref,
  type InlineStyleFlag,
} from '../utils/editorRuns';
import type { EditorSelectionState } from './DocumentIrView';
import {
  AlignCenterIcon,
  AlignJustifyIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClearFormatIcon,
  CodeIcon,
  DownloadIcon,
  ImageIcon,
  IndentDecreaseIcon,
  IndentIncreaseIcon,
  ItalicIcon,
  LinkIcon,
  ListBulletIcon,
  ListCheckIcon,
  ListNumberedIcon,
  MonitorIcon,
  MoonIcon,
  MoreHorizontalIcon,
  OrbLogoIcon,
  RedoIcon,
  SidebarLeftIcon,
  SidebarRightIcon,
  StrikethroughIcon,
  SunIcon,
  TableIcon,
  UnderlineIcon,
  UndoIcon,
  XIcon,
} from './Icons';

export type TopMenuId = 'file' | 'edit' | 'insert' | 'format' | 'view';
const TOP_MENUS: { id: TopMenuId; label: string }[] = [
  { id: 'file', label: 'File' },
  { id: 'edit', label: 'Edit' },
  { id: 'insert', label: 'Insert' },
  { id: 'format', label: 'Format' },
  { id: 'view', label: 'View' },
];

const FONT_SIZE_PRESETS = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
const MENU_ITEM_SELECTOR =
  '[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled), [role="menuitemradio"]:not(:disabled)';

const isMac =
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform ?? '');
const MOD = isMac ? '⌘' : 'Ctrl+';

function fmtShortcut(key: string): string {
  return `${MOD}${key}`;
}

function defaultFontSizeForSelection(sel: EditorSelectionState): number {
  if (sel.blockType === 'heading') {
    switch (sel.headingLevel) {
      case 1:
        return 24;
      case 2:
        return 18;
      case 3:
        return 15;
      case 4:
        return 13;
      case 5:
        return 12;
      case 6:
        return 11;
    }
  }
  return 12;
}

export interface EditorTopBarProps {
  filename: string;
  ir: DocumentIr;
  dirty: boolean;
  editMode: boolean;
  onEditModeChange: (editing: boolean) => void;
  showFormattingBar: boolean;
  onToggleFormattingBar: () => void;
  showOutline: boolean;
  onToggleOutline: () => void;
  showInspector: boolean;
  onToggleInspector: () => void;
  zoom: number;
  onZoomChange: (next: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  selection: EditorSelectionState;
  exportBusy: boolean;
  replaceBusy?: boolean;
  findOpen: boolean;
  findFocusNonce?: number;
  findFocusTarget?: 'find' | 'replace';
  findQuery: string;
  findCaseSensitive: boolean;
  findMatchCount: number;
  findActiveIndex: number;
  onFindOpenChange: (open: boolean) => void;
  onFindQueryChange: (q: string) => void;
  onFindCaseSensitiveChange: (caseSensitive: boolean) => void;
  onFindStep: (delta: 1 | -1) => void;
  onReplaceCurrent: (find: string, replace: string, caseSensitive: boolean) => void;
  onReplaceAll: (find: string, replace: string, caseSensitive: boolean) => void;
  linkOpen: boolean;
  onLinkOpenChange: (open: boolean) => void;
  onGoHome: () => void;
  onNewDocument: () => void;
  onOpenFile: () => void;
  onRenameDocument: (nextName: string) => void;
  onExportDocx: () => void;
  onExportMarkdown: () => void;
  onPrint: () => void;
  onClipboard: (cmd: 'cut' | 'copy' | 'paste' | 'pastePlain') => void;
  onSelectAll: () => void;
  onToggleInlineStyle: (flag: InlineStyleFlag) => void;
  onSetFontSize: (sizePt: number | null) => void;
  onApplyLink: (href: string | null, label?: string) => void;
  onClearFormatting: () => void;
  onSetAlignment: (align: TextAlign) => void;
  onChangeIndent: (delta: 1 | -1) => void;
  onConvertBlock: (target: BlockConvertTarget) => void;
  onInsertImageClick: () => void;
  onInsertTable: (rows: number, cols: number) => void;
  onInsertSpecialBlock: (
    kind: 'codeBlock' | 'blockQuote' | 'horizontalRule' | 'pageBreak' | 'footnote',
  ) => void;
  onTableAction: (action: 'addRow' | 'deleteRow' | 'addCol' | 'deleteCol') => void;
  onRestoreFocus: () => void;
}

interface MenuActionItem {
  type: 'item';
  id: string;
  label: string;
  shortcut?: string;
  checked?: boolean;
  radio?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface MenuSectionItem {
  type: 'section';
  label: string;
}

interface MenuSeparatorItem {
  type: 'separator';
}

type MenuEntry = MenuActionItem | MenuSectionItem | MenuSeparatorItem;

function currentBlockStyleValue(sel: EditorSelectionState): string {
  if (sel.blockType === 'heading' && sel.headingLevel) {
    return `h${Math.min(Math.max(sel.headingLevel, 1), 6)}`;
  }
  if (sel.blockType === 'blockQuote') return 'quote';
  if (sel.blockType === 'codeBlock') return 'code';
  return 'normal';
}

function alignIcon(align: TextAlign): React.ReactNode {
  switch (align) {
    case 'center':
      return <AlignCenterIcon />;
    case 'right':
      return <AlignRightIcon />;
    case 'justify':
      return <AlignJustifyIcon />;
    default:
      return <AlignLeftIcon />;
  }
}

export const EditorTopBar: React.FC<EditorTopBarProps> = ({
  filename,
  ir,
  dirty,
  editMode,
  onEditModeChange,
  showFormattingBar,
  onToggleFormattingBar,
  showOutline,
  onToggleOutline,
  showInspector,
  onToggleInspector,
  zoom,
  onZoomChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  selection,
  exportBusy,
  replaceBusy = false,
  findOpen,
  findFocusNonce = 0,
  findFocusTarget = 'find',
  findQuery,
  findCaseSensitive,
  findMatchCount,
  findActiveIndex,
  onFindOpenChange,
  onFindQueryChange,
  onFindCaseSensitiveChange,
  onFindStep,
  onReplaceCurrent,
  onReplaceAll,
  linkOpen,
  onLinkOpenChange,
  onGoHome,
  onNewDocument,
  onOpenFile,
  onRenameDocument,
  onExportDocx,
  onExportMarkdown,
  onPrint,
  onClipboard,
  onSelectAll,
  onToggleInlineStyle,
  onSetFontSize,
  onApplyLink,
  onClearFormatting,
  onSetAlignment,
  onChangeIndent,
  onConvertBlock,
  onInsertImageClick,
  onInsertTable,
  onInsertSpecialBlock,
  onTableAction,
  onRestoreFocus,
}) => {
  const { mode, setMode } = useTheme();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const formatBarRef = useRef<HTMLDivElement | null>(null);
  const menuBtnRefs = useRef<Record<TopMenuId, HTMLButtonElement | null>>({
    file: null,
    edit: null,
    insert: null,
    format: null,
    view: null,
  });
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const titleBtnRef = useRef<HTMLButtonElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const alignPopoverRef = useRef<HTMLDivElement | null>(null);
  const overflowPopoverRef = useRef<HTMLDivElement | null>(null);
  const detailsCloseBtnRef = useRef<HTMLButtonElement | null>(null);
  const tableGridRef = useRef<HTMLDivElement | null>(null);
  const prevLinkOpenRef = useRef(false);

  const [openMenu, setOpenMenu] = useState<TopMenuId | null>(null);
  const [rovingMenuIdx, setRovingMenuIdx] = useState(0);
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(filename);
  const [activePopover, setActivePopover] = useState<
    'align' | 'table' | 'details' | 'overflow' | null
  >(null);
  const [tableHover, setTableHover] = useState<{ rows: number; cols: number }>({
    rows: 3,
    cols: 3,
  });
  const [replaceDraft, setReplaceDraft] = useState('');
  const [linkUrlDraft, setLinkUrlDraft] = useState('');
  const [linkTextDraft, setLinkTextDraft] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [overflowLevel, setOverflowLevel] = useState<0 | 1 | 2 | 3 | 4 | 5>(0);

  useEffect(() => {
    setTitleDraft(filename);
  }, [filename]);

  useEffect(() => {
    if (renamingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [renamingTitle]);

  // Focus and select Find/Replace input when opened or re-invoked via Ctrl+F / Ctrl+H
  useEffect(() => {
    if (!findOpen) return;
    const raf = window.requestAnimationFrame(() => {
      const target =
        findFocusTarget === 'replace' && editMode && replaceInputRef.current
          ? replaceInputRef.current
          : findInputRef.current;
      target?.focus();
      target?.select();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [editMode, findFocusNonce, findFocusTarget, findOpen]);

  // Focus first/active option when alignment or table picker popover opens
  useEffect(() => {
    if (activePopover === 'align') {
      const raf = window.requestAnimationFrame(() => {
        const activeBtn =
          alignPopoverRef.current?.querySelector<HTMLButtonElement>('.orb-fmt-btn.active') ??
          alignPopoverRef.current?.querySelector<HTMLButtonElement>('button');
        activeBtn?.focus();
      });
      return () => window.cancelAnimationFrame(raf);
    }
    if (activePopover === 'table') {
      const raf = window.requestAnimationFrame(() => {
        const targetIdx = (tableHover.rows - 1) * 6 + (tableHover.cols - 1);
        const cells = tableGridRef.current?.querySelectorAll<HTMLButtonElement>('button');
        const cell = cells?.[targetIdx] ?? cells?.[0];
        cell?.focus();
      });
      return () => window.cancelAnimationFrame(raf);
    }
    if (activePopover === 'overflow') {
      const raf = window.requestAnimationFrame(() => {
        const firstFocusable = overflowPopoverRef.current?.querySelector<HTMLElement>(
          'button:not([disabled]), select:not([disabled])',
        );
        firstFocusable?.focus();
      });
      return () => window.cancelAnimationFrame(raf);
    }
    if (activePopover === 'details') {
      const raf = window.requestAnimationFrame(() => {
        detailsCloseBtnRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(raf);
    }
  }, [activePopover]);

  // Only initialize link drafts on false -> true transition of linkOpen
  useEffect(() => {
    const wasOpen = prevLinkOpenRef.current;
    prevLinkOpenRef.current = linkOpen;
    if (linkOpen && !wasOpen) {
      setLinkUrlDraft(selection.textStyle.href ?? 'https://');
      setLinkTextDraft(selection.selectedText || selection.activeLinkText);
      setLinkError(null);
      setOpenMenu(null);
      setActivePopover(null);
    }
  }, [linkOpen, selection.activeLinkText, selection.selectedText, selection.textStyle.href]);

  // Responsive single-row folding for the minimalist formatting bar
  useEffect(() => {
    const el = formatBarRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = (width: number) => {
      if (width < 380) setOverflowLevel(5);
      else if (width < 520) setOverflowLevel(4);
      else if (width < 640) setOverflowLevel(3);
      else if (width < 760) setOverflowLevel(2);
      else if (width < 920) setOverflowLevel(1);
      else setOverflowLevel(0);
    };
    update(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        update(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [editMode, showFormattingBar]);

  // Dismiss menus/popovers/bars on outside pointer down or prioritized single-layer Escape
  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpenMenu(null);
        setActivePopover(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (renamingTitle) {
        e.preventDefault();
        setTitleDraft(filename);
        setRenamingTitle(false);
        window.requestAnimationFrame(() => {
          if (titleBtnRef.current && titleBtnRef.current.offsetParent !== null) {
            titleBtnRef.current.focus();
          } else {
            onRestoreFocus();
          }
        });
        return;
      }
      if (openMenu) {
        e.preventDefault();
        const closedMenu = openMenu;
        setOpenMenu(null);
        menuBtnRefs.current[closedMenu]?.focus();
        return;
      }
      if (activePopover) {
        e.preventDefault();
        setActivePopover(null);
        onRestoreFocus();
        return;
      }
      if (linkOpen) {
        e.preventDefault();
        onLinkOpenChange(false);
        onRestoreFocus();
        return;
      }
      if (findOpen) {
        e.preventDefault();
        onFindOpenChange(false);
        onFindQueryChange('');
        onRestoreFocus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [
    activePopover,
    filename,
    findOpen,
    linkOpen,
    onFindOpenChange,
    onFindQueryChange,
    onLinkOpenChange,
    onRestoreFocus,
    openMenu,
    renamingTitle,
  ]);

  const closeAllMenus = useCallback(() => {
    setOpenMenu(null);
    setActivePopover(null);
  }, []);

  const runMenuAction = useCallback(
    (fn: () => void, restore = true) => {
      closeAllMenus();
      fn();
      if (restore) {
        window.requestAnimationFrame(() => onRestoreFocus());
      }
    },
    [closeAllMenus, onRestoreFocus],
  );

  const commitTitle = () => {
    const trimmed = titleDraft.trim();
    setRenamingTitle(false);
    if (trimmed && trimmed !== filename) {
      onRenameDocument(trimmed);
    } else {
      setTitleDraft(filename);
    }
  };

  const buildMenuEntries = (id: TopMenuId): MenuEntry[] => {
    switch (id) {
      case 'file':
        return [
          {
            type: 'item',
            id: 'file-new',
            label: 'New Document',
            shortcut: fmtShortcut('N'),
            onSelect: () => runMenuAction(onNewDocument, false),
          },
          {
            type: 'item',
            id: 'file-open',
            label: 'Open…',
            shortcut: fmtShortcut('O'),
            onSelect: () => runMenuAction(onOpenFile, false),
          },
          {
            type: 'item',
            id: 'file-rename',
            label: 'Rename',
            onSelect: () => {
              closeAllMenus();
              setRenamingTitle(true);
            },
          },
          { type: 'separator' },
          {
            type: 'item',
            id: 'file-export-docx',
            label: 'Download as Word (.docx)',
            shortcut: fmtShortcut('S'),
            disabled: exportBusy,
            onSelect: () => runMenuAction(onExportDocx, false),
          },
          {
            type: 'item',
            id: 'file-export-md',
            label: 'Download as Markdown (.md)',
            disabled: exportBusy,
            onSelect: () => runMenuAction(onExportMarkdown, false),
          },
          {
            type: 'item',
            id: 'file-print',
            label: 'Print',
            shortcut: fmtShortcut('P'),
            onSelect: () => runMenuAction(onPrint, false),
          },
          { type: 'separator' },
          {
            type: 'item',
            id: 'file-details',
            label: 'Document Details & Word Count',
            onSelect: () => {
              setOpenMenu(null);
              setActivePopover('details');
            },
          },
          {
            type: 'item',
            id: 'file-home',
            label: 'Close to Home',
            onSelect: () => runMenuAction(onGoHome, false),
          },
        ];

      case 'edit':
        return [
          {
            type: 'item',
            id: 'edit-undo',
            label: 'Undo',
            shortcut: fmtShortcut('Z'),
            disabled: !canUndo,
            onSelect: () => runMenuAction(onUndo),
          },
          {
            type: 'item',
            id: 'edit-redo',
            label: 'Redo',
            shortcut: isMac ? '⇧⌘Z' : 'Ctrl+Y',
            disabled: !canRedo,
            onSelect: () => runMenuAction(onRedo),
          },
          { type: 'separator' },
          {
            type: 'item',
            id: 'edit-cut',
            label: 'Cut',
            shortcut: fmtShortcut('X'),
            disabled: !editMode,
            onSelect: () => runMenuAction(() => onClipboard('cut')),
          },
          {
            type: 'item',
            id: 'edit-copy',
            label: 'Copy',
            shortcut: fmtShortcut('C'),
            onSelect: () => runMenuAction(() => onClipboard('copy'), false),
          },
          {
            type: 'item',
            id: 'edit-paste',
            label: 'Paste',
            shortcut: fmtShortcut('V'),
            disabled: !editMode,
            onSelect: () => runMenuAction(() => onClipboard('paste')),
          },
          {
            type: 'item',
            id: 'edit-paste-plain',
            label: 'Paste Without Formatting',
            shortcut: isMac ? '⇧⌘V' : 'Ctrl+Shift+V',
            disabled: !editMode,
            onSelect: () => runMenuAction(() => onClipboard('pastePlain')),
          },
          { type: 'separator' },
          {
            type: 'item',
            id: 'edit-select-all',
            label: 'Select All',
            shortcut: fmtShortcut('A'),
            onSelect: () => runMenuAction(onSelectAll, false),
          },
          {
            type: 'item',
            id: 'edit-find',
            label: 'Find & Replace',
            shortcut: fmtShortcut('F'),
            onSelect: () => {
              closeAllMenus();
              onFindOpenChange(true);
              window.requestAnimationFrame(() => {
                findInputRef.current?.focus();
                findInputRef.current?.select();
              });
            },
          },
        ];

      case 'insert': {
        const items: MenuEntry[] = [
          {
            type: 'item',
            id: 'insert-image',
            label: 'Image…',
            disabled: !editMode,
            onSelect: () => runMenuAction(onInsertImageClick, false),
          },
          {
            type: 'item',
            id: 'insert-table',
            label: 'Table…',
            disabled: !editMode,
            onSelect: () => {
              setOpenMenu(null);
              setActivePopover('table');
            },
          },
          {
            type: 'item',
            id: 'insert-link',
            label: 'Link…',
            shortcut: fmtShortcut('K'),
            disabled: !editMode,
            onSelect: () => {
              closeAllMenus();
              onLinkOpenChange(true);
            },
          },
          { type: 'separator' },
          {
            type: 'item',
            id: 'insert-code',
            label: 'Code Block',
            disabled: !editMode,
            onSelect: () => runMenuAction(() => onInsertSpecialBlock('codeBlock'), false),
          },
          {
            type: 'item',
            id: 'insert-quote',
            label: 'Block Quote',
            disabled: !editMode,
            onSelect: () => runMenuAction(() => onInsertSpecialBlock('blockQuote'), false),
          },
          {
            type: 'item',
            id: 'insert-hr',
            label: 'Horizontal Rule',
            disabled: !editMode,
            onSelect: () => runMenuAction(() => onInsertSpecialBlock('horizontalRule'), false),
          },
          {
            type: 'item',
            id: 'insert-pagebreak',
            label: 'Page Break',
            shortcut: fmtShortcut('Enter'),
            disabled: !editMode,
            onSelect: () => runMenuAction(() => onInsertSpecialBlock('pageBreak'), false),
          },
          {
            type: 'item',
            id: 'insert-footnote',
            label: 'Footnote',
            disabled: !editMode,
            onSelect: () => runMenuAction(() => onInsertSpecialBlock('footnote'), false),
          },
        ];

        if (selection.inTable && editMode) {
          items.push(
            { type: 'separator' },
            { type: 'section', label: 'Current Table' },
            {
              type: 'item',
              id: 'tbl-add-row',
              label: 'Add Row Below',
              onSelect: () => runMenuAction(() => onTableAction('addRow'), false),
            },
            {
              type: 'item',
              id: 'tbl-add-col',
              label: 'Add Column Right',
              onSelect: () => runMenuAction(() => onTableAction('addCol'), false),
            },
            {
              type: 'item',
              id: 'tbl-del-row',
              label: 'Delete Row',
              disabled: selection.tableRowCount <= 1,
              onSelect: () => runMenuAction(() => onTableAction('deleteRow'), false),
            },
            {
              type: 'item',
              id: 'tbl-del-col',
              label: 'Delete Column',
              disabled: selection.tableColCount <= 1,
              onSelect: () => runMenuAction(() => onTableAction('deleteCol'), false),
            },
          );
        }
        return items;
      }

      case 'format':
        return [
          { type: 'section', label: 'Text' },
          {
            type: 'item',
            id: 'fmt-bold',
            label: 'Bold',
            shortcut: fmtShortcut('B'),
            checked: Boolean(selection.textStyle.bold),
            disabled: !editMode,
            onSelect: () => runMenuAction(() => onToggleInlineStyle('bold')),
          },
          {
            type: 'item',
            id: 'fmt-italic',
            label: 'Italic',
            shortcut: fmtShortcut('I'),
            checked: Boolean(selection.textStyle.italic),
            disabled: !editMode,
            onSelect: () => runMenuAction(() => onToggleInlineStyle('italic')),
          },
          {
            type: 'item',
            id: 'fmt-underline',
            label: 'Underline',
            shortcut: fmtShortcut('U'),
            checked: Boolean(selection.textStyle.underline),
            disabled: !editMode,
            onSelect: () => runMenuAction(() => onToggleInlineStyle('underline')),
          },
          {
            type: 'item',
            id: 'fmt-strike',
            label: 'Strikethrough',
            checked: Boolean(selection.textStyle.strikethrough),
            disabled: !editMode,
            onSelect: () => runMenuAction(() => onToggleInlineStyle('strikethrough')),
          },
          {
            type: 'item',
            id: 'fmt-code',
            label: 'Inline Code',
            checked: Boolean(selection.textStyle.code),
            disabled: !editMode,
            onSelect: () => runMenuAction(() => onToggleInlineStyle('code')),
          },
          {
            type: 'item',
            id: 'fmt-sup',
            label: 'Superscript',
            checked: Boolean(selection.textStyle.superscript),
            disabled: !editMode,
            onSelect: () => runMenuAction(() => onToggleInlineStyle('superscript')),
          },
          {
            type: 'item',
            id: 'fmt-sub',
            label: 'Subscript',
            checked: Boolean(selection.textStyle.subscript),
            disabled: !editMode,
            onSelect: () => runMenuAction(() => onToggleInlineStyle('subscript')),
          },
          { type: 'separator' },
          { type: 'section', label: 'Paragraph Styles' },
          {
            type: 'item',
            id: 'fmt-normal',
            label: 'Normal Text',
            checked: selection.blockType === 'paragraph',
            radio: true,
            disabled: !editMode,
            onSelect: () => runMenuAction(() => onConvertBlock({ kind: 'paragraph' })),
          },
          ...([1, 2, 3, 4, 5, 6] as const).map(
            (lvl): MenuActionItem => ({
              type: 'item',
              id: `fmt-h${lvl}`,
              label: `Heading ${lvl}`,
              checked: selection.blockType === 'heading' && selection.headingLevel === lvl,
              radio: true,
              disabled: !editMode,
              onSelect: () =>
                runMenuAction(() => onConvertBlock({ kind: 'heading', level: lvl })),
            }),
          ),
          { type: 'separator' },
          { type: 'section', label: 'Alignment & Indentation' },
          {
            type: 'item',
            id: 'fmt-align-left',
            label: 'Align Left',
            checked: selection.canAlign && selection.align === 'left',
            radio: true,
            disabled: !editMode || !selection.canAlign,
            onSelect: () => runMenuAction(() => onSetAlignment('left')),
          },
          {
            type: 'item',
            id: 'fmt-align-center',
            label: 'Align Center',
            checked: selection.canAlign && selection.align === 'center',
            radio: true,
            disabled: !editMode || !selection.canAlign,
            onSelect: () => runMenuAction(() => onSetAlignment('center')),
          },
          {
            type: 'item',
            id: 'fmt-align-right',
            label: 'Align Right',
            checked: selection.canAlign && selection.align === 'right',
            radio: true,
            disabled: !editMode || !selection.canAlign,
            onSelect: () => runMenuAction(() => onSetAlignment('right')),
          },
          {
            type: 'item',
            id: 'fmt-align-justify',
            label: 'Justify',
            checked: selection.canAlign && selection.align === 'justify',
            radio: true,
            disabled: !editMode || !selection.canAlign,
            onSelect: () => runMenuAction(() => onSetAlignment('justify')),
          },
          {
            type: 'item',
            id: 'fmt-indent-inc',
            label: 'Increase Indent',
            shortcut: 'Tab',
            disabled: !editMode || !selection.canIndent || selection.indentLevel >= 6,
            onSelect: () => runMenuAction(() => onChangeIndent(1)),
          },
          {
            type: 'item',
            id: 'fmt-indent-dec',
            label: 'Decrease Indent',
            shortcut: 'Shift+Tab',
            disabled: !editMode || !selection.canIndent || selection.indentLevel <= 0,
            onSelect: () => runMenuAction(() => onChangeIndent(-1)),
          },
          { type: 'separator' },
          { type: 'section', label: 'Lists' },
          {
            type: 'item',
            id: 'fmt-list-bullet',
            label: 'Bulleted List',
            checked: selection.listKind === 'bullet',
            disabled: !editMode,
            onSelect: () =>
              runMenuAction(() =>
                onConvertBlock({ kind: 'list', ordered: false, checklist: false }),
              ),
          },
          {
            type: 'item',
            id: 'fmt-list-ordered',
            label: 'Numbered List',
            checked: selection.listKind === 'ordered',
            disabled: !editMode,
            onSelect: () =>
              runMenuAction(() =>
                onConvertBlock({ kind: 'list', ordered: true, checklist: false }),
              ),
          },
          {
            type: 'item',
            id: 'fmt-list-check',
            label: 'Checklist',
            checked: selection.listKind === 'checklist',
            disabled: !editMode,
            onSelect: () =>
              runMenuAction(() =>
                onConvertBlock({ kind: 'list', ordered: false, checklist: true }),
              ),
          },
          { type: 'separator' },
          {
            type: 'item',
            id: 'fmt-clear',
            label: 'Clear Formatting',
            shortcut: fmtShortcut('\\'),
            disabled: !editMode,
            onSelect: () => runMenuAction(onClearFormatting),
          },
        ];

      case 'view':
        return [
          { type: 'section', label: 'Mode' },
          {
            type: 'item',
            id: 'view-mode-edit',
            label: 'Editing',
            checked: editMode,
            radio: true,
            onSelect: () => runMenuAction(() => onEditModeChange(true)),
          },
          {
            type: 'item',
            id: 'view-mode-read',
            label: 'Reading',
            checked: !editMode,
            radio: true,
            onSelect: () => runMenuAction(() => onEditModeChange(false), false),
          },
          { type: 'separator' },
          {
            type: 'item',
            id: 'view-format-bar',
            label: 'Formatting Bar',
            checked: showFormattingBar,
            onSelect: () => runMenuAction(onToggleFormattingBar, false),
          },
          {
            type: 'item',
            id: 'view-outline',
            label: 'Outline Sidebar',
            checked: showOutline,
            onSelect: () => runMenuAction(onToggleOutline, false),
          },
          {
            type: 'item',
            id: 'view-inspector',
            label: 'Inspector & Diagnostics',
            checked: showInspector,
            onSelect: () => runMenuAction(onToggleInspector, false),
          },
          { type: 'separator' },
          { type: 'section', label: `Zoom (${Math.round(zoom * 100)}%)` },
          {
            type: 'item',
            id: 'view-zoom-in',
            label: 'Zoom In',
            disabled: zoom >= 2.5,
            onSelect: () =>
              runMenuAction(
                () => onZoomChange(Math.min(2.5, Math.round((zoom + 0.15) * 100) / 100)),
                false,
              ),
          },
          {
            type: 'item',
            id: 'view-zoom-out',
            label: 'Zoom Out',
            disabled: zoom <= 0.5,
            onSelect: () =>
              runMenuAction(
                () => onZoomChange(Math.max(0.5, Math.round((zoom - 0.15) * 100) / 100)),
                false,
              ),
          },
          {
            type: 'item',
            id: 'view-zoom-reset',
            label: 'Reset Zoom (100%)',
            onSelect: () => runMenuAction(() => onZoomChange(1), false),
          },
          { type: 'separator' },
          { type: 'section', label: 'Theme' },
          {
            type: 'item',
            id: 'view-theme-system',
            label: 'System',
            checked: mode === 'system',
            radio: true,
            onSelect: () => runMenuAction(() => setMode('system'), false),
          },
          {
            type: 'item',
            id: 'view-theme-light',
            label: 'Light',
            checked: mode === 'light',
            radio: true,
            onSelect: () => runMenuAction(() => setMode('light'), false),
          },
          {
            type: 'item',
            id: 'view-theme-dark',
            label: 'Dark',
            checked: mode === 'dark',
            radio: true,
            onSelect: () => runMenuAction(() => setMode('dark'), false),
          },
        ];
    }
  };

  const focusMenuPanelItem = (target: TopMenuId, position: 'first' | 'last') => {
    window.requestAnimationFrame(() => {
      const items = rootRef.current?.querySelectorAll<HTMLElement>(
        `[data-menu-panel="${target}"] [role="menuitem"]:not(:disabled), [data-menu-panel="${target}"] [role="menuitemcheckbox"]:not(:disabled), [data-menu-panel="${target}"] [role="menuitemradio"]:not(:disabled)`,
      );
      if (!items || items.length === 0) return;
      const el = position === 'first' ? items[0] : items[items.length - 1];
      el?.focus();
    });
  };

  const handleMenuBarKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const nextIdx = (idx + 1) % TOP_MENUS.length;
      const next = TOP_MENUS[nextIdx];
      setRovingMenuIdx(nextIdx);
      menuBtnRefs.current[next.id]?.focus();
      if (openMenu) setOpenMenu(next.id);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const prevIdx = (idx - 1 + TOP_MENUS.length) % TOP_MENUS.length;
      const prev = TOP_MENUS[prevIdx];
      setRovingMenuIdx(prevIdx);
      menuBtnRefs.current[prev.id]?.focus();
      if (openMenu) setOpenMenu(prev.id);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setRovingMenuIdx(0);
      menuBtnRefs.current[TOP_MENUS[0].id]?.focus();
      if (openMenu) setOpenMenu(TOP_MENUS[0].id);
    } else if (e.key === 'End') {
      e.preventDefault();
      const lastIdx = TOP_MENUS.length - 1;
      setRovingMenuIdx(lastIdx);
      menuBtnRefs.current[TOP_MENUS[lastIdx].id]?.focus();
      if (openMenu) setOpenMenu(TOP_MENUS[lastIdx].id);
    } else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const target = TOP_MENUS[idx].id;
      setRovingMenuIdx(idx);
      setOpenMenu(target);
      setActivePopover(null);
      focusMenuPanelItem(target, 'first');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const target = TOP_MENUS[idx].id;
      setRovingMenuIdx(idx);
      setOpenMenu(target);
      setActivePopover(null);
      focusMenuPanelItem(target, 'last');
    }
  };

  const handleDropdownKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, menuId: TopMenuId) => {
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR),
    );
    const currentIdx = items.indexOf(document.activeElement as HTMLButtonElement);
    const topIdx = TOP_MENUS.findIndex((m) => m.id === menuId);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length > 0) {
        const next = currentIdx === -1 ? 0 : (currentIdx + 1) % items.length;
        items[next]?.focus();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length > 0) {
        const prev =
          currentIdx === -1 ? items.length - 1 : (currentIdx - 1 + items.length) % items.length;
        items[prev]?.focus();
      }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      const nextIdx = (topIdx + 1) % TOP_MENUS.length;
      const next = TOP_MENUS[nextIdx];
      setRovingMenuIdx(nextIdx);
      setOpenMenu(next.id);
      menuBtnRefs.current[next.id]?.focus();
      focusMenuPanelItem(next.id, 'first');
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const prevIdx = (topIdx - 1 + TOP_MENUS.length) % TOP_MENUS.length;
      const prev = TOP_MENUS[prevIdx];
      setRovingMenuIdx(prevIdx);
      setOpenMenu(prev.id);
      menuBtnRefs.current[prev.id]?.focus();
      focusMenuPanelItem(prev.id, 'first');
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      setOpenMenu(null);
    }
  };

  const handleAlignPopoverKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
    if (items.length === 0) return;
    const currentIdx = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      items[(currentIdx + 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(currentIdx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      setActivePopover(null);
    }
  };

  const handleTableGridKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, r: number, c: number) => {
    let nextR = r;
    let nextC = c;
    if (e.key === 'ArrowRight') nextC = Math.min(5, c + 1);
    else if (e.key === 'ArrowLeft') nextC = Math.max(0, c - 1);
    else if (e.key === 'ArrowDown') nextR = Math.min(5, r + 1);
    else if (e.key === 'ArrowUp') nextR = Math.max(0, r - 1);
    else return;

    e.preventDefault();
    setTableHover({ rows: nextR + 1, cols: nextC + 1 });
    const cells = tableGridRef.current?.querySelectorAll<HTMLButtonElement>('button');
    cells?.[nextR * 6 + nextC]?.focus();
  };

  const defaultFontPt = defaultFontSizeForSelection(selection);
  const activeFontSize = Math.round(selection.textStyle.fontSizePt ?? defaultFontPt);

  const fontSizeOptions = useMemo(() => {
    if (FONT_SIZE_PRESETS.includes(activeFontSize)) {
      return FONT_SIZE_PRESETS;
    }
    return [...FONT_SIZE_PRESETS, activeFontSize].sort((a, b) => a - b);
  }, [activeFontSize]);

  const stepFontSize = (delta: 1 | -1) => {
    const current = selection.textStyle.fontSizePt ?? defaultFontPt;
    const next = Math.max(FONT_SIZE_MIN_PT, Math.min(FONT_SIZE_MAX_PT, Math.round(current + delta)));
    onSetFontSize(next);
  };

  const handleBlockStyleSelect = (value: string) => {
    if (value === 'normal') onConvertBlock({ kind: 'paragraph' });
    else if (value === 'quote') onConvertBlock({ kind: 'blockQuote' });
    else if (value === 'code') onConvertBlock({ kind: 'codeBlock' });
    else if (value.startsWith('h')) {
      const level = Number.parseInt(value.slice(1), 10);
      if (level >= 1 && level <= 6) {
        onConvertBlock({ kind: 'heading', level });
      }
    }
  };

  const themes: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
    { value: 'system', label: 'System theme', icon: <MonitorIcon /> },
    { value: 'light', label: 'Light theme', icon: <SunIcon /> },
    { value: 'dark', label: 'Dark theme', icon: <MoonIcon /> },
  ];

  const alignmentOptions: [TextAlign, string, React.ReactNode][] = [
    ['left', 'Align Left', <AlignLeftIcon key="l" />],
    ['center', 'Align Center', <AlignCenterIcon key="c" />],
    ['right', 'Align Right', <AlignRightIcon key="r" />],
    ['justify', 'Justify', <AlignJustifyIcon key="j" />],
  ];

  const renderFontSizeGroup = (inOverflow = false) => (
    <div className={inOverflow ? 'orb-overflow-row' : 'orb-fmt-group orb-fontsize-group'}>
      <button
        id={inOverflow ? undefined : 'orb-fmt-size-dec'}
        type="button"
        className="orb-fmt-btn compact"
        title="Decrease font size"
        aria-label="Decrease font size"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => stepFontSize(-1)}
      >
        −
      </button>
      <select
        id={inOverflow ? undefined : 'orb-fmt-font-size'}
        className="orb-fmt-select size"
        aria-label="Font size in points"
        value={String(activeFontSize)}
        onChange={(e) => {
          const parsed = Number.parseFloat(e.target.value);
          onSetFontSize(Number.isFinite(parsed) ? parsed : null);
          window.requestAnimationFrame(() => onRestoreFocus());
        }}
      >
        {fontSizeOptions.map((pt) => (
          <option key={pt} value={String(pt)}>
            {pt}
          </option>
        ))}
      </select>
      <button
        id={inOverflow ? undefined : 'orb-fmt-size-inc'}
        type="button"
        className="orb-fmt-btn compact"
        title="Increase font size"
        aria-label="Increase font size"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => stepFontSize(1)}
      >
        +
      </button>
    </div>
  );

  const renderAlignmentGroup = (inOverflow = false) => (
    <div className={inOverflow ? 'orb-overflow-row' : 'orb-fmt-group'}>
      {inOverflow ? (
        alignmentOptions.map(([val, lbl, ico]) => (
          <button
            key={val}
            type="button"
            className={`orb-fmt-btn ${selection.canAlign && selection.align === val ? 'active' : ''}`}
            disabled={!selection.canAlign}
            title={lbl}
            aria-label={lbl}
            aria-pressed={selection.canAlign && selection.align === val}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onSetAlignment(val);
              setActivePopover(null);
              window.requestAnimationFrame(() => onRestoreFocus());
            }}
          >
            {ico}
          </button>
        ))
      ) : (
        <div className="orb-popover-anchor">
          <button
            id="orb-fmt-align-btn"
            type="button"
            className={`orb-fmt-btn ${activePopover === 'align' ? 'active' : ''}`}
            disabled={!selection.canAlign}
            title="Text Alignment"
            aria-label="Text Alignment"
            aria-haspopup="menu"
            aria-expanded={activePopover === 'align'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() =>
              setActivePopover((prev) => (prev === 'align' ? null : 'align'))
            }
          >
            {alignIcon(selection.align)}
            <ChevronDownIcon size={11} />
          </button>
          {activePopover === 'align' && (
            <div
              ref={alignPopoverRef}
              className="orb-popover orb-align-popover"
              role="menu"
              aria-label="Alignment options"
              onKeyDown={handleAlignPopoverKeyDown}
            >
              {alignmentOptions.map(([val, lbl, ico]) => (
                <button
                  key={val}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selection.align === val}
                  className={`orb-fmt-btn ${selection.align === val ? 'active' : ''}`}
                  title={lbl}
                  aria-label={lbl}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onSetAlignment(val);
                    setActivePopover(null);
                    window.requestAnimationFrame(() => onRestoreFocus());
                  }}
                >
                  {ico}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <button
        id={inOverflow ? undefined : 'orb-fmt-indent-dec'}
        type="button"
        className="orb-fmt-btn"
        disabled={!selection.canIndent || selection.indentLevel <= 0}
        title="Decrease Indent (Shift+Tab)"
        aria-label="Decrease Indent"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onChangeIndent(-1)}
      >
        <IndentDecreaseIcon />
      </button>
      <button
        id={inOverflow ? undefined : 'orb-fmt-indent-inc'}
        type="button"
        className="orb-fmt-btn"
        disabled={!selection.canIndent || selection.indentLevel >= 6}
        title="Increase Indent (Tab)"
        aria-label="Increase Indent"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onChangeIndent(1)}
      >
        <IndentIncreaseIcon />
      </button>
    </div>
  );

  const renderListsGroup = (inOverflow = false) => (
    <div className={inOverflow ? 'orb-overflow-row' : 'orb-fmt-group'}>
      <button
        id={inOverflow ? undefined : 'orb-fmt-list-bullet'}
        type="button"
        className={`orb-fmt-btn ${selection.listKind === 'bullet' ? 'active' : ''}`}
        title="Bulleted List"
        aria-label="Bulleted List"
        aria-pressed={selection.listKind === 'bullet'}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() =>
          onConvertBlock(
            selection.listKind === 'bullet'
              ? { kind: 'paragraph' }
              : { kind: 'list', ordered: false, checklist: false },
          )
        }
      >
        <ListBulletIcon />
      </button>
      <button
        id={inOverflow ? undefined : 'orb-fmt-list-ordered'}
        type="button"
        className={`orb-fmt-btn ${selection.listKind === 'ordered' ? 'active' : ''}`}
        title="Numbered List"
        aria-label="Numbered List"
        aria-pressed={selection.listKind === 'ordered'}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() =>
          onConvertBlock(
            selection.listKind === 'ordered'
              ? { kind: 'paragraph' }
              : { kind: 'list', ordered: true, checklist: false },
          )
        }
      >
        <ListNumberedIcon />
      </button>
      <button
        id={inOverflow ? undefined : 'orb-fmt-list-check'}
        type="button"
        className={`orb-fmt-btn ${selection.listKind === 'checklist' ? 'active' : ''}`}
        title="Checklist"
        aria-label="Checklist"
        aria-pressed={selection.listKind === 'checklist'}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() =>
          onConvertBlock(
            selection.listKind === 'checklist'
              ? { kind: 'paragraph' }
              : { kind: 'list', ordered: false, checklist: true },
          )
        }
      >
        <ListCheckIcon />
      </button>
    </div>
  );

  const renderQuickInsertGroup = (inOverflow = false) => (
    <div className={inOverflow ? 'orb-overflow-row' : 'orb-fmt-group'}>
      <button
        id={inOverflow ? undefined : 'orb-fmt-link'}
        type="button"
        className={`orb-fmt-btn ${selection.textStyle.href ? 'active' : ''}`}
        title={`Insert Link (${fmtShortcut('K')})`}
        aria-label="Insert Link"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setActivePopover(null);
          onLinkOpenChange(!linkOpen);
        }}
      >
        <LinkIcon />
      </button>
      <button
        id={inOverflow ? undefined : 'orb-fmt-image'}
        type="button"
        className="orb-fmt-btn"
        title="Insert Image"
        aria-label="Insert Image"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setActivePopover(null);
          onInsertImageClick();
        }}
      >
        <ImageIcon />
      </button>
      <button
        id={inOverflow ? undefined : 'orb-fmt-table'}
        type="button"
        className={`orb-fmt-btn ${activePopover === 'table' ? 'active' : ''}`}
        title="Insert Table"
        aria-label="Insert Table"
        aria-expanded={activePopover === 'table'}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() =>
          setActivePopover((prev) => (prev === 'table' ? null : 'table'))
        }
      >
        <TableIcon />
      </button>
    </div>
  );

  const renderClearGroup = (inOverflow = false) => (
    <div className={inOverflow ? 'orb-overflow-row' : 'orb-fmt-group'}>
      <button
        id={inOverflow ? undefined : 'orb-fmt-clear'}
        type="button"
        className="orb-fmt-btn"
        title={`Clear Formatting (${fmtShortcut('\\')})`}
        aria-label="Clear Formatting"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          onClearFormatting();
          if (inOverflow) setActivePopover(null);
        }}
      >
        <ClearFormatIcon />
      </button>
    </div>
  );

  const safeFindIdx =
    findMatchCount > 0
      ? ((findActiveIndex % findMatchCount) + findMatchCount) % findMatchCount
      : 0;

  return (
    <div ref={rootRef} className="orb-editor-chrome">
      {/* Bar 1: Top Menu & Document Header Bar */}
      <header className="orb-editor-menubar-bar">
        <div className={`orb-editor-header-left ${renamingTitle ? 'is-renaming' : ''}`}>
          <button
            id="orb-home-btn"
            type="button"
            className="orb-brand"
            onClick={onGoHome}
            title="Orb Home"
          >
            <OrbLogoIcon size={18} />
            <span className="orb-brand-label">orb</span>
          </button>

          <span className="orb-divider orb-title-divider" />

          <div className={`orb-title-slot ${renamingTitle ? 'is-renaming' : ''}`}>
            {renamingTitle ? (
              <input
                ref={titleInputRef}
                id="orb-doc-title-input"
                type="text"
                className="orb-title-input"
                value={titleDraft}
                aria-label="Document title"
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  const restoreAfterRename = () => {
                    window.requestAnimationFrame(() => {
                      if (titleBtnRef.current && titleBtnRef.current.offsetParent !== null) {
                        titleBtnRef.current.focus();
                      } else {
                        onRestoreFocus();
                      }
                    });
                  };
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitTitle();
                    restoreAfterRename();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    e.nativeEvent.stopPropagation();
                    setTitleDraft(filename);
                    setRenamingTitle(false);
                    restoreAfterRename();
                  }
                }}
              />
            ) : (
              <button
                ref={titleBtnRef}
                id="orb-doc-title-btn"
                type="button"
                className="orb-title-btn"
                title="Click to rename document"
                onClick={() => setRenamingTitle(true)}
              >
                <span className="orb-doc-name">{filename}</span>
                {dirty && <span className="orb-dirty-dot" title="Unsaved edits" />}
              </button>
            )}
          </div>

          <span className="orb-divider" />

          <nav className="orb-menubar" role="menubar" aria-label="Document editor menu">
            {TOP_MENUS.map((menu, idx) => {
              const isOpen = openMenu === menu.id;
              return (
                <div key={menu.id} className="orb-menu-wrapper" role="none">
                  <button
                    ref={(el) => {
                      menuBtnRefs.current[menu.id] = el;
                    }}
                    id={`orb-menu-${menu.id}`}
                    type="button"
                    role="menuitem"
                    tabIndex={rovingMenuIdx === idx ? 0 : -1}
                    aria-haspopup="menu"
                    aria-expanded={isOpen}
                    className={`orb-menubar-btn ${isOpen ? 'is-open' : ''}`}
                    onFocus={() => setRovingMenuIdx(idx)}
                    onClick={() => {
                      setRovingMenuIdx(idx);
                      setActivePopover(null);
                      setOpenMenu((prev) => (prev === menu.id ? null : menu.id));
                    }}
                    onMouseEnter={() => {
                      if (openMenu !== null && openMenu !== menu.id) {
                        setRovingMenuIdx(idx);
                        setOpenMenu(menu.id);
                      }
                    }}
                    onKeyDown={(e) => handleMenuBarKeyDown(e, idx)}
                  >
                    {menu.label}
                  </button>

                  {isOpen && (
                    <div
                      data-menu-panel={menu.id}
                      className="orb-menu-dropdown"
                      role="menu"
                      aria-label={menu.label}
                      onKeyDown={(e) => handleDropdownKeyDown(e, menu.id)}
                    >
                      {buildMenuEntries(menu.id).map((entry, entryIdx) => {
                        if (entry.type === 'separator') {
                          return (
                            <div
                              key={`sep-${entryIdx}`}
                              className="orb-menu-sep"
                              role="separator"
                            />
                          );
                        }
                        if (entry.type === 'section') {
                          return (
                            <div
                              key={`sec-${entryIdx}`}
                              className="orb-menu-section"
                              role="presentation"
                            >
                              {entry.label}
                            </div>
                          );
                        }
                        const isCheck = entry.checked !== undefined;
                        const role = isCheck
                          ? entry.radio
                            ? 'menuitemradio'
                            : 'menuitemcheckbox'
                          : 'menuitem';
                        return (
                          <button
                            key={entry.id}
                            id={`orb-menuitem-${entry.id}`}
                            type="button"
                            role={role}
                            tabIndex={-1}
                            aria-checked={isCheck ? entry.checked : undefined}
                            disabled={entry.disabled}
                            className="orb-menu-item"
                            onClick={entry.onSelect}
                          >
                            <span className="orb-menu-check">
                              {entry.checked ? <CheckIcon size={12} /> : null}
                            </span>
                            <span className="orb-menu-label">{entry.label}</span>
                            {entry.shortcut && (
                              <span className="orb-menu-shortcut">{entry.shortcut}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
        </div>

        <div className="orb-editor-header-right">
          <button
            id="orb-toggle-outline-btn"
            type="button"
            className={`orb-btn icon-only ghost ${showOutline ? 'active' : ''}`}
            onClick={onToggleOutline}
            title="Toggle Outline Sidebar"
            aria-label="Toggle Outline Sidebar"
            aria-pressed={showOutline}
          >
            <SidebarLeftIcon size={15} />
          </button>

          <button
            id="orb-toggle-inspector-btn"
            type="button"
            className={`orb-btn icon-only ghost ${showInspector ? 'active' : ''}`}
            onClick={onToggleInspector}
            title="Toggle Inspector Panel"
            aria-label="Toggle Inspector Panel"
            aria-pressed={showInspector}
          >
            <SidebarRightIcon size={15} />
          </button>

          <button
            id="orb-export-docx-btn"
            type="button"
            className={`orb-btn ${dirty ? 'primary' : ''}`}
            disabled={exportBusy}
            onClick={onExportDocx}
            title={`Download as Word (.docx) (${fmtShortcut('S')})`}
          >
            <DownloadIcon size={14} />
            <span className="orb-export-label">Export</span>
          </button>

          <span className="orb-divider orb-theme-divider" />

          <div className="orb-segmented orb-theme-switcher" role="group" aria-label="Color theme">
            {themes.map((t) => (
              <button
                key={t.value}
                id={`orb-theme-${t.value}`}
                type="button"
                className={mode === t.value ? 'is-selected' : ''}
                onClick={() => setMode(t.value)}
                title={t.label}
                aria-label={t.label}
                aria-pressed={mode === t.value}
              >
                {t.icon}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Bar 2: Minimalist Formatting Bar (<= 40px tall, collapsible) */}
      {editMode && showFormattingBar && (
        <div
          ref={formatBarRef}
          id="orb-formatting-bar"
          className="orb-formatting-bar"
          role="toolbar"
          aria-label="Document formatting"
        >
          {/* 1. History */}
          <div className="orb-fmt-group">
            <button
              id="orb-fmt-undo"
              type="button"
              className="orb-fmt-btn"
              disabled={!canUndo}
              title={`Undo (${fmtShortcut('Z')})`}
              aria-label="Undo"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onUndo}
            >
              <UndoIcon />
            </button>
            <button
              id="orb-fmt-redo"
              type="button"
              className="orb-fmt-btn"
              disabled={!canRedo}
              title={`Redo (${isMac ? '⇧⌘Z' : 'Ctrl+Y'})`}
              aria-label="Redo"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onRedo}
            >
              <RedoIcon />
            </button>
          </div>

          <span className="orb-fmt-divider" />

          {/* 2. Block Style */}
          <div className="orb-fmt-group">
            <select
              id="orb-fmt-block-style"
              className="orb-fmt-select"
              aria-label="Block style"
              value={currentBlockStyleValue(selection)}
              onChange={(e) => {
                const val = e.target.value;
                handleBlockStyleSelect(val);
                if (val !== 'code') {
                  window.requestAnimationFrame(() => onRestoreFocus());
                }
              }}
            >
              <option value="normal">Normal</option>
              <option value="h1">Heading 1</option>
              <option value="h2">Heading 2</option>
              <option value="h3">Heading 3</option>
              <option value="h4">Heading 4</option>
              <option value="h5">Heading 5</option>
              <option value="h6">Heading 6</option>
              <option value="quote">Quote</option>
              <option value="code">Code</option>
            </select>
          </div>

          {/* 3. Font Size (folds at overflowLevel >= 4) */}
          {overflowLevel < 4 && (
            <>
              <span className="orb-fmt-divider" />
              {renderFontSizeGroup(false)}
            </>
          )}

          <span className="orb-fmt-divider" />

          {/* 4. Inline Emphasis */}
          <div className="orb-fmt-group">
            <button
              id="orb-fmt-bold"
              type="button"
              className={`orb-fmt-btn ${selection.textStyle.bold ? 'active' : ''}`}
              title={`Bold (${fmtShortcut('B')})`}
              aria-label="Bold"
              aria-pressed={Boolean(selection.textStyle.bold)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onToggleInlineStyle('bold')}
            >
              <BoldIcon />
            </button>
            <button
              id="orb-fmt-italic"
              type="button"
              className={`orb-fmt-btn ${selection.textStyle.italic ? 'active' : ''}`}
              title={`Italic (${fmtShortcut('I')})`}
              aria-label="Italic"
              aria-pressed={Boolean(selection.textStyle.italic)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onToggleInlineStyle('italic')}
            >
              <ItalicIcon />
            </button>
            <button
              id="orb-fmt-underline"
              type="button"
              className={`orb-fmt-btn ${selection.textStyle.underline ? 'active' : ''}`}
              title={`Underline (${fmtShortcut('U')})`}
              aria-label="Underline"
              aria-pressed={Boolean(selection.textStyle.underline)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onToggleInlineStyle('underline')}
            >
              <UnderlineIcon />
            </button>
            {overflowLevel < 5 && (
              <>
                <button
                  id="orb-fmt-strike"
                  type="button"
                  className={`orb-fmt-btn ${selection.textStyle.strikethrough ? 'active' : ''}`}
                  title="Strikethrough"
                  aria-label="Strikethrough"
                  aria-pressed={Boolean(selection.textStyle.strikethrough)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onToggleInlineStyle('strikethrough')}
                >
                  <StrikethroughIcon />
                </button>
                <button
                  id="orb-fmt-code"
                  type="button"
                  className={`orb-fmt-btn ${selection.textStyle.code ? 'active' : ''}`}
                  title="Inline Code"
                  aria-label="Inline Code"
                  aria-pressed={Boolean(selection.textStyle.code)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onToggleInlineStyle('code')}
                >
                  <CodeIcon />
                </button>
              </>
            )}
          </div>

          {/* 5. Paragraph Layout (folds at overflowLevel >= 3) */}
          {overflowLevel < 3 && (
            <>
              <span className="orb-fmt-divider" />
              {renderAlignmentGroup(false)}
            </>
          )}

          {/* 6. Lists (folds at overflowLevel >= 2) */}
          {overflowLevel < 2 && (
            <>
              <span className="orb-fmt-divider" />
              {renderListsGroup(false)}
            </>
          )}

          {/* 7 & 8. Quick Insert + Cleanup (folds at overflowLevel >= 1) */}
          {overflowLevel < 1 && (
            <>
              <span className="orb-fmt-divider" />
              {renderQuickInsertGroup(false)}
              <span className="orb-fmt-divider" />
              {renderClearGroup(false)}
            </>
          )}

          {/* Responsive overflow trigger */}
          {overflowLevel > 0 && (
            <>
              <span className="orb-fmt-divider" />
              <div className="orb-popover-anchor">
                <button
                  id="orb-fmt-overflow-btn"
                  type="button"
                  className={`orb-fmt-btn ${activePopover === 'overflow' ? 'active' : ''}`}
                  title="More formatting options"
                  aria-label="More formatting options"
                  aria-expanded={activePopover === 'overflow'}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() =>
                    setActivePopover((prev) => (prev === 'overflow' ? null : 'overflow'))
                  }
                >
                  <MoreHorizontalIcon />
                </button>
                {activePopover === 'overflow' && (
                  <div
                    ref={overflowPopoverRef}
                    className="orb-popover orb-overflow-popover"
                    role="group"
                    aria-label="More formatting options"
                    onMouseDown={(e) => {
                      if ((e.target as HTMLElement).tagName !== 'SELECT') {
                        e.preventDefault();
                      }
                    }}
                    onBlur={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                        setActivePopover(null);
                      }
                    }}
                  >
                    {overflowLevel >= 5 && (
                      <div className="orb-overflow-row">
                        <button
                          type="button"
                          className={`orb-fmt-btn ${selection.textStyle.strikethrough ? 'active' : ''}`}
                          title="Strikethrough"
                          aria-label="Strikethrough"
                          aria-pressed={Boolean(selection.textStyle.strikethrough)}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            onToggleInlineStyle('strikethrough');
                            setActivePopover(null);
                          }}
                        >
                          <StrikethroughIcon />
                        </button>
                        <button
                          type="button"
                          className={`orb-fmt-btn ${selection.textStyle.code ? 'active' : ''}`}
                          title="Inline Code"
                          aria-label="Inline Code"
                          aria-pressed={Boolean(selection.textStyle.code)}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            onToggleInlineStyle('code');
                            setActivePopover(null);
                          }}
                        >
                          <CodeIcon />
                        </button>
                      </div>
                    )}
                    {overflowLevel >= 4 && renderFontSizeGroup(true)}
                    {overflowLevel >= 3 && renderAlignmentGroup(true)}
                    {overflowLevel >= 2 && renderListsGroup(true)}
                    {overflowLevel >= 1 && renderQuickInsertGroup(true)}
                    {overflowLevel >= 1 && renderClearGroup(true)}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Compact Table Grid Picker Popover */}
      {activePopover === 'table' && editMode && (
        <div className="orb-floating-bar orb-table-picker-bar" role="dialog" aria-label="Insert table">
          <div className="orb-table-picker-header">
            <span>
              Insert Table: <strong>{tableHover.rows} × {tableHover.cols}</strong>
            </span>
            <button
              type="button"
              className="orb-fmt-btn"
              aria-label="Close table picker"
              onClick={() => {
                setActivePopover(null);
                onRestoreFocus();
              }}
            >
              <XIcon size={13} />
            </button>
          </div>
          <div ref={tableGridRef} className="orb-table-grid" role="grid" aria-label="Table size grid">
            {Array.from({ length: 6 }, (_, r) => (
              <div key={r} role="row" className="orb-table-grid-row">
                {Array.from({ length: 6 }, (_, c) => {
                  const active = r < tableHover.rows && c < tableHover.cols;
                  return (
                    <button
                      key={`${r}-${c}`}
                      type="button"
                      role="gridcell"
                      tabIndex={r === tableHover.rows - 1 && c === tableHover.cols - 1 ? 0 : -1}
                      className={`orb-table-cell-pick ${active ? 'is-active' : ''}`}
                      aria-label={`Insert ${r + 1} by ${c + 1} table`}
                      onMouseEnter={() => setTableHover({ rows: r + 1, cols: c + 1 })}
                      onFocus={() => setTableHover({ rows: r + 1, cols: c + 1 })}
                      onKeyDown={(e) => handleTableGridKeyDown(e, r, c)}
                      onClick={() => {
                        onInsertTable(r + 1, c + 1);
                        setActivePopover(null);
                      }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Compact Insert Link Bar */}
      {linkOpen && editMode && (
        <form
          className="orb-floating-bar orb-inline-tool-bar"
          role="dialog"
          aria-label="Insert or edit link"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = linkUrlDraft.trim();
            if (!isSafeHref(trimmed)) {
              setLinkError('Enter a valid https://, http://, mailto:, or #anchor URL');
              return;
            }
            setLinkError(null);
            onApplyLink(trimmed, linkTextDraft || undefined);
            onLinkOpenChange(false);
            window.requestAnimationFrame(() => onRestoreFocus());
          }}
        >
          <span className="orb-tool-bar-label">Link</span>
          <input
            id="orb-link-url-input"
            type="text"
            className="orb-tool-input"
            placeholder="https://example.com, mailto:…, or #section"
            value={linkUrlDraft}
            autoFocus
            onChange={(e) => {
              setLinkUrlDraft(e.target.value);
              if (linkError) setLinkError(null);
            }}
          />
          <input
            id="orb-link-text-input"
            type="text"
            className="orb-tool-input"
            placeholder="Display text (optional)"
            value={linkTextDraft}
            onChange={(e) => setLinkTextDraft(e.target.value)}
          />
          <button type="submit" className="orb-btn primary">
            Apply
          </button>
          {selection.textStyle.href && (
            <button
              type="button"
              className="orb-btn"
              onClick={() => {
                onApplyLink(null);
                onLinkOpenChange(false);
                window.requestAnimationFrame(() => onRestoreFocus());
              }}
            >
              Remove
            </button>
          )}
          {linkError && (
            <span className="orb-tool-error" role="alert">
              {linkError}
            </span>
          )}
          <button
            type="button"
            className="orb-btn icon-only ghost"
            aria-label="Close link dialog"
            onClick={() => {
              onLinkOpenChange(false);
              onRestoreFocus();
            }}
          >
            <XIcon size={14} />
          </button>
        </form>
      )}

      {/* Compact Find & Replace Bar */}
      {findOpen && (
        <div
          className="orb-floating-bar orb-inline-tool-bar"
          role="search"
          aria-label="Find and replace"
        >
          <span className="orb-tool-bar-label">Find</span>
          <input
            ref={findInputRef}
            id="orb-find-input"
            type="text"
            className="orb-tool-input"
            placeholder="Find text…"
            value={findQuery}
            autoFocus
            onChange={(e) => onFindQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (findMatchCount > 0) {
                  onFindStep(e.shiftKey ? -1 : 1);
                }
              }
            }}
          />
          <span className="orb-find-count" aria-live="polite">
            {findQuery
              ? findMatchCount > 0
                ? `${safeFindIdx + 1} / ${findMatchCount}`
                : '0 matches'
              : ''}
          </span>
          <button
            id="orb-find-prev-btn"
            type="button"
            className="orb-btn icon-only ghost"
            disabled={findMatchCount === 0}
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
            onClick={() => onFindStep(-1)}
          >
            <ChevronLeftIcon size={14} />
          </button>
          <button
            id="orb-find-next-btn"
            type="button"
            className="orb-btn icon-only ghost"
            disabled={findMatchCount === 0}
            title="Next match (Enter)"
            aria-label="Next match"
            onClick={() => onFindStep(1)}
          >
            <ChevronRightIcon size={14} />
          </button>
          <button
            id="orb-find-case-btn"
            type="button"
            className={`orb-btn ${findCaseSensitive ? 'active' : ''}`}
            title="Match case"
            aria-pressed={findCaseSensitive}
            onClick={() => onFindCaseSensitiveChange(!findCaseSensitive)}
          >
            Aa
          </button>
          {editMode && (
            <>
              <input
                ref={replaceInputRef}
                id="orb-replace-input"
                type="text"
                className="orb-tool-input"
                placeholder="Replace with…"
                value={replaceDraft}
                onChange={(e) => setReplaceDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (findQuery && findMatchCount > 0 && !replaceBusy) {
                      onReplaceCurrent(findQuery, replaceDraft, findCaseSensitive);
                    }
                  }
                }}
              />
              <button
                id="orb-replace-one-btn"
                type="button"
                className="orb-btn"
                disabled={!findQuery || findMatchCount === 0 || replaceBusy}
                onClick={() => onReplaceCurrent(findQuery, replaceDraft, findCaseSensitive)}
              >
                Replace
              </button>
              <button
                id="orb-replace-all-btn"
                type="button"
                className="orb-btn primary"
                disabled={!findQuery || findMatchCount === 0 || replaceBusy}
                onClick={() => onReplaceAll(findQuery, replaceDraft, findCaseSensitive)}
              >
                Replace All
              </button>
            </>
          )}
          <button
            type="button"
            className="orb-btn icon-only ghost"
            aria-label="Close find and replace"
            onClick={() => {
              onFindOpenChange(false);
              onFindQueryChange('');
              onRestoreFocus();
            }}
          >
            <XIcon size={14} />
          </button>
        </div>
      )}

      {/* Compact Document Details & Word Count Bar */}
      {activePopover === 'details' && (
        <div
          className="orb-floating-bar orb-details-bar"
          role="dialog"
          aria-label="Document details and word count"
        >
          <div className="orb-details-metrics">
            <span>
              <strong>{ir.metadata.wordCount.toLocaleString()}</strong> words
            </span>
            <span>
              <strong>{ir.metadata.charCount.toLocaleString()}</strong> characters
            </span>
            <span>
              <strong>{ir.blocks.length}</strong> blocks
            </span>
            <span>
              <strong>{ir.outline.length}</strong> headings
            </span>
            <span>
              <strong>{ir.assets.length}</strong> media
            </span>
            <span className="orb-format-tag">{ir.sourceFormat}</span>
          </div>
          <button
            ref={detailsCloseBtnRef}
            type="button"
            className="orb-btn icon-only ghost"
            aria-label="Close document details"
            onClick={() => {
              setActivePopover(null);
              onRestoreFocus();
            }}
          >
            <XIcon size={14} />
          </button>
        </div>
      )}
    </div>
  );
};
