import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfjsWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from 'pdfjs-dist/types/src/display/api';
import type { PdfPageRenderer, PdfTextSpan, RenderedPageDimensions } from './types';

// Configure local static bundled PDF.js worker (zero external CDN requests)
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

export class PdfJsPageRenderer implements PdfPageRenderer {
  private loadGen = 0;
  private loadingTask: PDFDocumentLoadingTask | null = null;
  private doc: PDFDocumentProxy | null = null;
  private readonly activeTasks = new Map<number, RenderTask>();

  async load(bytes: Uint8Array): Promise<{ pageCount: number }> {
    const gen = ++this.loadGen;
    await this.cleanupCurrent();
    if (gen !== this.loadGen) {
      throw new Error('PDF load superseded');
    }

    // Pass an independent copy so PDF.js worker transfer never detaches caller's bytes
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);

    const loadingTask = pdfjsLib.getDocument({
      data: copy,
      useSystemFonts: true,
    });
    this.loadingTask = loadingTask;
    try {
      const doc = await loadingTask.promise;
      if (gen !== this.loadGen || this.loadingTask !== loadingTask) {
        await loadingTask.destroy().catch(() => {});
        throw new Error('PDF load superseded');
      }
      this.doc = doc;
      return { pageCount: this.doc.numPages };
    } catch (err) {
      if (this.loadingTask === loadingTask) {
        this.loadingTask = null;
      }
      await loadingTask.destroy().catch(() => {});
      throw err;
    }
  }

  async renderPage(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    scale: number,
  ): Promise<RenderedPageDimensions> {
    if (!this.doc) {
      throw new Error('PDF document not loaded');
    }

    const previous = this.activeTasks.get(pageIndex);
    if (previous) {
      try {
        previous.cancel();
      } catch {
        // Ignore already-completed cancellation
      }
      this.activeTasks.delete(pageIndex);
    }

    const page = await this.doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

    const pixelWidth = Math.floor(viewport.width * dpr);
    const pixelHeight = Math.floor(viewport.height * dpr);
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
    const renderTask = page.render({
      canvas,
      viewport,
      transform,
      annotationMode: pdfjsLib.AnnotationMode.DISABLE,
    });
    this.activeTasks.set(pageIndex, renderTask);

    try {
      await renderTask.promise;
    } catch (err) {
      const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
      if (name !== 'RenderingCancelledException') {
        throw err;
      }
    } finally {
      if (this.activeTasks.get(pageIndex) === renderTask) {
        this.activeTasks.delete(pageIndex);
      }
    }

    return { width: viewport.width, height: viewport.height };
  }

  async getTextSpans(pageIndex: number, scale: number): Promise<PdfTextSpan[]> {
    if (!this.doc) return [];
    const page = await this.doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale });
    const content = await page.getTextContent();
    const spans: PdfTextSpan[] = [];

    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontSize = Math.hypot(tx[0], tx[1]);
      const left = tx[4];
      const top = tx[5] - fontSize;
      spans.push({
        text: item.str,
        left,
        top,
        fontSize,
        width: item.width * scale,
      });
    }
    return spans;
  }

  async destroy(): Promise<void> {
    this.loadGen++;
    await this.cleanupCurrent();
  }

  private async cleanupCurrent(): Promise<void> {
    for (const task of this.activeTasks.values()) {
      try {
        task.cancel();
      } catch {
        // Ignore cancellation race
      }
    }
    this.activeTasks.clear();
    const loadingTask = this.loadingTask ?? this.doc?.loadingTask ?? null;
    this.loadingTask = null;
    this.doc = null;
    if (loadingTask) {
      await loadingTask.destroy();
    }
  }
}
