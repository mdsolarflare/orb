import type { PdfPageMetrics } from '../../types';

export interface RenderedPageDimensions {
  width: number;
  height: number;
}

export interface PdfTextSpan {
  text: string;
  left: number;
  top: number;
  fontSize: number;
  width: number;
}

/**
 * Pluggable PDF page rasterization interface.
 *
 * Web prototype binds to `PdfJsPageRenderer` (`pdfjs-dist`).
 * Future web or native builds can swap in PDFium WASM, PDFKit, or hayro/vello
 * without touching Orb's AcroForm or cryptographic signature engine.
 */
export interface PdfPageRenderer {
  load(bytes: Uint8Array): Promise<{ pageCount: number }>;
  renderPage(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    scale: number,
  ): Promise<RenderedPageDimensions>;
  getTextSpans(pageIndex: number, scale: number): Promise<PdfTextSpan[]>;
  destroy(): Promise<void>;
}

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Projects a PDF user-space rectangle [x1, y1, x2, y2] (origin bottom-left)
 * into CSS viewport pixels (origin top-left) for the given page metrics and scale.
 */
export function pdfRectToViewport(
  rect: [number, number, number, number],
  page: PdfPageMetrics,
  scale: number,
): ViewportRect {
  const [cx1, cy1, cx2, cy2] = page.cropBox;
  const rx1 = Math.min(rect[0], rect[2]);
  const ry1 = Math.min(rect[1], rect[3]);
  const rx2 = Math.max(rect[0], rect[2]);
  const ry2 = Math.max(rect[1], rect[3]);

  const boxW = cx2 - cx1;
  const boxH = cy2 - cy1;
  const rot = ((page.rotation % 360) + 360) % 360;

  let vx1: number;
  let vy1: number;
  let vx2: number;
  let vy2: number;

  switch (rot) {
    case 90:
      vx1 = ry1 - cy1;
      vx2 = ry2 - cy1;
      vy1 = rx1 - cx1;
      vy2 = rx2 - cx1;
      break;
    case 180:
      vx1 = cx2 - rx2;
      vx2 = cx2 - rx1;
      vy1 = ry1 - cy1;
      vy2 = ry2 - cy1;
      break;
    case 270:
      vx1 = cy2 - ry2;
      vx2 = cy2 - ry1;
      vy1 = boxW - (rx2 - cx1);
      vy2 = boxW - (rx1 - cx1);
      break;
    default:
      vx1 = rx1 - cx1;
      vx2 = rx2 - cx1;
      vy1 = boxH - (ry2 - cy1);
      vy2 = boxH - (ry1 - cy1);
      break;
  }

  return {
    left: vx1 * scale,
    top: vy1 * scale,
    width: Math.max(4, (vx2 - vx1) * scale),
    height: Math.max(4, (vy2 - vy1) * scale),
  };
}
