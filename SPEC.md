# Orb Technical Specification

**Status:** Implemented (Initial Working Prototype)
**License:** AGPL-3.0

## 1. Purpose and Scope

Orb is a client-side office document viewer and editor designed for long-term format compatibility, minimal external dependencies, and portability from a static web application to future native Windows and macOS clients.

### Implemented Prototype Capabilities

| Format | View | Edit | Export / Save | Specialized Features |
| --- | --- | --- | --- | --- |
| **PDF** (`.pdf`) | Paginated HiDPI canvas + selectable text layer, zoom, outline | Interactive AcroForm fields (`Tx`, `Btn` checkbox/radio, `Ch` dropdown/listbox) | Incremental-update `.pdf` | Digital signature inspection, cryptographic verification, session PEM root trust |
| **Word OOXML** (`.docx`) | Canonical IR sheet view, zoom, outline | Inline block, heading, list, code, and table-cell IR editing | `.docx`, `.md` | Styles, numbering/lists, tables, hyperlinks, footnotes, embedded media |
| **Word Binary** (`.doc`) | Canonical IR sheet view, zoom, outline | Inline block, heading, list, code, and table-cell IR editing | `.docx`, `.md` | Word 97–2003 OLE2/CFB decoding (`FIB`, `Clx`, `STSH`, `CHPX`/`PAPX`, `SummaryInformation`) |
| **Markdown** (`.md`) | Reading, Split, and Source views, live outline | Live source editing with debounced WASM preview | `.md`, `.docx` | CommonMark + GFM (tables, task lists, strikethrough, footnotes) |

## 2. Architecture

Orb separates platform-agnostic document processing (Rust) from presentation (React + TypeScript). For static web delivery, the Rust workspace compiles to `wasm32-unknown-unknown` via `wasm-bindgen` (`scripts/build-wasm.sh`) and executes inside a dedicated Web Worker.

### 2.1 Crate Boundaries (`cargo` Workspace)

- `crates/orb-ir` — Versioned Canonical Document IR (`IR_SCHEMA_VERSION = 1`), outline builder, statistics, and `EditOperation` dispatch. Zero IO, WASM, or UI dependencies.
- `crates/orb-md` — CommonMark + GFM parser and serializer mapping to/from `orb-ir`.
- `crates/orb-docx` — Pure-Rust OOXML (`.docx`) reader and writer (including embedded `word/media/*` assets) mapping to/from `orb-ir`.
- `crates/orb-doc` — Pure-Rust OLE2 Compound File Binary / MS-DOC (`.doc`) binary parser and deterministic Word 97–2003 fixture generator.
- `crates/orb-pdf` — PDF metadata/outline inspector, AcroForm parser, spec-compliant incremental-update form writer with `/AP /N` appearance stream generation, CMS/PKCS#7 + X.509 cryptographic signature verifier, and deterministic signed AcroForm fixture generator.
- `crates/orb-engine` — Unified document facade: magic-byte format detection, document opening, edit/export dispatch, and built-in verification sample fixtures.
- `crates/orb-wasm` — Thin `wasm-bindgen` transport layer exposing `orb-engine` to the Web Worker. Target-scoped `wasm32` dependencies (`getrandom` `js`/`wasm_js`) and `.cargo/config.toml` (`getrandom_backend="wasm_js"`) remain isolated from core crates.

### 2.2 Web Frontend (`pnpm` + Vite + React + TypeScript)

- `web/src/worker/` — Dedicated ES module Web Worker (`orb.worker.ts`) and typed RPC client (`client.ts`) hosting `orb-wasm` off the main thread.
- `web/src/adapters/pdf/` — Swappable `PdfPageRenderer` interface, PDF-to-viewport coordinate projection (`pdfRectToViewport`), and `PdfJsPageRenderer` using a locally bundled `pdf.worker.min.mjs`.
- `web/src/theme/` — 6-color `ThemeRegistry` (`themes.ts`), OKLCH `color-mix()` derived token sheet (`tokens.css`), and `ThemeProvider.tsx` (`System` / `Light` / `Dark`).
- `web/src/components/` — App shell (`Toolbar`, `WelcomeStage`, `OutlineSidebar`, `InspectorSidebar`), `DocumentIrView` (view + inline IR editor), `MarkdownWorkspace`, and `PdfWorkspace` (HiDPI canvas + text layer + interactive AcroForm & signature hotspot overlay).

### 2.3 Format Detection

Files are classified by header magic bytes before falling back to extension:
- `%PDF-` (within first 1024 bytes) -> PDF
- `{\rtf` -> Diagnosed and reported as unsupported RTF (common `.doc` misnomer)
- `D0 CF 11 E0 A1 B1 1A E1` (OLE2 CFB) -> `.doc`
- `PK\x03\x04` containing `word/document.xml` -> `.docx`
- Valid UTF-8 text (`.md`, `.markdown`, `.mdown`, `.txt`, or printable text) -> Markdown

## 3. Format Specifications

### 3.1 PDF (`orb-pdf` + `PdfPageRenderer`)

- **Rendering:** Delegated via `PdfPageRenderer` (`pdfjs-dist` with `AnnotationMode.DISABLE`) so Orb's Rust-backed AcroForm overlay is the single source of interactive form state.
- **Digital Signatures (`orb-pdf::signature`, `orb-pdf::trust`):**
  - Discovers `/Sig` dictionaries via page widget `/Annots`, `/AcroForm /Fields`, and indirect `/Type /Sig` fallback scan.
  - Trims zero-padded `/Contents` using ASN.1 DER outer TLV framing and decodes CMS `ContentInfo` -> `SignedData` and embedded X.509 certificate chains.
  - Evaluates three independent dimensions:
    1. **Cryptographic Integrity:** Recomputes SHA-1/SHA-256/SHA-384/SHA-512 over exact raw `/ByteRange` slices, checks CMS `messageDigest`, re-encodes `signedAttrs` with explicit `SET OF` tag (`0x31`, RFC 5652 §5.4), and verifies RSA PKCS#1 v1.5 (including generic `rsaEncryption` OID), RSA-PSS, and ECDSA (P-256, P-384).
    2. **Document Coverage:** Classifies `/ByteRange` as `fullDocument`, `incrementalUpdatesAfterSigning`, or `invalidByteRange`.
    3. **Certificate Trust:** Delegated to `CertificateTrustProvider`. `WebTrustProvider` reports `selfSigned` / `unverifiedIssuer` explicitly and supports session-imported PEM root CAs (with direct and intermediate issuer signature verification).
- **Interactive AcroForms (`orb-pdf::forms`):**
  - Resolves `/AcroForm` field hierarchies with inherited `/FT`, `/Ff`, `/V`, `/DV`, `/Opt`, `/MaxLen`, and `/AP /N` checkbox/radio export states.
  - Projects PDF bottom-left `/Rect` coordinates through `/CropBox` and `/Rotate` (0°/90°/180°/270°) into CSS viewport pixels.
  - **Incremental-Update Export:** Appends updated field/widget objects, regenerated `/AP /N` appearance XObject streams (Type1 Helvetica / ZapfDingbats / vector radio marks), and either a classic `xref`+`trailer` or an uncompressed PDF 1.5+ `/Type /XRef` stream (ISO 32000-1 §7.5.8.4) matching the prior xref format. Original bytes remain untouched, preserving prior signature revisions; editing a signed PDF surfaces `PDF_SIGNED_WITH_FORMS` warnings.

### 3.2 Microsoft Word (`.docx` and `.doc`)

- **`.docx` (`orb-docx`):** Parses `docProps/core.xml`, `word/_rels/document.xml.rels`, `word/styles.xml`, `word/numbering.xml`, `word/footnotes.xml`, `word/media/*`, and `word/document.xml` into `orb-ir`. Emits diagnostics `DOCX_MACROS_IGNORED`, `DOCX_SMARTART_SIMPLIFIED`, and `DOCX_TRACKED_CHANGES`. Serializes `orb-ir` (including embedded images and hyperlinks) back to standards-compliant OOXML.
- **`.doc` (`orb-doc`):** Opens OLE2 containers via `cfb`, parses `\x05SummaryInformation`, reads `FibBase` (`fEncrypted`, `fWhichTblStm`), `FibRgLw97` (`ccpText`), `FibRgFcLcb97`, `STSH`, `Clx` piece tables (`PlcPcd` for CP1252 compressed and UTF-16LE pieces), `PlcfBteChpx`/`PlcfBtePapx` 512-byte FKP pages, tables (`\x07`), and `HYPERLINK` fields (`\x13`/`\x14`/`\x15`) into `orb-ir`. Emits `DOC_LEGACY_BINARY` and `DOC_PRE_97_FORMAT` diagnostics; rejects encrypted `.doc` files explicitly.
- **Non-Destructive Editing:** Edits mutate `orb-ir` and export cleanly as new `.docx` or `.md` files without stripping proprietary extensions from original archives.

### 3.3 Markdown (`orb-md`)

- Parses CommonMark + GFM (`ENABLE_TABLES`, `ENABLE_FOOTNOTES`, `ENABLE_STRIKETHROUGH`, `ENABLE_TASKLISTS`, `ENABLE_HEADING_ATTRIBUTES`) into `orb-ir` and serializes `orb-ir` back to Markdown.
- Supports `Reading`, `Split`, and `Source` modes with debounced live WASM preview, formatting snippets, and `.md` / `.docx` export.

## 4. Theming Contract

### 4.1 6-Color Palette Invariant

Every theme defines **at most six unique base colors** (`SixColorPalette`):

1. `--orb-base` — Primary canvas / surface background
2. `--orb-ink` — Primary text and foreground strokes
3. `--orb-accent` — Interactive focus, active controls, links, selection
4. `--orb-positive` — Valid signatures, success states
5. `--orb-warning` — Post-signing modifications, legacy diagnostics, unsaved edits
6. `--orb-danger` — Tampered signatures, errors, destructive actions

All derived UI tones (elevated surfaces, backdrop stage, borders, muted text, soft status tints, shadows) are computed exclusively via `color-mix(in oklch, ...)` fades between these six tokens. Enforced automatically by `web/tests/theme.test.ts` (zero hardcoded hex/RGB/HSL/OKLCH literals allowed outside `web/src/theme/themes.ts`).

### 4.2 Modes and Extensibility

- Exposes `system`, `light`, and `dark` modes (`prefers-color-scheme` + `localStorage`).
- `ThemeRegistry.register(ThemeDefinition)` allows custom 6-color themes to plug in without component or CSS edits; `data-orb-scheme` (`light` | `dark`) elevates document paper cleanly above stage backdrop for any light or dark theme, and transitions are suppressed for one layout frame during theme switches to avoid intermediate color flashes.
- PDF canvases preserve original document ink/paper fidelity; app chrome, Markdown/Word sheets, and interactive form overlays follow the active theme.

## 5. Dependency Budget

All dependencies are AGPL-3.0-compatible (MIT / Apache-2.0 / BSD):

- **Rust Core:** `serde`, `thiserror`, `base64`, `pulldown-cmark` (no default features), `zip` (deflate only), `quick-xml`, `cfb`, `lopdf` (no default features), RustCrypto (`cms`, `x509-cert`, `der`, `const-oid`, `spki`, `sha1`, `sha2`, `rsa`, `p256`, `p384`, `ecdsa`, `signature`), `rand_chacha`.
- **Rust WASM Boundary (`orb-wasm` only):** `wasm-bindgen`, `js-sys`, `serde-wasm-bindgen`, `serde_json`, and target-scoped `getrandom` (`js`/`wasm_js`).
- **TypeScript Runtime:** `react`, `react-dom`, `pdfjs-dist` (isolated behind `PdfPageRenderer`).
- **TypeScript Dev/Build:** `typescript`, `vite`, `@vitejs/plugin-react`, `vitest`.
- **Excluded:** CSS frameworks, UI component kits, external state managers, icon libraries, runtime CDN requests.

## 6. Static Web Hosting Constraints

- `pnpm build` runs `scripts/build-wasm.sh` followed by `tsc --noEmit && vite build`, emitting a self-contained static `web/dist/` directory (`index.html`, JS/CSS bundles, `orb.worker-*.js`, `orb_wasm_bg-*.wasm`, local `pdf.worker.min-*.mjs`) using relative paths (`base: './'`).
- Verified with zero outbound network requests and full offline operation once static assets are loaded.

## 7. Future Native Desktop Portability (Windows & macOS)

Core crates (`orb-ir`, `orb-md`, `orb-docx`, `orb-doc`, `orb-pdf`, `orb-engine`) contain zero browser or WASM dependencies and operate on byte slices / `Read + Seek`:

1. **Pure Native Rust UI:** GPU-accelerated Rust UI (`GPUI` or `iced`) + native `PDFium` (`pdfium-render`) or `hayro`/`vello` + OS certificate stores (`rustls-platform-verifier`).
2. **Platform-Native Thin Shell + Rust FFI:** Swift/AppKit (`PDFKit`/Metal) on macOS and WinUI 3/Direct2D on Windows calling `orb-engine` via `UniFFI` or C ABI for native print pipelines, accessibility, and hardware/OS keychain signing.
3. **WebView Bridge (`Tauri` / `wry`):** Reuses the static React UI while swapping `orb-wasm` for direct native `orb-engine` IPC, local filesystem IO, and OS certificate trust stores.

### Portability Contracts Enforced

- **Renderer boundary:** `PdfPageRenderer` isolates page rasterization from `orb-pdf` forms and signatures.
- **Trust boundary:** `CertificateTrustProvider` decouples CA chain/OS store trust from CMS/byte-range verification.
- **Theme schema:** The 6-color `ThemeDefinition` JSON contract maps 1:1 between CSS `color-mix()` and native color interpolation.

## 8. Build and Verification

- **Rust (`cargo test --workspace`):** Verifies `orb-ir` edit operations, `orb-md` GFM round-trips, `orb-docx` read/write round-trips (with embedded media), `orb-doc` Word 97–2003 binary decoding & misnamed RTF detection, `orb-pdf` ECDSA P-256 & RSA-2048 signature verification, 1-byte tamper detection, PEM root trust verification, AcroForm incremental-update round-trips, and `orb-engine` magic-byte detection + `camelCase` JSON contracts.
- **Frontend (`pnpm test`):** Enforces the `<= 6` base color invariant, `ThemeRegistry` custom theme registration, zero hardcoded color literals across `web/src/`, and PDF coordinate projection across rotations.
- **Static Build & Offline E2E (`pnpm build`):** Verified by serving `web/dist/` over a plain static HTTP server in headless Chromium with all external network requests aborted — exercising PDF canvas rendering, signature verification, session PEM trust, AcroForm editing + incremental-update export, tampered PDF detection, `.docx` inline IR editing + export, `.doc` binary viewing, live Markdown split editing, and `System`/`Light`/`Dark` theme switching with zero errors.
