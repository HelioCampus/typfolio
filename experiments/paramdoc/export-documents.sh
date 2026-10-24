#!/usr/bin/env bash
# Exports the fixtures that demo pages load in the browser and checks in what a runtime needs: `doc.json` and
# the subset fonts, under documents/<fixture>/. Everything else the exporter writes (baseline and reference PDFs,
# fuzz samples) stays in .build/. Run it after changing a fixture, the dialect or the exporter.
#
#   ./export-documents.sh            # the report (the performance page's document)
#   ./export-documents.sh report transcript
set -eu
cd "$(dirname "$0")"
B=../../.build/paramdoc
for fixture in "${@:-report}"; do
  cargo run -q -p paramdoc-export -- "fixtures/$fixture" --fuzz "${FUZZ:-50}" > /dev/null
  rm -rf "documents/$fixture"
  mkdir -p "documents/$fixture/fonts"
  cp "$B/$fixture/doc.json" "documents/$fixture/doc.json"
  for file in $(node -e 'for (const f of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).fonts) console.log(f.file)' "$B/$fixture/doc.json"); do
    cp "$B/$fixture/fonts/$file" "documents/$fixture/fonts/$file"
  done
  printf '%s: %s and %s font(s), %s kB\n' "$fixture" "documents/$fixture/doc.json" "$(ls "documents/$fixture/fonts" | wc -l | tr -d ' ')" "$(du -sk "documents/$fixture" | cut -f1)"
done
