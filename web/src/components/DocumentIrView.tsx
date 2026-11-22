import React, { useMemo, useState } from 'react';
import type { Block, DocumentIr, EditOperation, InlineRun, MediaAsset } from '../types';
import { PlusIcon, TrashIcon } from './Icons';

interface DocumentIrViewProps {
  ir: DocumentIr;
  zoom: number;
  editable?: boolean;
  onApplyEdit?: (op: EditOperation) => void;
}

function runsToPlainText(runs: InlineRun[]): string {
  return runs.map((r) => r.text).join('');
}

function isSafeHref(href: string): boolean {
  const trimmed = href.trim().toLowerCase();
  return (
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('#')
  );
}

const InlineRunsView: React.FC<{ runs: InlineRun[] }> = ({ runs }) => (
  <>
    {runs.map((run, idx) => {
      const s = run.style;
      let node: React.ReactNode = run.text;

      if (s.code) {
        node = <code>{node}</code>;
      } else {
        if (s.bold) node = <strong>{node}</strong>;
        if (s.italic) node = <em>{node}</em>;
        if (s.underline) node = <u>{node}</u>;
        if (s.strikethrough) node = <del>{node}</del>;
        if (s.superscript) node = <sup>{node}</sup>;
        if (s.subscript) node = <sub>{node}</sub>;
        if (s.href && isSafeHref(s.href)) {
          node = (
            <a href={s.href} target="_blank" rel="noopener noreferrer">
              {node}
            </a>
          );
        }
      }

      const inlineStyle: React.CSSProperties | undefined = s.fontSizePt
        ? { fontSize: `${Math.min(Math.max(s.fontSizePt, 9), 36)}pt` }
        : undefined;

      return (
        <span key={idx} style={inlineStyle}>
          {node}
        </span>
      );
    })}
  </>
);

export const DocumentIrView: React.FC<DocumentIrViewProps> = ({
  ir,
  zoom,
  editable = false,
  onApplyEdit,
}) => {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');

  const assetMap = useMemo(() => {
    const m = new Map<string, MediaAsset>();
    for (const a of ir.assets) {
      m.set(a.id, a);
    }
    return m;
  }, [ir.assets]);

  const startEdit = (key: string, initial: string) => {
    if (!editable || !onApplyEdit) return;
    setEditingKey(key);
    setDraftText(initial);
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setDraftText('');
  };

  const commitBlockRuns = (blockId: string) => {
    if (!onApplyEdit) return;
    onApplyEdit({
      op: 'updateBlockRuns',
      blockId,
      runs: [{ text: draftText, style: {} }],
    });
    cancelEdit();
  };

  const commitCodeBlock = (blockId: string, language: string | null) => {
    if (!onApplyEdit) return;
    onApplyEdit({
      op: 'updateCodeBlock',
      blockId,
      language,
      code: draftText,
    });
    cancelEdit();
  };

  const commitListItem = (blockId: string, itemIndex: number, checked: boolean | null) => {
    if (!onApplyEdit) return;
    onApplyEdit({
      op: 'updateListItem',
      blockId,
      itemIndex,
      runs: [{ text: draftText, style: {} }],
      checked,
    });
    cancelEdit();
  };

  const commitTableCell = (blockId: string, row: number, col: number) => {
    if (!onApplyEdit) return;
    onApplyEdit({
      op: 'updateTableCell',
      blockId,
      row,
      col,
      text: draftText,
    });
    cancelEdit();
  };

  const insertBlock = (kind: 'paragraph' | 'heading') => {
    if (!onApplyEdit) return;
    const id = `user-${Date.now()}`;
    const lastId = ir.blocks.length > 0 ? ir.blocks[ir.blocks.length - 1].id : null;
    const newBlock: Block =
      kind === 'heading'
        ? {
            id,
            type: 'heading',
            level: 2,
            runs: [{ text: 'New Section Heading', style: {} }],
            align: 'left',
          }
        : {
            id,
            type: 'paragraph',
            runs: [{ text: 'New paragraph text. Click to edit.', style: {} }],
            align: 'left',
            indentLevel: 0,
          };
    onApplyEdit({
      op: 'insertBlockAfter',
      afterBlockId: lastId,
      block: newBlock,
    });
  };

  const renderBlock = (block: Block, allowDelete: boolean): React.ReactNode => {
    const deleteBtn =
      editable && allowDelete && onApplyEdit ? (
        <div className="orb-edit-actions">
          <button
            type="button"
            className="orb-btn icon-only ghost"
            title="Delete block"
            onClick={(e) => {
              e.stopPropagation();
              onApplyEdit({ op: 'deleteBlock', blockId: block.id });
            }}
          >
            <TrashIcon size={13} />
          </button>
        </div>
      ) : null;

    switch (block.type) {
      case 'heading': {
        const key = `block:${block.id}`;
        const Tag = `h${Math.min(Math.max(block.level, 1), 6)}` as
          | 'h1'
          | 'h2'
          | 'h3'
          | 'h4'
          | 'h5'
          | 'h6';
        if (editingKey === key) {
          return (
            <div key={block.id} id={block.id} className="orb-edit-block">
              <textarea
                className="orb-inline-textarea"
                value={draftText}
                autoFocus
                onChange={(e) => setDraftText(e.target.value)}
                onBlur={() => commitBlockRuns(block.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') cancelEdit();
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    commitBlockRuns(block.id);
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
            className={editable ? 'orb-edit-block' : undefined}
            onClick={() => startEdit(key, runsToPlainText(block.runs))}
          >
            {deleteBtn}
            <Tag style={{ textAlign: block.align }}>
              <InlineRunsView runs={block.runs} />
            </Tag>
          </div>
        );
      }

      case 'paragraph': {
        const key = `block:${block.id}`;
        if (editingKey === key) {
          return (
            <div key={block.id} id={block.id} className="orb-edit-block">
              <textarea
                className="orb-inline-textarea"
                value={draftText}
                autoFocus
                onChange={(e) => setDraftText(e.target.value)}
                onBlur={() => commitBlockRuns(block.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') cancelEdit();
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    commitBlockRuns(block.id);
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
            className={editable ? 'orb-edit-block' : undefined}
            onClick={() => startEdit(key, runsToPlainText(block.runs))}
          >
            {deleteBtn}
            <p
              style={{
                textAlign: block.align,
                paddingLeft: block.indentLevel ? `${block.indentLevel * 1.5}em` : undefined,
              }}
            >
              <InlineRunsView runs={block.runs} />
            </p>
          </div>
        );
      }

      case 'list': {
        const ListTag = block.ordered ? 'ol' : 'ul';
        return (
          <div
            key={block.id}
            id={block.id}
            className={editable ? 'orb-edit-block' : undefined}
          >
            {deleteBtn}
            <ListTag start={block.ordered ? block.start : undefined}>
              {block.items.map((item, idx) => {
                const key = `li:${block.id}:${idx}`;
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
                            onApplyEdit({
                              op: 'updateListItem',
                              blockId: block.id,
                              itemIndex: idx,
                              runs: item.runs,
                              checked: e.target.checked,
                            });
                          }
                        }}
                      />
                    )}
                    {editingKey === key ? (
                      <textarea
                        className="orb-inline-textarea"
                        value={draftText}
                        autoFocus
                        onChange={(e) => setDraftText(e.target.value)}
                        onBlur={() => commitListItem(block.id, idx, item.checked ?? null)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') cancelEdit();
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            commitListItem(block.id, idx, item.checked ?? null);
                          }
                        }}
                      />
                    ) : (
                      <span
                        onClick={() => startEdit(key, runsToPlainText(item.runs))}
                        style={editable ? { cursor: 'text' } : undefined}
                      >
                        <InlineRunsView runs={item.runs} />
                      </span>
                    )}
                    {item.children.map((child) => renderBlock(child, false))}
                  </li>
                );
              })}
            </ListTag>
          </div>
        );
      }

      case 'table':
        return (
          <div
            key={block.id}
            id={block.id}
            className={editable ? 'orb-edit-block' : undefined}
          >
            {deleteBtn}
            <table>
              <tbody>
                {block.rows.map((row, rIdx) => (
                  <tr key={rIdx}>
                    {row.cells.map((cell, cIdx) => {
                      const CellTag = row.header ? 'th' : 'td';
                      const key = `cell:${block.id}:${rIdx}:${cIdx}`;
                      const cellPlain = cell.blocks
                        .map((b) =>
                          b.type === 'paragraph' || b.type === 'heading'
                            ? runsToPlainText(b.runs)
                            : '',
                        )
                        .join('\n');

                      return (
                        <CellTag
                          key={cell.id}
                          colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                          rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                          style={{ textAlign: cell.align }}
                          onClick={() => startEdit(key, cellPlain)}
                        >
                          {editingKey === key ? (
                            <textarea
                              className="orb-inline-textarea"
                              value={draftText}
                              autoFocus
                              onChange={(e) => setDraftText(e.target.value)}
                              onBlur={() => commitTableCell(block.id, rIdx, cIdx)}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') cancelEdit();
                                if (e.key === 'Enter' && !e.shiftKey) {
                                  e.preventDefault();
                                  commitTableCell(block.id, rIdx, cIdx);
                                }
                              }}
                            />
                          ) : (
                            cell.blocks.map((cb) => renderBlock(cb, false))
                          )}
                        </CellTag>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );

      case 'blockQuote':
        return (
          <div
            key={block.id}
            id={block.id}
            className={editable ? 'orb-edit-block' : undefined}
          >
            {deleteBtn}
            <blockquote>{block.blocks.map((b) => renderBlock(b, false))}</blockquote>
          </div>
        );

      case 'codeBlock': {
        const key = `code:${block.id}`;
        if (editingKey === key) {
          return (
            <div key={block.id} id={block.id} className="orb-edit-block">
              <textarea
                className="orb-inline-textarea"
                style={{ fontFamily: 'var(--orb-font-mono)', minHeight: '110px' }}
                value={draftText}
                autoFocus
                onChange={(e) => setDraftText(e.target.value)}
                onBlur={() => commitCodeBlock(block.id, block.language ?? null)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') cancelEdit();
                }}
              />
            </div>
          );
        }
        return (
          <div
            key={block.id}
            id={block.id}
            className={editable ? 'orb-edit-block' : undefined}
            onClick={() => startEdit(key, block.code)}
          >
            {deleteBtn}
            <pre>
              <code>{block.code}</code>
            </pre>
          </div>
        );
      }

      case 'image': {
        const asset = assetMap.get(block.assetId);
        if (!asset) return null;
        return (
          <figure key={block.id} id={block.id} className="orb-image-figure">
            <img
              src={`data:${asset.mimeType};base64,${asset.dataBase64}`}
              alt={block.alt}
              width={block.widthPx ?? undefined}
              height={block.heightPx ?? undefined}
            />
            {block.caption && <figcaption>{block.caption}</figcaption>}
          </figure>
        );
      }

      case 'horizontalRule':
        return <hr key={block.id} id={block.id} />;

      case 'pageBreak':
        return (
          <div key={block.id} id={block.id} className="orb-page-break">
            Page Break
          </div>
        );

      case 'footnote':
        return (
          <aside key={block.id} id={block.id} className="orb-diag-card info">
            <span className="orb-diag-code">Footnote [{block.label}]</span>
            {block.blocks.map((b) => renderBlock(b, false))}
          </aside>
        );
    }
  };

  return (
    <div className="orb-doc-scroll">
      <article
        className="orb-sheet"
        style={{
          fontSize: `${Math.round(15.5 * zoom * 10) / 10}px`,
        }}
      >
        {ir.blocks.length === 0 ? (
          <p className="orb-empty-note">Empty document.</p>
        ) : (
          ir.blocks.map((block) => renderBlock(block, true))
        )}

        {editable && onApplyEdit && (
          <div className="orb-add-block-bar">
            <button
              id="orb-add-paragraph-btn"
              type="button"
              className="orb-btn"
              onClick={() => insertBlock('paragraph')}
            >
              <PlusIcon />
              Add Paragraph
            </button>
            <button
              id="orb-add-heading-btn"
              type="button"
              className="orb-btn"
              onClick={() => insertBlock('heading')}
            >
              <PlusIcon />
              Add Heading
            </button>
          </div>
        )}
      </article>
    </div>
  );
};
