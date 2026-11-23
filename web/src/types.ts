export type DocumentFormat = 'markdown' | 'docx' | 'doc' | 'pdf';
export type TextAlign = 'left' | 'center' | 'right' | 'justify';
export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
}

export interface DocumentMetadata {
  author?: string | null;
  subject?: string | null;
  created?: string | null;
  modified?: string | null;
  wordCount: number;
  charCount: number;
  diagnostics: Diagnostic[];
}

export interface OutlineItem {
  id: string;
  level: number;
  title: string;
  blockId: string;
}

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  href?: string | null;
  fontSizePt?: number | null;
}

export interface InlineRun {
  text: string;
  style: TextStyle;
}

export interface ListItem {
  id: string;
  checked?: boolean | null;
  runs: InlineRun[];
  children: Block[];
}

export interface TableCell {
  id: string;
  colSpan: number;
  rowSpan: number;
  align: TextAlign;
  blocks: Block[];
}

export interface TableRow {
  header: boolean;
  cells: TableCell[];
}

export type Block =
  | { id: string; type: 'heading'; level: number; runs: InlineRun[]; align: TextAlign }
  | {
      id: string;
      type: 'paragraph';
      runs: InlineRun[];
      align: TextAlign;
      indentLevel: number;
    }
  | { id: string; type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { id: string; type: 'table'; rows: TableRow[] }
  | { id: string; type: 'blockQuote'; blocks: Block[] }
  | { id: string; type: 'codeBlock'; language?: string | null; code: string }
  | {
      id: string;
      type: 'image';
      assetId: string;
      alt: string;
      widthPx?: number | null;
      heightPx?: number | null;
      caption?: string | null;
    }
  | { id: string; type: 'horizontalRule' }
  | { id: string; type: 'pageBreak' }
  | { id: string; type: 'footnote'; label: string; blocks: Block[] };

export interface MediaAsset {
  id: string;
  mimeType: string;
  dataBase64: string;
  filename?: string | null;
}

export interface DocumentIr {
  version: number;
  title?: string | null;
  sourceFormat: DocumentFormat;
  metadata: DocumentMetadata;
  outline: OutlineItem[];
  blocks: Block[];
  assets: MediaAsset[];
}

export type BlockConvertTarget =
  | { kind: 'paragraph' }
  | { kind: 'heading'; level: number }
  | { kind: 'blockQuote' }
  | { kind: 'codeBlock' }
  | { kind: 'list'; ordered: boolean; checklist: boolean };

export type EditOperation =
  | { op: 'setTitle'; title: string | null }
  | { op: 'updateBlockRuns'; blockId: string; runs: InlineRun[] }
  | { op: 'updateHeadingLevel'; blockId: string; level: number }
  | { op: 'setBlockAlign'; blockId: string; align: TextAlign }
  | { op: 'setBlockIndent'; blockId: string; indentLevel: number }
  | { op: 'convertBlockKind'; blockId: string; target: BlockConvertTarget }
  | { op: 'updateCodeBlock'; blockId: string; language: string | null; code: string }
  | {
      op: 'updateListItem';
      blockId: string;
      itemIndex: number;
      runs: InlineRun[];
      checked: boolean | null;
    }
  | { op: 'addListItem'; blockId: string; afterIndex: number | null; item: ListItem }
  | { op: 'deleteListItem'; blockId: string; itemIndex: number }
  | { op: 'updateTableCell'; blockId: string; row: number; col: number; text: string }
  | { op: 'addTableRow'; blockId: string; afterRow: number | null }
  | { op: 'deleteTableRow'; blockId: string; row: number }
  | { op: 'addTableColumn'; blockId: string; afterCol: number | null }
  | { op: 'deleteTableColumn'; blockId: string; col: number }
  | { op: 'addAsset'; asset: MediaAsset }
  | { op: 'replaceAllText'; find: string; replace: string; caseSensitive?: boolean }
  | { op: 'insertBlockAfter'; afterBlockId: string | null; block: Block }
  | { op: 'deleteBlock'; blockId: string };

export interface PdfPageMetrics {
  pageIndex: number;
  width: number;
  height: number;
  mediaBox: [number, number, number, number];
  cropBox: [number, number, number, number];
  rotation: number;
}

export interface PdfOutlineItem {
  id: string;
  title: string;
  pageIndex?: number | null;
  level: number;
}

export type FormFieldType =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'listbox'
  | 'signature'
  | 'button';

export type FormFieldValue =
  | { kind: 'text'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'choice'; value: string }
  | { kind: 'none' };

export interface PdfFormField {
  id: string;
  objectId: [number, number];
  parentObjectId?: [number, number] | null;
  name: string;
  fieldType: FormFieldType;
  pageIndex: number;
  rect: [number, number, number, number];
  value: FormFieldValue;
  options: string[];
  onState?: string | null;
  multiline: boolean;
  password: boolean;
  readOnly: boolean;
  required: boolean;
  maxLen?: number | null;
}

export interface FormFieldUpdate {
  fieldName: string;
  value: FormFieldValue;
}

export type IntegrityStatus =
  | 'valid'
  | 'invalid'
  | 'unsupportedAlgorithm'
  | 'parseError';

export type CoverageStatus =
  | 'fullDocument'
  | 'incrementalUpdatesAfterSigning'
  | 'invalidByteRange';

export type TrustStatus =
  | 'trustedByUserRoot'
  | 'selfSigned'
  | 'unverifiedIssuer'
  | 'invalidCertificate';

export interface TrustEvaluation {
  status: TrustStatus;
  detail: string;
  matchedRootSubject?: string | null;
}

export interface CertificateInfo {
  commonName?: string | null;
  organization?: string | null;
  subject: string;
  issuer: string;
  serialHex: string;
  notBefore: string;
  notAfter: string;
  sha256Fingerprint: string;
  keyAlgorithm: string;
  pem: string;
}

export interface PdfSignatureReport {
  id: string;
  fieldName: string;
  signerName?: string | null;
  reason?: string | null;
  location?: string | null;
  contactInfo?: string | null;
  signingTime?: string | null;
  subFilter?: string | null;
  digestAlgorithm?: string | null;
  signatureAlgorithm?: string | null;
  byteRange?: [number, number, number, number] | null;
  pageIndex?: number | null;
  rect?: [number, number, number, number] | null;
  integrity: IntegrityStatus;
  integrityDetail: string;
  coverage: CoverageStatus;
  coverageDetail: string;
  trust: TrustEvaluation;
  signerCertificate?: CertificateInfo | null;
  certificateChain: CertificateInfo[];
}

export interface PdfInspection {
  title?: string | null;
  author?: string | null;
  subject?: string | null;
  pdfVersion: string;
  pageCount: number;
  pages: PdfPageMetrics[];
  outline: PdfOutlineItem[];
  formFields: PdfFormField[];
  signatures: PdfSignatureReport[];
  hasSignatures: boolean;
  hasForms: boolean;
  diagnostics: Diagnostic[];
}

export type OpenedDocument =
  | { kind: 'markdown'; ir: DocumentIr; rawMarkdown: string }
  | { kind: 'word'; ir: DocumentIr; wordFormat: 'docx' | 'doc' }
  | { kind: 'pdf'; inspection: PdfInspection };

export interface SampleDescriptor {
  id: string;
  label: string;
  filename: string;
  format: DocumentFormat;
  description: string;
}
