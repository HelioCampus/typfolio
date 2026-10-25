#!/usr/bin/env bash
# Proves the paramdoc experiment still works: the handover's manual procedure as one script.
#
#   ./check.sh            # everything, fuzzing 100 samples per fixture
#   FUZZ=20 ./check.sh    # quicker
#
# Needs: Rust (cargo), Node 22.18+, `npm ci` and `npm run build` at the repository root (inspectPdf, Playwright),
# poppler (pdftoppm, pdftotext) and veraPDF on PATH. Missing optional tools are reported as SKIP; every other
# failure fails the script. With DEMO_URL set to a running pretext-hybrid dev server, the demo page is driven too.
#
# Every fixture is exported with a Typst reference for `data.json` and for each of its other `data-*.json` cases
# (except `*-long*`, which paginate beyond the sample page, and the `wrap` overflow and error cases, which the
# runtimes handle by policy); both runtimes are then checked against every reference, by glyph positions and by
# pixels. `wrapfuzz` gets Typst references for random samples as well.
set -u
cd "$(dirname "$0")"
FUZZ="${FUZZ:-100}"
SAMPLES=$(( FUZZ < 40 ? FUZZ : 40 ))
B=../../.build/paramdoc
FIXTURES="certificate policies transcript report wrap"
PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf '  SKIP  %s\n' "$1"; }
run()  { local what="$1"; shift; if "$@" > "$B/.last.log" 2>&1; then ok "$what"; else fail "$what"; sed 's/^/        /' "$B/.last.log" | tail -15; fi; }
have() { command -v "$1" > /dev/null 2>&1; }
fonts_match() { for font in "documents/$1"/fonts/*; do cmp -s "$font" "$B/$1/fonts/$(basename "$font")" || return 1; done; }
# The extra data cases of a fixture that have a Typst reference: `data-<case>.json` → `<case>`.
cases() { for d in "fixtures/$1"/data-*.json; do [ -e "$d" ] || continue; case $d in *-long*|*error*|*overflow*) ;; *) basename "$d" .json | sed 's/^data-//';; esac; done; }
refs()  { printf -- '--reference fixtures/%s/data.json ' "$1"; for c in $(cases "$1"); do printf -- '--reference fixtures/%s/data-%s.json ' "$1" "$c"; done; }
px()    { pdftoppm -r 150 -singlefile "$1" "$B/.px-a" && pdftoppm -r 150 -singlefile "$2" "$B/.px-b" && node notes/bench/ppmdiff.mjs "$B/.px-a.ppm" "$B/.px-b.ppm" "$3" > "$B/.last.log" 2>&1; }
NODE=(node --disable-warning=ExperimentalWarning --experimental-strip-types)
mkdir -p "$B"

echo "1. Build"
run "cargo build (export, runtime)" cargo build -q -p paramdoc-export -p paramdoc-runtime

echo "2. Export, isolation check and Typst references ($FUZZ fuzz samples per fixture)"
for f in $FIXTURES; do
  run "export $f: 0 leaks, a Typst reference per data case" cargo run -q -p paramdoc-export -- "fixtures/$f" --fuzz "$FUZZ" $(refs "$f")
done
if cargo run -q -p paramdoc-export -- fixtures/leak --fuzz 20 > "$B/.last.log" 2>&1; then fail "export leak: the auto-width slot was not detected"; else ok "export leak: detected (exit 1)"; fi
run "export wrapfuzz: 0 leaks, Typst references for $SAMPLES random samples" cargo run -q -p paramdoc-export -- fixtures/wrapfuzz --fuzz "$FUZZ" --fuzz-references "$SAMPLES" --reference fixtures/wrapfuzz/data.json
for dir in documents/*/; do
  f=$(basename "$dir")
  [ -f "$B/$f/doc.json" ] || cargo run -q -p paramdoc-export -- "fixtures/$f" --fuzz 1 > /dev/null 2>&1
  if cmp -s "$B/$f/doc.json" "documents/$f/doc.json" && fonts_match "$f"; then ok "documents/$f matches a fresh export"
  else fail "documents/$f is stale: run ./export-documents.sh $f"; fi
done

echo "3. Runtimes against Typst's layout of the same data, and TypeScript against Rust"
for f in $FIXTURES; do
  run "rust $f == Typst" cargo run -q -p paramdoc-runtime -- "$B/$f" --data "fixtures/$f/data.json" --out "$B/$f/runtime.pdf" --expect "$B/$f/reference.json"
  run "ts   $f == Typst == rust" "${NODE[@]}" ts/cli.ts "$B/$f" --data "fixtures/$f/data.json" --out "$B/$f/runtime-ts.pdf" --expect "$B/$f/reference.json" --expect-rust "$B/$f/runtime.trace.json"
  for c in $(cases "$f"); do
    run "rust $f/$c == Typst" cargo run -q -p paramdoc-runtime -- "$B/$f" --data "fixtures/$f/data-$c.json" --out "$B/$f/$c.pdf" --expect "$B/$f/reference-data-$c.json"
    run "ts   $f/$c == Typst == rust" "${NODE[@]}" ts/cli.ts "$B/$f" --data "fixtures/$f/data-$c.json" --out "$B/$f/$c-ts.pdf" --expect "$B/$f/reference-data-$c.json" --expect-rust "$B/$f/$c.trace.json"
  done
done
run "rust transcript, 42 rows with one-to-three-line titles, paginated" cargo run -q -p paramdoc-runtime -- "$B/transcript" --data fixtures/transcript/data-long.json --out "$B/transcript/long.pdf"
run "ts   transcript, 42 rows == rust" "${NODE[@]}" ts/cli.ts "$B/transcript" --data fixtures/transcript/data-long.json --out "$B/transcript/long-ts.pdf" --expect-rust "$B/transcript/long.trace.json"
run "rust policies, long values" cargo run -q -p paramdoc-runtime -- "$B/policies" --data fixtures/policies/data-long.json --out "$B/policies/long.pdf"
run "rust wrap/overflow: ellipsis and clip policies" cargo run -q -p paramdoc-runtime -- "$B/wrap" --data fixtures/wrap/data-overflow.json --out "$B/wrap/overflow.pdf"
run "ts   wrap/overflow == rust" "${NODE[@]}" ts/cli.ts "$B/wrap" --data fixtures/wrap/data-overflow.json --out "$B/wrap/overflow-ts.pdf" --expect-rust "$B/wrap/overflow.trace.json"
if cargo run -q -p paramdoc-runtime -- "$B/wrap" --data fixtures/wrap/data-error.json --out "$B/wrap/error.pdf" > "$B/.last.log" 2>&1; then fail "rust wrap/error: an overflowing \`error\` slot was accepted"; else ok "rust wrap/error: refused ($(grep -o 'needs [0-9]* lines but the slot holds [0-9]*' "$B/.last.log" | head -1))"; fi
if "${NODE[@]}" ts/cli.ts "$B/wrap" --data fixtures/wrap/data-error.json --out "$B/wrap/error-ts.pdf" > "$B/.last.log" 2>&1; then fail "ts   wrap/error: an overflowing \`error\` slot was accepted"; else ok "ts   wrap/error: refused"; fi
wf_fail=0
for i in $(seq 0 $((SAMPLES - 1))); do
  cargo run -q -p paramdoc-runtime -- "$B/wrapfuzz" --data "$B/wrapfuzz/fuzz-$i.json" --out "$B/wrapfuzz/fuzz-$i.pdf" --expect "$B/wrapfuzz/reference-fuzz-$i.json" > "$B/.last.log" 2>&1 \
    || { wf_fail=$((wf_fail + 1)); echo "        rust sample $i: $(grep -v '^filled' "$B/.last.log" | head -1 | cut -c1-160)"; }
  "${NODE[@]}" ts/cli.ts "$B/wrapfuzz" --data "$B/wrapfuzz/fuzz-$i.json" --out "$B/wrapfuzz/fuzz-$i-ts.pdf" --expect "$B/wrapfuzz/reference-fuzz-$i.json" --expect-rust "$B/wrapfuzz/fuzz-$i.trace.json" > "$B/.last.log" 2>&1 \
    || { wf_fail=$((wf_fail + 1)); echo "        ts   sample $i: $(grep -v '^filled' "$B/.last.log" | head -1 | cut -c1-160)"; }
done
if [ "$wf_fail" -eq 0 ]; then ok "wrapfuzz: both runtimes == Typst on $SAMPLES random samples"; else fail "wrapfuzz: $wf_fail of $((SAMPLES * 2)) runs differ from Typst"; fi

echo "4. Pixels at 150 dpi against Typst (tolerance: 1 pixel, the report's known one; 0 for the extra cases)"
if have pdftoppm; then
  for f in $FIXTURES; do
    for v in runtime runtime-ts; do
      if px "$B/$f/$v.pdf" "$B/$f/reference.pdf" 1; then ok "$f $v vs Typst"; else fail "$f $v vs Typst"; tail -1 "$B/.last.log" | sed 's/^/        /'; fi
    done
    px_fail=0; n=0
    for c in $(cases "$f"); do for v in "" -ts; do n=$((n + 1)); px "$B/$f/$c$v.pdf" "$B/$f/reference-data-$c.pdf" 0 || { px_fail=$((px_fail + 1)); echo "        $f/$c$v: $(tail -1 "$B/.last.log")"; }; done; done
    if [ "$n" -gt 0 ]; then if [ "$px_fail" -eq 0 ]; then ok "$f: $((n / 2)) extra case(s) pixel-identical to Typst, both runtimes"; else fail "$f: $px_fail renders differ from Typst"; fi; fi
  done
  px_fail=0
  for i in $(seq 0 $((SAMPLES - 1))); do for v in "" -ts; do px "$B/wrapfuzz/fuzz-$i$v.pdf" "$B/wrapfuzz/reference-fuzz-$i.pdf" 0 || { px_fail=$((px_fail + 1)); echo "        wrapfuzz/fuzz-$i$v: $(tail -1 "$B/.last.log")"; }; done; done
  if [ "$px_fail" -eq 0 ]; then ok "wrapfuzz: $SAMPLES random samples pixel-identical to Typst, both runtimes"; else fail "wrapfuzz: $px_fail renders differ from Typst"; fi
else skip "pdftoppm not on PATH (poppler)"; fi

echo "5. Text extraction: Rust and TypeScript PDFs read the same"
if have pdftotext; then
  for f in $FIXTURES; do
    if diff <(pdftotext -layout "$B/$f/runtime.pdf" -) <(pdftotext -layout "$B/$f/runtime-ts.pdf" -) > "$B/.last.log"; then ok "$f"; else fail "$f"; cat "$B/.last.log"; fi
  done
  for p in transcript/long wrap/overflow; do
    if diff <(pdftotext -layout "$B/$p.pdf" -) <(pdftotext -layout "$B/$p-ts.pdf" -) > "$B/.last.log"; then ok "$p"; else fail "$p"; cat "$B/.last.log"; fi
  done
  if [ "$(pdftotext -layout "$B/wrap/overflow.pdf" - | grep -c '…')" = 2 ]; then ok "wrap/overflow: two ellipsis lines, as the policies say"; else fail "wrap/overflow: expected two ellipsis lines"; fi
  if [ "$(pdftotext -layout "$B/transcript/long.pdf" - | grep -c 'honours')" = 0 ] && [ "$(pdftotext -layout "$B/transcript/runtime.pdf" - | grep -c 'honours')" = 1 ]; then ok "transcript: the honours block appears only when the data says so"; else fail "transcript: the honours block is not picked by the data"; fi
else skip "pdftotext not on PATH (poppler)"; fi

echo "6. Structure (inspectPdf from @typfolio/dev-tools)"
if [ -f ../../packages/dev-tools/dist/pdf.js ]; then
  run "inspect" node notes/bench/inspect.mjs "$B/transcript/long.pdf" "$B/report/runtime.pdf" "$B/report/runtime-ts.pdf"
  grep -E '^\S|pages|roles' "$B/.last.log" | sed 's/^/        /'
else skip "packages/dev-tools/dist is not built (npm run build at the repository root)"; fi

echo "7. PDF/UA-1 conformance (veraPDF)"
if have verapdf; then
  list=""
  for f in $FIXTURES; do list="$list $f/runtime $f/runtime-ts"; done
  for p in $list policies/long transcript/long transcript/long-ts transcript/nohonours wrap/overflow wrap/overflow-ts wrapfuzz/fuzz-0 wrapfuzz/fuzz-0-ts; do
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
rm -f "${B:?}"/*/.px-*.ppm "${B:?}"/.px-*.ppm "${B:?}/.last.log"
echo
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
