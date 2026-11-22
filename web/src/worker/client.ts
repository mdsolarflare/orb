import type {
  DocumentIr,
  EditOperation,
  FormFieldUpdate,
  OpenedDocument,
  PdfInspection,
  SampleDescriptor,
} from '../types';
import type { GeneratedSamplePayload, WorkerPayload, WorkerResponse } from './orb.worker';

interface PendingCall {
  resolve: (val: unknown) => void;
  reject: (err: Error) => void;
}

class OrbWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./orb.worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const res = event.data;
        const entry = this.pending.get(res.id);
        if (!entry) return;
        this.pending.delete(res.id);
        if (res.ok) {
          entry.resolve(res.result);
        } else {
          entry.reject(new Error(res.error));
        }
      };
      this.worker.onerror = (event) => {
        const err = new Error(event.message || 'Orb WASM worker encountered an error.');
        for (const entry of this.pending.values()) {
          entry.reject(err);
        }
        this.pending.clear();
      };
    }
    return this.worker;
  }

  private call<T>(payload: WorkerPayload): Promise<T> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
      });
      worker.postMessage({ id, ...payload });
    });
  }

  listSamples(): Promise<SampleDescriptor[]> {
    return this.call<SampleDescriptor[]>({ method: 'listSamples' });
  }

  generateSample(sampleId: string): Promise<GeneratedSamplePayload> {
    return this.call<GeneratedSamplePayload>({ method: 'generateSample', sampleId });
  }

  openDocument(
    bytes: Uint8Array,
    filename?: string,
    trustedRootsPem: string[] = [],
  ): Promise<OpenedDocument> {
    return this.call<OpenedDocument>({
      method: 'openDocument',
      bytes,
      filename,
      trustedRootsPem,
    });
  }

  parseMarkdownLive(markdown: string, filename?: string): Promise<DocumentIr> {
    return this.call<DocumentIr>({ method: 'parseMarkdownLive', markdown, filename });
  }

  applyIrEdit(ir: DocumentIr, op: EditOperation): Promise<DocumentIr> {
    return this.call<DocumentIr>({ method: 'applyIrEdit', ir, op });
  }

  exportIrToMarkdown(ir: DocumentIr): Promise<string> {
    return this.call<string>({ method: 'exportIrToMarkdown', ir });
  }

  exportIrToDocx(ir: DocumentIr): Promise<Uint8Array> {
    return this.call<Uint8Array>({ method: 'exportIrToDocx', ir });
  }

  exportPdfForms(rawPdf: Uint8Array, updates: FormFieldUpdate[]): Promise<Uint8Array> {
    return this.call<Uint8Array>({ method: 'exportPdfForms', rawPdf, updates });
  }

  reverifyPdf(
    rawPdf: Uint8Array,
    filename: string | undefined,
    trustedRootsPem: string[],
  ): Promise<PdfInspection> {
    return this.call<PdfInspection>({
      method: 'reverifyPdf',
      rawPdf,
      filename,
      trustedRootsPem,
    });
  }
}

export const orbClient = new OrbWorkerClient();
