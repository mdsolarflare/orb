import { describe, expect, it } from 'vitest';
import { pdfRectToViewport } from '../src/adapters/pdf/types';
import type { PdfPageMetrics } from '../src/types';

const letterPage: PdfPageMetrics = {
  pageIndex: 0,
  width: 612,
  height: 792,
  mediaBox: [0, 0, 612, 792],
  cropBox: [0, 0, 612, 792],
  rotation: 0,
};

describe('pdfRectToViewport', () => {
  it('converts standard bottom-left PDF user space into top-left CSS pixels', () => {
    const vp = pdfRectToViewport([180, 588, 520, 612], letterPage, 1.5);
    expect(vp.left).toBeCloseTo(270);
    expect(vp.top).toBeCloseTo((792 - 612) * 1.5);
    expect(vp.width).toBeCloseTo(340 * 1.5);
    expect(vp.height).toBeCloseTo(24 * 1.5);
  });

  it('respects non-zero cropBox offsets and 90-degree page rotation', () => {
    const rotated: PdfPageMetrics = {
      ...letterPage,
      cropBox: [10, 20, 610, 720],
      width: 700,
      height: 600,
      rotation: 90,
    };
    const vp = pdfRectToViewport([110, 120, 210, 160], rotated, 1);
    expect(vp.left).toBe(100);
    expect(vp.top).toBe(100);
    expect(vp.width).toBe(40);
    expect(vp.height).toBe(100);
  });
});
