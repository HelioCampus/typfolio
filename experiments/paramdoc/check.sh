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
# Wrapping slots: a Typst reference per data case of `wrap`, and references for random samples of `wrapfuzz`.
refs=(--reference fixtures/wrap/data.json); for d in fixtures/wrap/data-*.json; do case $d in *error*) ;; *) refs+=(--reference "$d");; esac; done
run "export wrap: 0 leaks, a Typst reference per data case" cargo run -q -p paramdoc-export -- fixtures/wrap --fuzz "$FUZZ" "${refs[@]}"
SAMPLES=$(( FUZZ < 40 ? FUZZ : 40 ))
run "export wrapfuzz: 0 leaks, Typst references for $SAMPLES random samples" cargo run -q -p paramdoc-export -- fixtures/wrapfuzz --fuzz "$FUZZ" --fuzz-references "$SAMPLES" --reference fixtures/wrapfuzz/data.json
wrap_cases=(data); for d in fixtures/wrap/data-*.json; do case $d in *error*|*overflow*) ;; *) wrap_cases+=("$(basename "$d" .json)");; esac; done
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
for c in "${wrap_cases[@]}"; do
  ref=reference; [ "$c" = data ] || ref=reference-$c
  run "rust wrap/$c == Typst" cargo run -q -p paramdoc-runtime -- "$B/wrap" --data "fixtures/wrap/$c.json" --out "$B/wrap/$c.pdf" --expect "$B/wrap/$ref.json"
  run "ts   wrap/$c == Typst == rust" "${NODE[@]}" ts/cli.ts "$B/wrap" --data "fixtures/wrap/$c.json" --out "$B/wrap/$c-ts.pdf" --expect "$B/wrap/$ref.json" --expect-rust "$B/wrap/$c.trace.json"
done
run "rust wrap/data-overflow: ellipsis and clip policies" cargo run -q -p paramdoc-runtime -- "$B/wrap" --data fixtures/wrap/data-overflow.json --out "$B/wrap/data-overflow.pdf"
run "ts   wrap/data-overflow == rust" "${NODE[@]}" ts/cli.ts "$B/wrap" --data fixtures/wrap/data-overflow.json --out "$B/wrap/data-overflow-ts.pdf" --expect-rust "$B/wrap/data-overflow.trace.json"
if cargo run -q -p paramdoc-runtime -- "$B/wrap" --data fixtures/wrap/data-error.json --out "$B/wrap/data-error.pdf" > "$B/.last.log" 2>&1; then fail "rust wrap/data-error: an overflowing \`error\` slot was accepted"; else ok "rust wrap/data-error: refused ($(grep -o 'needs [0-9]* lines but the slot holds [0-9]*' "$B/.last.log" | head -1))"; fi
if "${NODE[@]}" ts/cli.ts "$B/wrap" --data fixtures/wrap/data-error.json --out "$B/wrap/data-error-ts.pdf" > "$B/.last.log" 2>&1; then fail "ts   wrap/data-error: an overflowing \`error\` slot was accepted"; else ok "ts   wrap/data-error: refused"; fi
wf_fail=0
for i in $(seq 0 $((SAMPLES - 1))); do
  cargo run -q -p paramdoc-runtime -- "$B/wrapfuzz" --data "$B/wrapfuzz/fuzz-$i.json" --out "$B/wrapfuzz/fuzz-$i.pdf" --expect "$B/wrapfuzz/reference-fuzz-$i.json" > "$B/.last.log" 2>&1 \
    || { wf_fail=$((wf_fail + 1)); echo "        rust sample $i: $(grep -v '^filled' "$B/.last.log" | head -1 | cut -c1-160)"; }
  "${NODE[@]}" ts/cli.ts "$B/wrapfuzz" --data "$B/wrapfuzz/fuzz-$i.json" --out "$B/wrapfuzz/fuzz-$i-ts.pdf" --expect "$B/wrapfuzz/reference-fuzz-$i.json" --expect-rust "$B/wrapfuzz/fuzz-$i.trace.json" > "$B/.last.log" 2>&1 \
    || { wf_fail=$((wf_fail + 1)); echo "        ts   sample $i: $(grep -v '^filled' "$B/.last.log" | head -1 | cut -c1-160)"; }
done
if [ "$wf_fail" -eq 0 ]; then ok "wrapfuzz: both runtimes == Typst on $SAMPLES random samples"; else fail "wrapfuzz: $wf_fail of $((SAMPLES * 2)) runs differ from Typst"; fi

echo "4. Pixels at 150 dpi against Typst (tolerance: 1 pixel, the report's known one)"
if have pdftoppm; then
  for f in certificate policies transcript report; do
    for v in runtime runtime-ts; do
      pdftoppm -r 150 -singlefile "$B/$f/$v.pdf" "$B/$f/.px-$v" && pdftoppm -r 150 -singlefile "$B/$f/reference.pdf" "$B/$f/.px-reference"
      run "$f $v vs Typst" node notes/bench/ppmdiff.mjs "$B/$f/.px-$v.ppm" "$B/$f/.px-reference.ppm" 1
    done
  done
  # Wrapping slots: every data case and every random sample, both runtimes, 0 pixels of tolerance.
  px() { pdftoppm -r 150 -singlefile "$1" "$B/.px-a" && pdftoppm -r 150 -singlefile "$2" "$B/.px-b" && node notes/bench/ppmdiff.mjs "$B/.px-a.ppm" "$B/.px-b.ppm" 0 > "$B/.last.log" 2>&1; }
  px_fail=0
  for c in "${wrap_cases[@]}"; do ref=reference; [ "$c" = data ] || ref=reference-$c
    for v in "" -ts; do px "$B/wrap/$c$v.pdf" "$B/wrap/$ref.pdf" || { px_fail=$((px_fail + 1)); echo "        wrap/$c$v: $(tail -1 "$B/.last.log")"; }; done
  done
  if [ "$px_fail" -eq 0 ]; then ok "wrap: every data case pixel-identical to Typst, both runtimes"; else fail "wrap: $px_fail renders differ from Typst"; fi
  px_fail=0
  for i in $(seq 0 $((SAMPLES - 1))); do for v in "" -ts; do px "$B/wrapfuzz/fuzz-$i$v.pdf" "$B/wrapfuzz/reference-fuzz-$i.pdf" || { px_fail=$((px_fail + 1)); echo "        wrapfuzz/fuzz-$i$v: $(tail -1 "$B/.last.log")"; }; done; done
  if [ "$px_fail" -eq 0 ]; then ok "wrapfuzz: $SAMPLES random samples pixel-identical to Typst, both runtimes"; else fail "wrapfuzz: $px_fail renders differ from Typst"; fi
else skip "pdftoppm not on PATH (poppler)"; fi

echo "5. Text extraction: Rust and TypeScript PDFs read the same"
if have pdftotext; then
  for f in certificate policies transcript report; do
    if diff <(pdftotext -layout "$B/$f/runtime.pdf" -) <(pdftotext -layout "$B/$f/runtime-ts.pdf" -) > "$B/.last.log"; then ok "$f"; else fail "$f"; cat "$B/.last.log"; fi
  done
  for c in data data-overflow; do
    if diff <(pdftotext -layout "$B/wrap/$c.pdf" -) <(pdftotext -layout "$B/wrap/$c-ts.pdf" -) > "$B/.last.log"; then ok "wrap/$c"; else fail "wrap/$c"; cat "$B/.last.log"; fi
  done
  if [ "$(pdftotext -layout "$B/wrap/data-overflow.pdf" - | grep -c '…')" = 2 ]; then ok "wrap/data-overflow: two ellipsis lines, as the policies say"; else fail "wrap/data-overflow: expected two ellipsis lines"; fi
else skip "pdftotext not on PATH (poppler)"; fi

echo "6. Structure (inspectPdf from @typfolio/dev-tools)"
if [ -f ../../packages/dev-tools/dist/pdf.js ]; then
  run "inspect" node notes/bench/inspect.mjs "$B/transcript/long.pdf" "$B/report/runtime.pdf" "$B/report/runtime-ts.pdf"
  grep -E '^\S|pages|roles' "$B/.last.log" | sed 's/^/        /'
else skip "packages/dev-tools/dist is not built (npm run build at the repository root)"; fi

echo "7. PDF/UA-1 conformance (veraPDF)"
if have verapdf; then
  for p in certificate/runtime certificate/runtime-ts policies/runtime policies/long transcript/runtime transcript/runtime-ts transcript/long transcript/long-ts report/runtime report/runtime-ts wrap/data wrap/data-ts wrap/data-overflow wrap/data-overflow-ts wrapfuzz/fuzz-0 wrapfuzz/fuzz-0-ts; do
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
rm -f "$B"/*/.px-*.ppm "$B"/.px-*.ppm "$B/.last.log"
echo
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
