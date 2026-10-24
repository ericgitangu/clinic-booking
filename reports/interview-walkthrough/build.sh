#!/usr/bin/env bash
# Build the walkthrough HTML and PDF from WALKTHROUGH.md.
# Steps: extract mermaid blocks -> render SVG (same config and fixes as technical-design/diagrams/render.sh)
#        -> pandoc to HTML5 with TOC and syntax highlighting -> wrap with cover, inline CSS/SVG/images
#        -> weasyprint --pdf-variant pdf/ua-1 -> page images in check/.
set -euo pipefail
cd "$(dirname "$0")"
bash diagrams/render.sh
python3 -I assemble.py
weasyprint --pdf-variant pdf/ua-1 ".walk.render.html" "interview-walkthrough.pdf"
cp ".walk.render.html" "interview-walkthrough.html"
rm -f .walk.render.html .body.html
mkdir -p check
rm -f check/page-*.png
pdftoppm -r 60 -png "interview-walkthrough.pdf" check/page
pdfinfo "interview-walkthrough.pdf" | grep -E 'Pages|Tagged'
