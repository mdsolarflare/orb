# orb

A static, client-side document viewer and editor focused on long-term format compatibility, built with a modular Rust core (compiled to WebAssembly) and a React + TypeScript frontend.

See [SPEC.md](./SPEC.md) for the full technical specification.

## Supported Formats (Prototype)

- **PDF (`.pdf`)** — High-fidelity page viewing, selectable text, interactive AcroForm filling with spec-compliant incremental-update export, and pure-Rust CMS/PKCS#7 + X.509 digital signature verification.
- **Microsoft Word (`.docx` & legacy `.doc`)** — Pure-Rust OOXML and OLE2/CFB MS-DOC decoders into a canonical IR, inline block editing, and clean export to `.docx` or `.md`.
- **Markdown (`.md`)** — CommonMark + GFM viewer and live split-pane editor with `.md` and `.docx` export.

## Prerequisites

- Rust toolchain (`cargo`, `rustup target add wasm32-unknown-unknown`, `wasm-bindgen-cli` matching `Cargo.toml`)
- Node.js 22+ and `pnpm`

## Build & Test

```bash
# Run Rust workspace tests
cargo test --workspace

# Build WASM bindings + static web app into web/dist/
pnpm build

# Run frontend tests (including 6-color theme invariant check)
pnpm test

# Start local dev server (after pnpm build:wasm)
pnpm dev
```

The production output in `web/dist/` is 100% static (relative paths, zero backend server, zero outbound network requests).
