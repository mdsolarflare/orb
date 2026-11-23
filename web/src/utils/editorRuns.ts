import type { InlineRun, TextStyle } from '../types';

export type InlineStyleFlag =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strikethrough'
  | 'code'
  | 'superscript'
  | 'subscript';

export const FONT_SIZE_MIN_PT = 6;
export const FONT_SIZE_MAX_PT = 144;

export interface LinkSpanAtOffset {
  start: number;
  end: number;
  text: string;
  href: string;
}

export function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('https://') || lower.startsWith('http://')) {
    try {
      const parsed = new URL(trimmed);
      return (
        (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        parsed.hostname.length > 0
      );
    } catch {
      return false;
    }
  }
  if (lower.startsWith('mailto:')) {
    const rest = trimmed.slice('mailto:'.length);
    return rest.length > 0 && !/\s/.test(rest);
  }
  if (trimmed.startsWith('#')) {
    return /^#[^\s]+$/.test(trimmed);
  }
  return false;
}

export function runsToPlainText(runs: InlineRun[]): string {
  return runs.map((r) => r.text).join('');
}

export function stylesEqual(a: TextStyle, b: TextStyle): boolean {
  return (
    Boolean(a.bold) === Boolean(b.bold) &&
    Boolean(a.italic) === Boolean(b.italic) &&
    Boolean(a.underline) === Boolean(b.underline) &&
    Boolean(a.strikethrough) === Boolean(b.strikethrough) &&
    Boolean(a.code) === Boolean(b.code) &&
    Boolean(a.superscript) === Boolean(b.superscript) &&
    Boolean(a.subscript) === Boolean(b.subscript) &&
    (a.href ?? null) === (b.href ?? null) &&
    (a.fontSizePt ?? null) === (b.fontSizePt ?? null)
  );
}

export function normalizeStyle(style: TextStyle): TextStyle {
  const out: TextStyle = {};
  if (style.bold) out.bold = true;
  if (style.italic) out.italic = true;
  if (style.underline) out.underline = true;
  if (style.strikethrough) out.strikethrough = true;
  if (style.code) out.code = true;
  if (style.superscript) out.superscript = true;
  if (style.subscript && !style.superscript) out.subscript = true;
  if (style.href && isSafeHref(style.href)) out.href = style.href.trim();
  if (typeof style.fontSizePt === 'number' && Number.isFinite(style.fontSizePt)) {
    out.fontSizePt = Math.min(
      Math.max(Math.round(style.fontSizePt * 10) / 10, FONT_SIZE_MIN_PT),
      FONT_SIZE_MAX_PT,
    );
  }
  return out;
}

export function toggleStyleFlag(style: TextStyle, flag: InlineStyleFlag): TextStyle {
  const nextVal = !Boolean(style[flag]);
  const next: TextStyle = { ...style, [flag]: nextVal };
  if (flag === 'superscript' && nextVal) next.subscript = false;
  if (flag === 'subscript' && nextVal) next.superscript = false;
  return normalizeStyle(next);
}

export function mergeRuns(runs: InlineRun[]): InlineRun[] {
  const merged: InlineRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const style = normalizeStyle(run.style);
    const prev = merged[merged.length - 1];
    if (prev && stylesEqual(prev.style, style)) {
      prev.text += run.text;
    } else {
      merged.push({ text: run.text, style });
    }
  }
  return merged;
}

export function runsEqual(a: InlineRun[], b: InlineRun[]): boolean {
  const na = mergeRuns(a);
  const nb = mergeRuns(b);
  if (na.length !== nb.length) return false;
  for (let i = 0; i < na.length; i++) {
    if (na[i].text !== nb[i].text || !stylesEqual(na[i].style, nb[i].style)) {
      return false;
    }
  }
  return true;
}

interface SlicedRun {
  text: string;
  style: TextStyle;
  selected: boolean;
}

function sliceRunsForRange(runs: InlineRun[], start: number, end: number): SlicedRun[] {
  const totalLen = runsToPlainText(runs).length;
  const clampedStart = Math.max(0, Math.min(start, totalLen));
  const clampedEnd = Math.max(clampedStart, Math.min(end, totalLen));

  const pieces: SlicedRun[] = [];
  let cursor = 0;

  for (const run of runs) {
    const runStart = cursor;
    const runEnd = cursor + run.text.length;
    cursor = runEnd;

    if (clampedStart === clampedEnd || runEnd <= clampedStart || runStart >= clampedEnd) {
      pieces.push({ text: run.text, style: { ...run.style }, selected: false });
      continue;
    }

    if (runStart < clampedStart) {
      pieces.push({
        text: run.text.slice(0, clampedStart - runStart),
        style: { ...run.style },
        selected: false,
      });
    }

    const innerStart = Math.max(0, clampedStart - runStart);
    const innerEnd = Math.min(run.text.length, clampedEnd - runStart);
    if (innerEnd > innerStart) {
      pieces.push({
        text: run.text.slice(innerStart, innerEnd),
        style: { ...run.style },
        selected: true,
      });
    }

    if (runEnd > clampedEnd) {
      pieces.push({
        text: run.text.slice(clampedEnd - runStart),
        style: { ...run.style },
        selected: false,
      });
    }
  }

  return pieces;
}

export function getLinkRunAtOffset(runs: InlineRun[], offset: number): LinkSpanAtOffset | null {
  const totalLen = runsToPlainText(runs).length;
  if (totalLen === 0) return null;

  const clamped = Math.max(0, Math.min(offset, totalLen));
  const spans: { start: number; end: number; run: InlineRun }[] = [];
  let cursor = 0;
  for (const run of runs) {
    if (!run.text) continue;
    const start = cursor;
    const end = cursor + run.text.length;
    spans.push({ start, end, run });
    cursor = end;
  }
  if (spans.length === 0) return null;

  let matchIdx = spans.findIndex((sp) => clamped <= sp.end);
  if (matchIdx === -1) matchIdx = spans.length - 1;

  const matchedHref = spans[matchIdx].run.style.href?.trim();
  if (!matchedHref) return null;

  let firstIdx = matchIdx;
  while (firstIdx > 0 && spans[firstIdx - 1].run.style.href?.trim() === matchedHref) {
    firstIdx -= 1;
  }
  let lastIdx = matchIdx;
  while (lastIdx + 1 < spans.length && spans[lastIdx + 1].run.style.href?.trim() === matchedHref) {
    lastIdx += 1;
  }

  const start = spans[firstIdx].start;
  const end = spans[lastIdx].end;
  const text = spans
    .slice(firstIdx, lastIdx + 1)
    .map((sp) => sp.run.text)
    .join('');
  return { start, end, text, href: matchedHref };
}

export function getStyleAtRange(runs: InlineRun[], start: number, end: number): TextStyle {
  const totalLen = runsToPlainText(runs).length;
  if (totalLen === 0) return {};

  if (start === end) {
    const offset = Math.max(0, Math.min(start, totalLen));
    let cursor = 0;
    for (const run of runs) {
      const next = cursor + run.text.length;
      if (offset <= next && run.text.length > 0) {
        return normalizeStyle(run.style);
      }
      cursor = next;
    }
    return normalizeStyle(runs[runs.length - 1]?.style ?? {});
  }

  const slices = sliceRunsForRange(runs, start, end).filter((p) => p.selected && p.text.length > 0);
  if (slices.length === 0) return {};

  const flags: InlineStyleFlag[] = [
    'bold',
    'italic',
    'underline',
    'strikethrough',
    'code',
    'superscript',
    'subscript',
  ];
  const result: TextStyle = {};
  for (const flag of flags) {
    if (slices.every((s) => Boolean(s.style[flag]))) {
      result[flag] = true;
    }
  }

  const firstSize = slices[0].style.fontSizePt ?? null;
  if (firstSize !== null && slices.every((s) => (s.style.fontSizePt ?? null) === firstSize)) {
    result.fontSizePt = firstSize;
  }

  const firstHref = slices[0].style.href ?? null;
  if (firstHref !== null && slices.every((s) => (s.style.href ?? null) === firstHref)) {
    result.href = firstHref;
  }

  return result;
}

export function toggleStyleInRange(
  runs: InlineRun[],
  start: number,
  end: number,
  flag: InlineStyleFlag,
): InlineRun[] {
  if (end <= start) return runs;
  const slices = sliceRunsForRange(runs, start, end);
  const selected = slices.filter((s) => s.selected && s.text.length > 0);
  if (selected.length === 0) return runs;

  const allSet = selected.every((s) => Boolean(s.style[flag]));
  const nextVal = !allSet;

  return mergeRuns(
    slices.map((s) => {
      if (!s.selected) return { text: s.text, style: s.style };
      const style: TextStyle = { ...s.style, [flag]: nextVal };
      if (flag === 'superscript' && nextVal) style.subscript = false;
      if (flag === 'subscript' && nextVal) style.superscript = false;
      return { text: s.text, style };
    }),
  );
}

export function setFontSizeInRange(
  runs: InlineRun[],
  start: number,
  end: number,
  fontSizePt: number | null,
): InlineRun[] {
  if (end <= start) return runs;
  const slices = sliceRunsForRange(runs, start, end);
  return mergeRuns(
    slices.map((s) =>
      s.selected
        ? { text: s.text, style: { ...s.style, fontSizePt } }
        : { text: s.text, style: s.style },
    ),
  );
}

export function insertStyledTextAtRange(
  runs: InlineRun[],
  start: number,
  end: number,
  text: string,
  style: TextStyle,
): InlineRun[] {
  const totalLen = runsToPlainText(runs).length;
  const s = Math.max(0, Math.min(start, totalLen));
  const e = Math.max(s, Math.min(end, totalLen));
  const [before] = splitRunsAtOffset(runs, s);
  const [, after] = splitRunsAtOffset(runs, e);
  if (!text) return mergeRuns([...before, ...after]);
  return mergeRuns([...before, { text, style: normalizeStyle(style) }, ...after]);
}

export function setLinkInRange(
  runs: InlineRun[],
  start: number,
  end: number,
  href: string | null,
  labelText?: string,
): InlineRun[] {
  const plain = runsToPlainText(runs);
  const totalLen = plain.length;
  const s = Math.max(0, Math.min(start, totalLen));
  const e = Math.max(s, Math.min(end, totalLen));
  const trimmedHref = href?.trim() ?? '';

  // Removing an existing link (href is null or empty)
  if (href === null || trimmedHref === '') {
    if (s === e) {
      const existing = getLinkRunAtOffset(runs, s);
      if (!existing) return runs;
      const slices = sliceRunsForRange(runs, existing.start, existing.end);
      return mergeRuns(
        slices.map((sl) =>
          sl.selected
            ? { text: sl.text, style: { ...sl.style, href: null } }
            : { text: sl.text, style: sl.style },
        ),
      );
    }
    const slices = sliceRunsForRange(runs, s, e);
    return mergeRuns(
      slices.map((sl) =>
        sl.selected
          ? { text: sl.text, style: { ...sl.style, href: null } }
          : { text: sl.text, style: sl.style },
      ),
    );
  }

  // Reject unsafe URLs without mutating existing runs
  if (!isSafeHref(trimmedHref)) {
    return runs;
  }

  const trimmedLabel = labelText?.trim() ?? '';

  if (totalLen === 0 || s === e) {
    const existing = s === e ? getLinkRunAtOffset(runs, s) : null;
    if (existing) {
      if (trimmedLabel && trimmedLabel !== existing.text.trim()) {
        const baseStyle = getStyleAtRange(runs, existing.start, existing.end);
        return insertStyledTextAtRange(runs, existing.start, existing.end, trimmedLabel, {
          ...baseStyle,
          href: trimmedHref,
        });
      }
      const slices = sliceRunsForRange(runs, existing.start, existing.end);
      return mergeRuns(
        slices.map((sl) =>
          sl.selected
            ? { text: sl.text, style: { ...sl.style, href: trimmedHref } }
            : { text: sl.text, style: sl.style },
        ),
      );
    }

    const textToInsert = trimmedLabel || trimmedHref;
    const inherited = getStyleAtRange(runs, s, s);
    return insertStyledTextAtRange(runs, s, e, textToInsert, { ...inherited, href: trimmedHref });
  }

  const selectedText = plain.slice(s, e);
  if (trimmedLabel && trimmedLabel !== selectedText.trim()) {
    const baseStyle = getStyleAtRange(runs, s, e);
    return insertStyledTextAtRange(runs, s, e, trimmedLabel, { ...baseStyle, href: trimmedHref });
  }

  const slices = sliceRunsForRange(runs, s, e);
  return mergeRuns(
    slices.map((sl) =>
      sl.selected
        ? { text: sl.text, style: { ...sl.style, href: trimmedHref } }
        : { text: sl.text, style: sl.style },
    ),
  );
}

export function clearStyleInRange(runs: InlineRun[], start: number, end: number): InlineRun[] {
  if (end <= start) return runs;
  const slices = sliceRunsForRange(runs, start, end);
  return mergeRuns(
    slices.map((s) => (s.selected ? { text: s.text, style: {} } : { text: s.text, style: s.style })),
  );
}

export function splitRunsAtOffset(
  runs: InlineRun[],
  offset: number,
): [InlineRun[], InlineRun[]] {
  const totalLen = runsToPlainText(runs).length;
  const splitAt = Math.max(0, Math.min(offset, totalLen));
  const before: InlineRun[] = [];
  const after: InlineRun[] = [];
  let cursor = 0;

  for (const run of runs) {
    const runStart = cursor;
    const runEnd = cursor + run.text.length;
    cursor = runEnd;

    if (runEnd <= splitAt) {
      before.push({ text: run.text, style: { ...run.style } });
    } else if (runStart >= splitAt) {
      after.push({ text: run.text, style: { ...run.style } });
    } else {
      const cut = splitAt - runStart;
      if (cut > 0) {
        before.push({ text: run.text.slice(0, cut), style: { ...run.style } });
      }
      if (cut < run.text.length) {
        after.push({ text: run.text.slice(cut), style: { ...run.style } });
      }
    }
  }

  return [mergeRuns(before), mergeRuns(after)];
}

export function countTextOccurrences(
  haystack: string,
  needle: string,
  caseSensitive: boolean,
): number {
  if (!needle) return 0;
  const h = caseSensitive ? haystack : haystack.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();
  let count = 0;
  let pos = 0;
  while (pos <= h.length - n.length) {
    const idx = h.indexOf(n, pos);
    if (idx === -1) break;
    count += 1;
    pos = idx + Math.max(1, n.length);
  }
  return count;
}

export function replaceNthOccurrenceInRuns(
  runs: InlineRun[],
  needle: string,
  replacement: string,
  caseSensitive: boolean,
  targetIndex: number,
): { runs: InlineRun[]; replaced: boolean } {
  if (!needle || targetIndex < 0) return { runs, replaced: false };
  const plain = runsToPlainText(runs);
  const h = caseSensitive ? plain : plain.toLowerCase();
  const n = caseSensitive ? needle : needle.toLowerCase();

  let foundIdx = -1;
  let occ = 0;
  let pos = 0;
  while (pos <= h.length - n.length) {
    const idx = h.indexOf(n, pos);
    if (idx === -1) break;
    if (occ === targetIndex) {
      foundIdx = idx;
      break;
    }
    occ += 1;
    pos = idx + Math.max(1, n.length);
  }

  if (foundIdx === -1) return { runs, replaced: false };
  // Use forward affinity at the start of the matched span (consistent with Rust replace_in_runs)
  const style = getStyleAtRange(runs, foundIdx, Math.min(plain.length, foundIdx + 1));
  const next = insertStyledTextAtRange(runs, foundIdx, foundIdx + needle.length, replacement, style);
  return { runs: next, replaced: true };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function runsToSafeHtml(runs: InlineRun[]): string {
  const merged = mergeRuns(runs);
  const plain = runsToPlainText(merged);
  const body = merged
    .map((run) => {
      const s = run.style;
      let html = escapeHtml(run.text).replace(/\n/g, '<br>');
      if (s.code) html = `<code>${html}</code>`;
      if (s.bold) html = `<strong>${html}</strong>`;
      if (s.italic) html = `<em>${html}</em>`;
      if (s.underline) html = `<u>${html}</u>`;
      if (s.strikethrough) html = `<del>${html}</del>`;
      if (s.superscript) html = `<sup>${html}</sup>`;
      if (s.subscript) html = `<sub>${html}</sub>`;
      if (s.href && isSafeHref(s.href)) {
        const externalAttrs = s.href.startsWith('#')
          ? ''
          : ' target="_blank" rel="noopener noreferrer"';
        html = `<a href="${escapeHtml(s.href)}"${externalAttrs}>${html}</a>`;
      }
      if (typeof s.fontSizePt === 'number' && Number.isFinite(s.fontSizePt)) {
        const clamped = Math.min(Math.max(s.fontSizePt, FONT_SIZE_MIN_PT), FONT_SIZE_MAX_PT);
        html = `<span data-font-size-pt="${clamped}" style="font-size:${clamped}pt">${html}</span>`;
      }
      return html;
    })
    .join('');

  // Append a sentinel <br> if content ends with a newline so contentEditable displays the trailing empty line
  if (plain.endsWith('\n')) {
    return `${body}<br data-orb-sentinel="1">`;
  }
  return body;
}

function hasFollowingNodeInRoot(node: Node, root: HTMLElement): boolean {
  let cur: Node | null = node;
  while (cur && cur !== root) {
    if (cur.nextSibling) return true;
    cur = cur.parentNode;
  }
  return false;
}

function isCountedBr(el: HTMLElement, root: HTMLElement): boolean {
  if (el.tagName.toUpperCase() !== 'BR') return false;
  if (el.hasAttribute('data-orb-sentinel')) return false;
  return hasFollowingNodeInRoot(el, root);
}

export function domToRuns(root: HTMLElement): InlineRun[] {
  const acc: InlineRun[] = [];

  const walk = (node: Node, inherited: TextStyle) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      if (text.length > 0) {
        acc.push({ text, style: { ...inherited } });
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as HTMLElement;
    const tag = el.tagName.toUpperCase();
    if (tag === 'BR') {
      if (isCountedBr(el, root)) {
        acc.push({ text: '\n', style: { ...inherited } });
      }
      return;
    }

    const nextStyle: TextStyle = { ...inherited };
    if (tag === 'STRONG' || tag === 'B') nextStyle.bold = true;
    if (tag === 'EM' || tag === 'I') nextStyle.italic = true;
    if (tag === 'U') nextStyle.underline = true;
    if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') nextStyle.strikethrough = true;
    if (tag === 'CODE') nextStyle.code = true;
    if (tag === 'SUP') {
      nextStyle.superscript = true;
      nextStyle.subscript = false;
    }
    if (tag === 'SUB') {
      nextStyle.subscript = true;
      nextStyle.superscript = false;
    }
    if (tag === 'A') {
      const href = el.getAttribute('href');
      if (href && isSafeHref(href)) {
        nextStyle.href = href;
      }
    }

    const dataPt = el.getAttribute('data-font-size-pt');
    if (dataPt) {
      const parsed = Number.parseFloat(dataPt);
      if (Number.isFinite(parsed)) {
        nextStyle.fontSizePt = parsed;
      }
    } else if (el.style.fontSize && el.style.fontSize.endsWith('pt')) {
      const parsed = Number.parseFloat(el.style.fontSize);
      if (Number.isFinite(parsed)) {
        nextStyle.fontSizePt = parsed;
      }
    }

    const isBlockChild = (tag === 'DIV' || tag === 'P') && el !== root;
    if (isBlockChild && acc.length > 0) {
      acc.push({ text: '\n', style: { ...inherited } });
    }

    for (const child of Array.from(el.childNodes)) {
      walk(child, nextStyle);
    }
  };

  for (const child of Array.from(root.childNodes)) {
    walk(child, {});
  }

  return mergeRuns(acc);
}

function measureOffsetInRoot(root: HTMLElement, targetNode: Node, targetOffset: number): number {
  let count = 0;
  let found = false;

  const walk = (node: Node) => {
    if (found) return;

    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent?.length ?? 0;
      if (node === targetNode) {
        count += Math.max(0, Math.min(targetOffset, len));
        found = true;
      } else {
        count += len;
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as HTMLElement;
    const tag = el.tagName.toUpperCase();

    if (tag === 'BR') {
      if (node === targetNode) {
        found = true;
        return;
      }
      if (isCountedBr(el, root)) {
        count += 1;
      }
      return;
    }

    const isBlockChild = (tag === 'DIV' || tag === 'P') && el !== root;
    if (isBlockChild && count > 0) {
      count += 1;
    }

    const children = Array.from(el.childNodes);
    if (node === targetNode) {
      const limit = Math.max(0, Math.min(targetOffset, children.length));
      for (let i = 0; i < limit; i++) {
        walk(children[i]);
        if (found) return;
      }
      found = true;
      return;
    }

    for (const child of children) {
      walk(child);
      if (found) return;
    }
  };

  walk(root);
  return count;
}

export function getSelectionOffsetsInElement(
  root: HTMLElement,
): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }

  const start = measureOffsetInRoot(root, range.startContainer, range.startOffset);
  const end = measureOffsetInRoot(root, range.endContainer, range.endOffset);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function childIndex(node: Node): number {
  let idx = 0;
  let cur = node.previousSibling;
  while (cur) {
    idx += 1;
    cur = cur.previousSibling;
  }
  return idx;
}

export function setSelectionOffsetsInElement(
  root: HTMLElement,
  start: number,
  end: number,
): void {
  const sel = window.getSelection();
  if (!sel) return;

  const findPoint = (target: number): { node: Node; offset: number } => {
    const clampedTarget = Math.max(0, target);
    let cursor = 0;
    let resolved: { node: Node; offset: number } | null = null;
    let lastPoint: { node: Node; offset: number } = { node: root, offset: root.childNodes.length };

    const walk = (node: Node) => {
      if (resolved) return;

      if (node.nodeType === Node.TEXT_NODE) {
        const len = node.textContent?.length ?? 0;
        lastPoint = { node, offset: len };
        if (clampedTarget <= cursor + len) {
          resolved = { node, offset: clampedTarget - cursor };
          return;
        }
        cursor += len;
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const el = node as HTMLElement;
      const tag = el.tagName.toUpperCase();
      if (tag === 'BR') {
        if (isCountedBr(el, root)) {
          const parent = el.parentNode ?? root;
          const idx = childIndex(el);
          if (clampedTarget === cursor) {
            resolved = { node: parent, offset: idx };
            return;
          }
          cursor += 1;
          lastPoint = { node: parent, offset: idx + 1 };
        }
        return;
      }

      const isBlockChild = (tag === 'DIV' || tag === 'P') && el !== root;
      if (isBlockChild && cursor > 0) {
        if (clampedTarget === cursor) {
          resolved = { node: el, offset: 0 };
          return;
        }
        cursor += 1;
      }

      for (const child of Array.from(el.childNodes)) {
        walk(child);
        if (resolved) return;
      }
    };

    walk(root);
    if (resolved) return resolved;
    if (root.childNodes.length === 0) return { node: root, offset: 0 };
    return lastPoint;
  };

  const p1 = findPoint(start);
  const p2 = findPoint(Math.max(start, end));
  const range = document.createRange();
  range.setStart(p1.node, p1.offset);
  range.setEnd(p2.node, p2.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}
