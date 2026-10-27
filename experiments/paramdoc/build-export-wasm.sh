#!/usr/bin/env bash
# Builds the exporter library for wasm32 (the C ABI in export/src/lib.rs, `ffi`) with the workspace's release
# profile, in its own target directory so it does not block the native builds, and puts the artifact and its
# provenance into packages/paramdoc-export/generated/ (gitignored, shipped in the package).
#
#   ./build-export-wasm.sh            # build and install
#   ./build-export-wasm.sh --check    # build and fail if the artifact's hash differs from provenance.json
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
RUST=1.92.0
TARGET_DIR=../../.build/paramdoc-target-wasm
OUT=../../packages/paramdoc-export/generated
CARGO_TARGET_DIR=$TARGET_DIR cargo +$RUST rustc --release -p paramdoc-export --lib --crate-type cdylib --target wasm32-unknown-unknown
WASM=$TARGET_DIR/wasm32-unknown-unknown/release/paramdoc_export.wasm
SHA=$(shasum -a 256 "$WASM" | cut -d' ' -f1)
if [ "${1:-}" = "--check" ] && [ -f "$OUT/provenance.json" ]; then
  PINNED=$(grep -o '"wasmSha256": *"[0-9a-f]*"' "$OUT/provenance.json" | grep -o '[0-9a-f]\{64\}')
  [ "$SHA" = "$PINNED" ] || { echo "the build does not reproduce the pinned artifact: $SHA vs $PINNED"; exit 1; }
fi
mkdir -p "$OUT"
cp "$WASM" "$OUT/paramdoc_export.wasm"
TYPST=$(grep -o '^typst = "[0-9.]*"' export/Cargo.toml | grep -o '[0-9.]*')
cat > "$OUT/provenance.json" <<EOF
{
  "crate": "paramdoc-export",
  "source": "experiments/paramdoc/export",
  "commit": "$(git rev-parse HEAD)",
  "typst": "$TYPST",
  "rust": "$RUST",
  "target": "wasm32-unknown-unknown",
  "profile": "release",
  "crateType": "cdylib",
  "cargoProfile": { "optLevel": "s", "lto": true, "codegenUnits": 1, "panic": "abort", "strip": true },
  "wasmSha256": "$SHA",
  "bytes": $(wc -c < "$WASM" | tr -d ' ')
}
EOF
printf 'paramdoc_export.wasm: %s bytes, %s gzip, sha256 %s\n' "$(wc -c < "$WASM" | tr -d ' ')" "$(gzip -9c "$WASM" | wc -c | tr -d ' ')" "$SHA"
