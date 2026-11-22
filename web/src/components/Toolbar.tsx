import React from 'react';
import { useTheme } from '../theme/ThemeProvider';
import type { ThemeMode } from '../theme/themes';
import type { DocumentFormat, OpenedDocument } from '../types';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  EditIcon,
  MonitorIcon,
  MoonIcon,
  OrbLogoIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SidebarLeftIcon,
  SidebarRightIcon,
  SunIcon,
  UploadIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from './Icons';

export type MarkdownViewMode = 'reading' | 'split' | 'source';

interface ToolbarProps {
  filename: string | null;
  document: OpenedDocument | null;
  dirty: boolean;
  zoom: number;
  onZoomChange: (next: number) => void;
  currentPage: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  mdMode: MarkdownViewMode;
  onMdModeChange: (mode: MarkdownViewMode) => void;
  wordEditMode: boolean;
  onWordEditModeChange: (editing: boolean) => void;
  showOutline: boolean;
  onToggleOutline: () => void;
  showInspector: boolean;
  onToggleInspector: () => void;
  onOpenFileClick: () => void;
  onGoHome: () => void;
  onExportPdf?: () => void;
  onExportMarkdown?: () => void;
  onExportDocx?: () => void;
  exportBusy?: boolean;
}

function formatBadgeLabel(doc: OpenedDocument | null): DocumentFormat | null {
  if (!doc) return null;
  if (doc.kind === 'pdf') return 'pdf';
  if (doc.kind === 'markdown') return 'markdown';
  return doc.wordFormat;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  filename,
  document: doc,
  dirty,
  zoom,
  onZoomChange,
  currentPage,
  pageCount,
  onPageChange,
  mdMode,
  onMdModeChange,
  wordEditMode,
  onWordEditModeChange,
  showOutline,
  onToggleOutline,
  showInspector,
  onToggleInspector,
  onOpenFileClick,
  onGoHome,
  onExportPdf,
  onExportMarkdown,
  onExportDocx,
  exportBusy,
}) => {
  const { mode, setMode } = useTheme();
  const format = formatBadgeLabel(doc);

  const sigSummary =
    doc?.kind === 'pdf' && doc.inspection.signatures.length > 0
      ? {
          count: doc.inspection.signatures.length,
          allValid: doc.inspection.signatures.every((s) => s.integrity === 'valid'),
        }
      : null;

  const themes: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
    { value: 'system', label: 'System theme', icon: <MonitorIcon /> },
    { value: 'light', label: 'Light theme', icon: <SunIcon /> },
    { value: 'dark', label: 'Dark theme', icon: <MoonIcon /> },
  ];

  return (
    <header className="orb-toolbar">
      <div className="orb-toolbar-group">
        <button
          id="orb-home-btn"
          type="button"
          className="orb-brand"
          onClick={onGoHome}
          title="Orb Home"
        >
          <OrbLogoIcon size={19} />
          <span>orb</span>
        </button>

        <button
          id="orb-open-file-btn"
          type="button"
          className="orb-btn"
          onClick={onOpenFileClick}
        >
          <UploadIcon size={14} />
          <span>Open</span>
        </button>

        {doc && (
          <>
            <span className="orb-divider" />
            <button
              id="orb-toggle-outline-btn"
              type="button"
              className={`orb-btn icon-only ghost ${showOutline ? 'active' : ''}`}
              onClick={onToggleOutline}
              title="Toggle outline & metadata"
              aria-label="Toggle outline"
            >
              <SidebarLeftIcon />
            </button>
            <div className="orb-doc-title" title={filename ?? ''}>
              <span className="orb-doc-name">{filename ?? 'Untitled'}</span>
              {dirty && <span className="orb-dirty-dot" title="Unsaved edits" />}
              {format && <span className="orb-format-tag">{format}</span>}
            </div>
          </>
        )}
      </div>

      <div className="orb-toolbar-group center">
        {doc?.kind === 'markdown' && (
          <div className="orb-segmented" role="group" aria-label="Markdown view mode">
            {(['reading', 'split', 'source'] as MarkdownViewMode[]).map((m) => (
              <button
                key={m}
                id={`orb-md-mode-${m}`}
                type="button"
                className={mdMode === m ? 'is-selected' : ''}
                onClick={() => onMdModeChange(m)}
              >
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
        )}

        {doc?.kind === 'word' && (
          <div className="orb-segmented" role="group" aria-label="Document mode">
            <button
              id="orb-word-mode-view"
              type="button"
              className={!wordEditMode ? 'is-selected' : ''}
              onClick={() => onWordEditModeChange(false)}
            >
              Read
            </button>
            <button
              id="orb-word-mode-edit"
              type="button"
              className={wordEditMode ? 'is-selected' : ''}
              onClick={() => onWordEditModeChange(true)}
            >
              <EditIcon size={12} />
              Edit
            </button>
          </div>
        )}

        {doc?.kind === 'pdf' && pageCount > 0 && (
          <>
            <button
              id="orb-page-prev"
              type="button"
              className="orb-btn icon-only ghost"
              disabled={currentPage <= 0}
              onClick={() => onPageChange(Math.max(0, currentPage - 1))}
              title="Previous page"
              aria-label="Previous page"
            >
              <ChevronLeftIcon />
            </button>
            <span className="orb-counter">
              {currentPage + 1} / {pageCount}
            </span>
            <button
              id="orb-page-next"
              type="button"
              className="orb-btn icon-only ghost"
              disabled={currentPage >= pageCount - 1}
              onClick={() => onPageChange(Math.min(pageCount - 1, currentPage + 1))}
              title="Next page"
              aria-label="Next page"
            >
              <ChevronRightIcon />
            </button>
            <span className="orb-divider" />
          </>
        )}

        {doc && (
          <>
            <button
              id="orb-zoom-out"
              type="button"
              className="orb-btn icon-only ghost"
              disabled={zoom <= 0.5}
              onClick={() => onZoomChange(Math.max(0.5, Math.round((zoom - 0.15) * 100) / 100))}
              title="Zoom out"
              aria-label="Zoom out"
            >
              <ZoomOutIcon />
            </button>
            <button
              id="orb-zoom-reset"
              type="button"
              className="orb-btn ghost"
              onClick={() => onZoomChange(1)}
              title="Reset zoom to 100%"
            >
              <span className="orb-counter">{Math.round(zoom * 100)}%</span>
            </button>
            <button
              id="orb-zoom-in"
              type="button"
              className="orb-btn icon-only ghost"
              disabled={zoom >= 2.5}
              onClick={() => onZoomChange(Math.min(2.5, Math.round((zoom + 0.15) * 100) / 100))}
              title="Zoom in"
              aria-label="Zoom in"
            >
              <ZoomInIcon />
            </button>
          </>
        )}
      </div>

      <div className="orb-toolbar-group right">
        {doc?.kind === 'pdf' && doc.inspection.hasForms && onExportPdf && (
          <button
            id="orb-export-pdf-btn"
            type="button"
            className={`orb-btn ${dirty ? 'primary' : ''}`}
            disabled={exportBusy}
            onClick={onExportPdf}
            title="Export PDF with form field edits appended as an incremental update"
          >
            <DownloadIcon />
            <span>{dirty ? 'Save Filled PDF' : 'Export PDF'}</span>
          </button>
        )}

        {(doc?.kind === 'markdown' || doc?.kind === 'word') && (
          <>
            {onExportMarkdown && (
              <button
                id="orb-export-md-btn"
                type="button"
                className="orb-btn"
                disabled={exportBusy}
                onClick={onExportMarkdown}
                title="Download as Markdown (.md)"
              >
                <DownloadIcon />
                <span>.md</span>
              </button>
            )}
            {onExportDocx && (
              <button
                id="orb-export-docx-btn"
                type="button"
                className={`orb-btn ${dirty ? 'primary' : ''}`}
                disabled={exportBusy}
                onClick={onExportDocx}
                title="Export clean OOXML Word document (.docx)"
              >
                <DownloadIcon />
                <span>.docx</span>
              </button>
            )}
          </>
        )}

        {doc && (
          <button
            id="orb-toggle-inspector-btn"
            type="button"
            className={`orb-btn ${showInspector ? 'active' : 'ghost'}`}
            onClick={onToggleInspector}
            title="Toggle inspector panel"
          >
            {sigSummary ? (
              sigSummary.allValid ? (
                <ShieldCheckIcon size={15} />
              ) : (
                <ShieldAlertIcon size={15} />
              )
            ) : (
              <SidebarRightIcon size={15} />
            )}
            {sigSummary && <span>{sigSummary.count}</span>}
          </button>
        )}

        <span className="orb-divider" />

        <div className="orb-segmented" role="group" aria-label="Color theme">
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
  );
};
