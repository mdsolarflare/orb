import { describe, expect, it } from 'vitest';
import type { InlineRun } from '../src/types';
import {
  clearStyleInRange,
  countTextOccurrences,
  domToRuns,
  getLinkRunAtOffset,
  getSelectionOffsetsInElement,
  getStyleAtRange,
  insertStyledTextAtRange,
  isSafeHref,
  mergeRuns,
  replaceNthOccurrenceInRuns,
  runsToSafeHtml,
  setFontSizeInRange,
  setLinkInRange,
  splitRunsAtOffset,
  toggleStyleFlag,
  toggleStyleInRange,
} from '../src/utils/editorRuns';

interface MockNode {
  nodeType: number;
  textContent?: string;
  tagName?: string;
  attrs?: Record<string, string>;
  style?: { fontSize?: string };
  childNodes: MockNode[];
  parentNode: MockNode | null;
  nextSibling: MockNode | null;
  previousSibling: MockNode | null;
  hasAttribute: (k: string) => boolean;
  getAttribute: (k: string) => string | null;
  contains: (other: MockNode) => boolean;
}

function makeText(text: string): MockNode {
  return {
    nodeType: 3,
    textContent: text,
    childNodes: [],
    parentNode: null,
    nextSibling: null,
    previousSibling: null,
    hasAttribute: () => false,
    getAttribute: () => null,
    contains(other) {
      return other === this;
    },
  };
}

function makeEl(
  tagName: string,
  children: MockNode[] = [],
  attrs: Record<string, string> = {},
  fontSize = '',
): MockNode {
  const el: MockNode = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    attrs,
    style: { fontSize },
    childNodes: children,
    parentNode: null,
    nextSibling: null,
    previousSibling: null,
    hasAttribute: (k) => Object.prototype.hasOwnProperty.call(attrs, k),
    getAttribute: (k) => attrs[k] ?? null,
    contains(other) {
      if (other === this) return true;
      return this.childNodes.some((c) => c.contains(other));
    },
  };
  for (let i = 0; i < children.length; i++) {
    children[i].parentNode = el;
    children[i].previousSibling = i > 0 ? children[i - 1] : null;
    children[i].nextSibling = i < children.length - 1 ? children[i + 1] : null;
  }
  return el;
}

describe('editorRuns inline formatting helpers', () => {
  it('toggles bold/italic/superscript/subscript cleanly across partial selections', () => {
    const initial: InlineRun[] = [{ text: 'Hello Orb World', style: {} }];

    const bolded = toggleStyleInRange(initial, 6, 9, 'bold');
    expect(bolded).toEqual([
      { text: 'Hello ', style: {} },
      { text: 'Orb', style: { bold: true } },
      { text: ' World', style: {} },
    ]);

    // Toggling again removes bold and merges back into one plain run
    const unbolded = toggleStyleInRange(bolded, 6, 9, 'bold');
    expect(unbolded).toEqual([{ text: 'Hello Orb World', style: {} }]);

    // Superscript and subscript are mutually exclusive
    const sup = toggleStyleInRange(initial, 0, 5, 'superscript');
    const sub = toggleStyleInRange(sup, 0, 5, 'subscript');
    expect(sub[0].style.superscript).toBeUndefined();
    expect(sub[0].style.subscript).toBe(true);
  });

  it('does not reformat whole paragraph on collapsed caret and supports stored-mark typing', () => {
    const initial: InlineRun[] = [{ text: 'Hello World', style: {} }];
    expect(toggleStyleInRange(initial, 5, 5, 'bold')).toEqual(initial);
    expect(setFontSizeInRange(initial, 5, 5, 18)).toEqual(initial);
    expect(clearStyleInRange([{ text: 'Bold', style: { bold: true } }], 2, 2)).toEqual([
      { text: 'Bold', style: { bold: true } },
    ]);

    // Stored mark workflow on empty paragraph or collapsed caret
    const stored = toggleStyleFlag({}, 'bold');
    expect(stored).toEqual({ bold: true });
    const typed = insertStyledTextAtRange([], 0, 0, 'Hi', stored);
    expect(typed).toEqual([{ text: 'Hi', style: { bold: true } }]);
    const midInserted = insertStyledTextAtRange(initial, 5, 5, ' Orb', { italic: true });
    expect(midInserted).toEqual([
      { text: 'Hello', style: {} },
      { text: ' Orb', style: { italic: true } },
      { text: ' World', style: {} },
    ]);
  });

  it('validates hrefs strictly and omits target="_blank" for #anchor links', () => {
    expect(isSafeHref('https://example.com/docs')).toBe(true);
    expect(isSafeHref('http://localhost:3000')).toBe(true);
    expect(isSafeHref('mailto:team@orb.dev')).toBe(true);
    expect(isSafeHref('#appendix-1')).toBe(true);

    // Reject bare schemes, malformed URLs, whitespace fragments, and unsafe protocols
    expect(isSafeHref('')).toBe(false);
    expect(isSafeHref('https://')).toBe(false);
    expect(isSafeHref('http://')).toBe(false);
    expect(isSafeHref('mailto:')).toBe(false);
    expect(isSafeHref('mailto:bad address')).toBe(false);
    expect(isSafeHref('#')).toBe(false);
    expect(isSafeHref('#has space')).toBe(false);
    expect(isSafeHref('javascript:alert(1)')).toBe(false);

    const anchorHtml = runsToSafeHtml([{ text: 'Jump', style: { href: '#sec-1' } }]);
    expect(anchorHtml).toBe('<a href="#sec-1">Jump</a>');
    expect(anchorHtml).not.toContain('target="_blank"');

    const externalHtml = runsToSafeHtml([{ text: 'Docs', style: { href: 'https://orb.dev' } }]);
    expect(externalHtml).toContain('target="_blank" rel="noopener noreferrer"');
  });

  it('applies font size (6-144pt), edits links in place at collapsed caret, and unlinks single run', () => {
    const initial: InlineRun[] = [{ text: 'Visit Orb', style: {} }];
    const sized = setFontSizeInRange(initial, 0, 9, 48);
    expect(getStyleAtRange(sized, 0, 9).fontSizePt).toBe(48);

    const linked = setLinkInRange(sized, 6, 9, 'https://example.com');
    expect(linked[1].style.href).toBe('https://example.com');
    expect(getLinkRunAtOffset(linked, 7)).toEqual({
      start: 6,
      end: 9,
      text: 'Orb',
      href: 'https://example.com',
    });

    // Editing an existing link at collapsed caret updates href in place without duplicating URL
    const editedHref = setLinkInRange(linked, 7, 7, 'https://orb.dev', 'Orb');
    expect(editedHref).toEqual([
      { text: 'Visit ', style: { fontSizePt: 48 } },
      { text: 'Orb', style: { fontSizePt: 48, href: 'https://orb.dev' } },
    ]);

    // Updating both href and display text at collapsed caret replaces the link span in place
    const editedText = setLinkInRange(editedHref, 7, 7, 'https://orb.dev/docs', 'Orb Docs');
    expect(editedText).toEqual([
      { text: 'Visit ', style: { fontSizePt: 48 } },
      { text: 'Orb Docs', style: { fontSizePt: 48, href: 'https://orb.dev/docs' } },
    ]);

    // Removing link at collapsed caret removes href ONLY from the single matched link run
    const adjacentLinks: InlineRun[] = [
      { text: 'One', style: { href: 'https://one.dev' } },
      { text: 'Two', style: { href: 'https://two.dev' } },
    ];
    const unlinkedFirst = setLinkInRange(adjacentLinks, 3, 3, null);
    expect(unlinkedFirst).toEqual([
      { text: 'One', style: {} },
      { text: 'Two', style: { href: 'https://two.dev' } },
    ]);

    // Leading/trailing whitespace in selection does not clobber mixed formatting when trimmed label matches
    const mixed: InlineRun[] = [
      { text: ' ', style: {} },
      { text: 'Orb', style: { bold: true } },
    ];
    const linkedMixed = setLinkInRange(mixed, 0, 4, 'https://orb.dev', 'Orb');
    expect(linkedMixed).toEqual([
      { text: ' ', style: { href: 'https://orb.dev' } },
      { text: 'Orb', style: { bold: true, href: 'https://orb.dev' } },
    ]);

    // Replacing selected text with edited display label & internal #anchor link
    const relabeled = setLinkInRange(initial, 6, 9, '#section-2', 'Section Two');
    expect(relabeled).toEqual([
      { text: 'Visit ', style: {} },
      { text: 'Section Two', style: { href: '#section-2' } },
    ]);

    // Rejects unsafe javascript: URLs
    const unsafe = setLinkInRange(initial, 0, 5, 'javascript:alert(1)');
    expect(unsafe[0].style.href).toBeUndefined();

    const cleared = clearStyleInRange(linked, 0, 9);
    expect(cleared).toEqual([{ text: 'Visit Orb', style: {} }]);
  });

  it('composes code with other inline styles and handles trailing newlines safely in HTML', () => {
    const runs: InlineRun[] = mergeRuns([
      { text: 'code()', style: { code: true, bold: true, href: 'https://orb.dev' } },
      { text: '\nline2\n', style: {} },
    ]);

    const html = runsToSafeHtml(runs);
    expect(html).toContain('<a href="https://orb.dev"');
    expect(html).toContain('<strong><code>code()</code></strong>');
    expect(html).toContain('<br data-orb-sentinel="1">');
  });

  it('splits styled runs cleanly on Enter and escapes HTML safely', () => {
    const runs: InlineRun[] = mergeRuns([
      { text: 'Alpha ', style: { bold: true } },
      { text: '<script>&', style: { italic: true } },
    ]);

    const [before, after] = splitRunsAtOffset(runs, 8);
    expect(before).toEqual([
      { text: 'Alpha ', style: { bold: true } },
      { text: '<s', style: { italic: true } },
    ]);
    expect(after).toEqual([{ text: 'cript>&', style: { italic: true } }]);

    const html = runsToSafeHtml(runs);
    expect(html).toContain('<strong>Alpha </strong>');
    expect(html).toContain('<em>&lt;script&gt;&amp;</em>');
    expect(html).not.toContain('<script>');
  });

  it('counts and replaces individual occurrences accurately preserving forward-affinity style', () => {
    const runs: InlineRun[] = [
      { text: 'See ', style: {} },
      { text: 'Orb', style: { bold: true } },
      { text: ' and orb', style: {} },
    ];
    expect(countTextOccurrences('See Orb and orb', 'orb', false)).toBe(2);
    expect(countTextOccurrences('See Orb and orb', 'orb', true)).toBe(1);

    // Match starting at index 4 (boundary of bold run "Orb") preserves bold via forward affinity
    const first = replaceNthOccurrenceInRuns(runs, 'orb', 'DOC', false, 0);
    expect(first.replaced).toBe(true);
    expect(first.runs).toEqual([
      { text: 'See ', style: {} },
      { text: 'DOC', style: { bold: true } },
      { text: ' and orb', style: {} },
    ]);

    const second = replaceNthOccurrenceInRuns(runs, 'orb', 'DOC', false, 1);
    expect(second.replaced).toBe(true);
    expect(second.runs).toEqual([
      { text: 'See ', style: {} },
      { text: 'Orb', style: { bold: true } },
      { text: ' and DOC', style: {} },
    ]);
  });

  it('parses domToRuns and measures selection offsets consistently across <br> and nested code', () => {
    const prevNode = (globalThis as unknown as { Node?: unknown }).Node;
    const prevWindow = (globalThis as unknown as { window?: unknown }).window;

    try {
      (globalThis as unknown as { Node: { TEXT_NODE: number; ELEMENT_NODE: number } }).Node = {
        TEXT_NODE: 3,
        ELEMENT_NODE: 1,
      };

      const t1 = makeText('ab');
      const br = makeEl('br');
      const t2 = makeText('cd');
      const strongCode = makeEl('strong', [makeEl('code', [t1])]);
      const sentinel = makeEl('br', [], { 'data-orb-sentinel': '1' });
      const root = makeEl('p', [strongCode, br, t2, sentinel]);

      const parsed = domToRuns(root as unknown as HTMLElement);
      expect(parsed).toEqual([
        { text: 'ab', style: { bold: true, code: true } },
        { text: '\ncd', style: {} },
      ]);

      // Empty editable block with lone browser <br> parses as empty runs
      const emptyRoot = makeEl('p', [makeEl('br')]);
      expect(domToRuns(emptyRoot as unknown as HTMLElement)).toEqual([]);

      // Selection offset after <br> accounts for '\n' (offset 2 = before <br>, 3 = start of 'cd', 4 = after 'c')
      (globalThis as unknown as { window: unknown }).window = {
        getSelection: () => ({
          rangeCount: 1,
          getRangeAt: () => ({
            startContainer: t2,
            startOffset: 1,
            endContainer: t2,
            endOffset: 2,
          }),
        }),
      };

      const offsets = getSelectionOffsetsInElement(root as unknown as HTMLElement);
      expect(offsets).toEqual({ start: 4, end: 5 });
    } finally {
      (globalThis as unknown as { Node?: unknown }).Node = prevNode;
      (globalThis as unknown as { window?: unknown }).window = prevWindow;
    }
  });
});
