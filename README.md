# orb

A static, client-side document viewer and editor focused on long-term format compatibility, built with a modular Rust core (compiled to WebAssembly) and a React + TypeScript frontend.

See [SPEC.md](./SPEC.md) for the full technical specification.

## Supported Formats (Prototype)

- **PDF (`.pdf`)** — High-fidelity page viewing, selectable text, interactive AcroForm filling with spec-compliant incremental-update export, and pure-Rust CMS/PKCS#7 + X.509 digital signature verification.
- **Microsoft Word (`.docx` & legacy `.doc`)** — Pure-Rust OOXML and OLE2/CFB MS-DOC decoders into a canonical IR, inline block editing, and clean export to `.docx` or `.md`.
- **Markdown (`.md`)** — CommonMark + GFM viewer and live split-pane editor with `.md` and `.docx` export.

## Prerequisites

- Rust toolchain (`cargo`, `rustup`)
- Node.js 22+ and `pnpm`

Install the WASM target, matching `wasm-bindgen-cli` (version must match `wasm-bindgen` in `Cargo.toml`), and web dependencies:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
pnpm --dir web install
```

## Build & Test

### Build WASM Bindings

```sh
cargo build -p orb-wasm --target wasm32-unknown-unknown --release
wasm-bindgen --target web --out-dir web/src/wasm target/wasm32-unknown-unknown/release/orb_wasm.wasm
```

(Also available as `pnpm build:wasm`.)

### Build Static Web App

```sh
# Build the frontend into web/dist/ (requires WASM bindings built above)
pnpm --dir web build

# Or run both WASM and frontend builds together
pnpm build
```

### Run Tests

```sh
# Run Rust workspace tests
cargo test --workspace

# Run frontend tests (including 6-color theme invariant check)
pnpm test
```

### Run Locally

```sh
# Start Vite dev server (after building WASM bindings)
pnpm dev

# Or preview the static production build in web/dist/
pnpm --dir web preview
```

The production output in `web/dist/` is 100% static (relative paths, zero backend server, zero outbound network requests).
