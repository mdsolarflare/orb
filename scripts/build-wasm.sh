#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/web/src/wasm"

mkdir -p "$OUT_DIR"

cargo build \
  --manifest-path "$ROOT_DIR/Cargo.toml" \
  -p orb-wasm \
  --target wasm32-unknown-unknown \
  --release

wasm-bindgen \
  --target web \
  --out-dir "$OUT_DIR" \
  "$ROOT_DIR/target/wasm32-unknown-unknown/release/orb_wasm.wasm"

echo "Built orb-wasm bindings into $OUT_DIR"
