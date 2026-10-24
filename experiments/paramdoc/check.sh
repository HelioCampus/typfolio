#!/usr/bin/env bash
# Proves the paramdoc experiment still works: the handover's manual procedure as one script.
#
#   ./check.sh            # everything, fuzzing 100 samples per fixture
#   FUZZ=20 ./check.sh    # quicker
#
# Needs: Rust (cargo), Node 22.18+, `npm ci` and `npm run build` at the repository root (inspectPdf, Playwright),
# poppler (pdftoppm, pdftotext) and veraPDF on PATH. Missing optional tools are reported as SKIP; every other
# failure fails the script. With DEMO_URL set to a running pretext-hybrid dev server, the demo page is driven too.
set -u
cd "$(dirname "$0")"
FUZZ="${FUZZ:-100}"
B=../../.build/paramdoc
PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf '  SKIP  %s\n' "$1"; }
run()  { local what="$1"; shift; if "$@" > "$B/.last.log" 2>&1; then ok "$what"; else fail "$what"; sed 's/^/        /' "$B/.last.log" | tail -15; fi; }
have() { command -v "$1" > /dev/null 2>&1; }
fonts_match() { for font in "documents/$1"/fonts/*; do cmp -s "$font" "$B/$1/fonts/$(basename "$font")" || return 1; done; }
NODE=(node --disable-warning=ExperimentalWarning --experimental-strip-types)
mkdir -p "$B"

echo "1. Build"
run "cargo build (export, runtime)" cargo build -q -p paramdoc-export -p paramdoc-runtime

echo "2. Export, isolation check and Typst reference ($FUZZ fuzz samples per fixture)"
for f in certificate policies transcript report; do
  run "export $f: 0 leaks" cargo run -q -p paramdoc-export -- fixtures/$f --fuzz "$FUZZ" --reference fixtures/$f/data.json
done
if cargo run -q -p paramdoc-export -- fixtures/leak --fuzz 20 > "$B/.last.log" 2>&1; then fail "export leak: the auto-width slot was not detected"; else ok "export leak: detected (exit 1)"; fi
for dir in documents/*/; do
  f=$(basename "$dir")
  [ -f "$B/$f/doc.json" ] || cargo run -q -p paramdoc-export -- "fixtures/$f" --fuzz 1 > /dev/null 2>&1
  if cmp -s "$B/$f/doc.json" "documents/$f/doc.json" && fonts_match "$f"; then ok "documents/$f matches a fresh export"
  else fail "documents/$f is stale: run ./export-documents.sh $f"; fi
done

echo "3. Runtimes against Typst's layout of the same data, and TypeScript against Rust"
for f in certificate policies transcript report; do
  run "rust $f == Typst" cargo run -q -p paramdoc-runtime -- "$B/$f" --data fixtures/$f/data.json --out "$B/$f/runtime.pdf" --expect "$B/$f/reference.json"
  run "ts   $f == Typst == rust" "${NODE[@]}" ts/cli.ts "$B/$f" --data fixtures/$f/data.json --out "$B/$f/runtime-ts.pdf" --expect "$B/$f/reference.json" --expect-rust "$B/$f/runtime.trace.json"
done
run "rust transcript, 42 rows, 2 pages" cargo run -q -p paramdoc-runtime -- "$B/transcript" --data fixtures/transcript/data-long.json --out "$B/transcript/long.pdf"
run "ts   transcript, 42 rows == rust" "${NODE[@]}" ts/cli.ts "$B/transcript" --data fixtures/transcript/data-long.json --out "$B/transcript/long-ts.pdf" --expect-rust "$B/transcript/long.trace.json"
run "rust policies, long values" cargo run -q -p paramdoc-runtime -- "$B/policies" --data fixtures/policies/data-long.json --out "$B/policies/long.pdf"

echo "4. Pixels at 150 dpi against Typst (tolerance: 1 pixel, the report's known one)"
if have pdftoppm; then
  for f in certificate policies transcript report; do
    for v in runtime runtime-ts; do
      pdftoppm -r 150 -singlefile "$B/$f/$v.pdf" "$B/$f/.px-$v" && pdftoppm -r 150 -singlefile "$B/$f/reference.pdf" "$B/$f/.px-reference"
      run "$f $v vs Typst" node notes/bench/ppmdiff.mjs "$B/$f/.px-$v.ppm" "$B/$f/.px-reference.ppm" 1
    done
  done
else skip "pdftoppm not on PATH (poppler)"; fi

echo "5. Text extraction: Rust and TypeScript PDFs read the same"
if have pdftotext; then
  for f in certificate policies transcript report; do
    if diff <(pdftotext -layout "$B/$f/runtime.pdf" -) <(pdftotext -layout "$B/$f/runtime-ts.pdf" -) > "$B/.last.log"; then ok "$f"; else fail "$f"; cat "$B/.last.log"; fi
  done
else skip "pdftotext not on PATH (poppler)"; fi

echo "6. Structure (inspectPdf from @typfolio/dev-tools)"
if [ -f ../../packages/dev-tools/dist/pdf.js ]; then
  run "inspect" node notes/bench/inspect.mjs "$B/transcript/long.pdf" "$B/report/runtime.pdf" "$B/report/runtime-ts.pdf"
  grep -E '^\S|pages|roles' "$B/.last.log" | sed 's/^/        /'
else skip "packages/dev-tools/dist is not built (npm run build at the repository root)"; fi

echo "7. PDF/UA-1 conformance (veraPDF)"
if have verapdf; then
  for p in certificate/runtime certificate/runtime-ts policies/runtime policies/long transcript/runtime transcript/runtime-ts transcript/long transcript/long-ts report/runtime report/runtime-ts; do
    if verapdf --flavour ua1 --format text "$B/$p.pdf" > "$B/.last.log" 2>&1 && head -1 "$B/.last.log" | grep -q '^PASS'; then ok "$p"; else fail "$p"; grep -v '^PASS' "$B/.last.log" | head -20 | sed 's/^/        /'; fi
  done
else skip "verapdf not on PATH (brew install verapdf)"; fi

echo "8. Demo page (DEMO_URL=http://127.0.0.1:4190 ./check.sh, with the pretext-hybrid dev server running)"
if [ -n "${DEMO_URL:-}" ]; then
  if [ -d ../../node_modules/playwright ]; then
    if node notes/bench/bench-browser.mjs "$DEMO_URL/performance?engine=paramdoc&workers=4&count=200&autostart" > "$B/.last.log" 2>&1 && grep -q 'per second' "$B/.last.log" && ! grep -q 'failed' "$B/.last.log"; then ok "paramdoc engine: $(grep 'per second' "$B/.last.log" | tail -1)"
    else fail "paramdoc engine on the demo page"; sed 's/^/        /' "$B/.last.log" | tail -8; fi
  else skip "playwright is not installed at the repository root"; fi
else skip "DEMO_URL not set"; fi

# The rasterised pages are large and only needed during the run.
rm -f "$B"/*/.px-*.ppm "$B/.last.log"
echo
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
