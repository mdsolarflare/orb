import React, { useRef } from 'react';
import type { DocumentIr } from '../types';
import { DocumentIrView } from './DocumentIrView';
import type { MarkdownViewMode } from './Toolbar';

interface MarkdownWorkspaceProps {
  markdown: string;
  ir: DocumentIr;
  mode: MarkdownViewMode;
  zoom: number;
  onChangeMarkdown: (next: string) => void;
}

export const MarkdownWorkspace: React.FC<MarkdownWorkspaceProps> = ({
  markdown,
  ir,
  mode,
  zoom,
  onChangeMarkdown,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const insertSnippet = (before: string, after = '', placeholder = '') => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = markdown.slice(start, end) || placeholder;
    const next =
      markdown.slice(0, start) + before + selected + after + markdown.slice(end);
    onChangeMarkdown(next);
    window.requestAnimationFrame(() => {
      el.focus();
      const cursorStart = start + before.length;
      el.setSelectionRange(cursorStart, cursorStart + selected.length);
    });
  };

  return (
    <div className="orb-md-workspace">
      {(mode === 'source' || mode === 'split') && (
        <section className="orb-md-editor-pane" aria-label="Markdown source editor">
          <div className="orb-md-toolbar">
            <button
              type="button"
              className="orb-btn ghost"
              onClick={() => insertSnippet('\n## ', '\n', 'Heading')}
            >
              H2
            </button>
            <button
              type="button"
              className="orb-btn ghost"
              onClick={() => insertSnippet('**', '**', 'bold')}
            >
              Bold
            </button>
            <button
              type="button"
              className="orb-btn ghost"
              onClick={() => insertSnippet('*', '*', 'italic')}
            >
              Italic
            </button>
            <button
              type="button"
              className="orb-btn ghost"
              onClick={() => insertSnippet('`', '`', 'code')}
            >
              Code
            </button>
            <button
              type="button"
              className="orb-btn ghost"
              onClick={() => insertSnippet('\n- [ ] ', '\n', 'Task item')}
            >
              Task
            </button>
            <button
              type="button"
              className="orb-btn ghost"
              onClick={() =>
                insertSnippet(
                  '\n| Column A | Column B |\n| --- | --- |\n| Value 1 | Value 2 |\n',
                )
              }
            >
              Table
            </button>
          </div>
          <textarea
            ref={textareaRef}
            id="orb-markdown-source"
            className="orb-md-textarea"
            spellCheck={false}
            value={markdown}
            onChange={(e) => onChangeMarkdown(e.target.value)}
            aria-label="Markdown source"
          />
        </section>
      )}

      {(mode === 'reading' || mode === 'split') && (
        <section className="orb-md-preview-pane" aria-label="Markdown preview">
          <DocumentIrView ir={ir} zoom={zoom} />
        </section>
      )}
    </div>
  );
};
