#!/usr/bin/env bash
# Build the PDF: ./build.sh  (./build.sh submit is accepted as an alias and builds the same PDF)
# Then renders every page to check/page-NN.png for a visual check.
set -euo pipefail
cd "$(dirname "$0")"
case "${1:-}" in
  ""|submit) ;;
  *) echo "usage: $0 [submit]" >&2; exit 2 ;;
esac
bash diagrams/render.sh
python3 -I tools/prepare.py tdd.html .tdd.render.html
weasyprint --pdf-variant pdf/ua-1 .tdd.render.html "technical-design.pdf"
rm -f .tdd.render.html
mkdir -p check
rm -f check/page-*.png
pdftoppm -r 70 -png "technical-design.pdf" check/page
pdfinfo "technical-design.pdf" | grep -E 'Pages|Tagged'
