import init, {
  apply_ir_edit,
  export_ir_to_docx,
  export_ir_to_markdown,
  export_pdf_forms,
  generate_sample,
  list_samples,
  open_document,
  parse_markdown_live,
  reverify_pdf,
} from '../wasm/orb_wasm';
import type {
  DocumentIr,
  EditOperation,
  FormFieldUpdate,
  OpenedDocument,
  PdfInspection,
  SampleDescriptor,
} from '../types';

export type WorkerPayload =
  | { method: 'listSamples' }
  | { method: 'generateSample'; sampleId: string }
  | {
      method: 'openDocument';
      bytes: Uint8Array;
      filename?: string;
      trustedRootsPem: string[];
    }
  | { method: 'parseMarkdownLive'; markdown: string; filename?: string }
  | { method: 'applyIrEdit'; ir: DocumentIr; op: EditOperation }
  | { method: 'exportIrToMarkdown'; ir: DocumentIr }
  | { method: 'exportIrToDocx'; ir: DocumentIr }
  | {
      method: 'exportPdfForms';
      rawPdf: Uint8Array;
      updates: FormFieldUpdate[];
    }
  | {
      method: 'reverifyPdf';
      rawPdf: Uint8Array;
      filename?: string;
      trustedRootsPem: string[];
    };

export type WorkerRequest = WorkerPayload & { id: number };

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export interface GeneratedSamplePayload {
  filename: string;
  bytes: Uint8Array;
  hintPem?: string | null;
}

let initPromise: Promise<unknown> | null = null;

function ensureInit(): Promise<unknown> {
  if (!initPromise) {
    initPromise = init();
  }
  return initPromise;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    await ensureInit();
    let result: unknown;

    switch (req.method) {
      case 'listSamples':
        result = list_samples() as SampleDescriptor[];
        break;
      case 'generateSample': {
        const raw = generate_sample(req.sampleId) as {
          filename: string;
          bytes: number[];
          hintPem?: string | null;
        };
        result = {
          filename: raw.filename,
          bytes: new Uint8Array(raw.bytes),
          hintPem: raw.hintPem ?? null,
        } satisfies GeneratedSamplePayload;
        break;
      }
      case 'openDocument':
        result = open_document(
          req.bytes,
          req.filename ?? undefined,
          JSON.stringify(req.trustedRootsPem),
        ) as OpenedDocument;
        break;
      case 'parseMarkdownLive':
        result = parse_markdown_live(req.markdown, req.filename ?? undefined) as DocumentIr;
        break;
      case 'applyIrEdit':
        result = apply_ir_edit(JSON.stringify(req.ir), JSON.stringify(req.op)) as DocumentIr;
        break;
      case 'exportIrToMarkdown':
        result = export_ir_to_markdown(JSON.stringify(req.ir));
        break;
      case 'exportIrToDocx':
        result = export_ir_to_docx(JSON.stringify(req.ir));
        break;
      case 'exportPdfForms':
        result = export_pdf_forms(req.rawPdf, JSON.stringify(req.updates));
        break;
      case 'reverifyPdf':
        result = reverify_pdf(
          req.rawPdf,
          req.filename ?? undefined,
          JSON.stringify(req.trustedRootsPem),
        ) as PdfInspection;
        break;
    }

    const msg: WorkerResponse = { id: req.id, ok: true, result };
    self.postMessage(msg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const msg: WorkerResponse = { id: req.id, ok: false, error: message };
    self.postMessage(msg);
  }
};
