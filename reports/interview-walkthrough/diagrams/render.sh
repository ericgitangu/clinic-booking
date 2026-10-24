#!/usr/bin/env bash
# Extract every ```mermaid block of ../WALKTHROUGH.md into NN.mmd, then render each to SVG.
# htmlLabels is false (plain <text>, which WeasyPrint draws); edge-label backgrounds are made opaque;
# every text run is pinned to the body face. Same recipe as technical-design/diagrams/render.sh.
set -euo pipefail
cd "$(dirname "$0")"
rm -f [0-9][0-9].mmd [0-9][0-9].svg
python3 -I - <<'PY'
import re, pathlib
src = pathlib.Path("../WALKTHROUGH.md").read_text()
for i, m in enumerate(re.finditer(r"^```mermaid\n(.*?)^```$", src, re.S | re.M), 1):
    pathlib.Path(f"{i:02d}.mmd").write_text(m.group(1))
PY
for m in [0-9][0-9].mmd; do
  f="${m%.mmd}"; cfg=mermaid.config.json; [ -f "$f.config.json" ] && cfg="$f.config.json"
  npx -y @mermaid-js/mermaid-cli@11.4.2 -i "$f.mmd" -o "$f.svg" -c "$cfg" -b white >/dev/null
  sed -i '' -e 's/edgeLabel rect{opacity:0.5;/edgeLabel rect{opacity:1;/g' "$f.svg"
  sed -i '' -E -e 's/"trebuchet ms", *verdana, *arial, *sans-serif/"Helvetica Neue", Helvetica, Arial, sans-serif/g' \
    -e 's/trebuchet ms, *verdana, *arial/"Helvetica Neue", Helvetica, Arial/g' "$f.svg"
  sed -i '' -e 's/font-family="sans-serif"/font-family="Helvetica Neue, Helvetica, Arial, sans-serif"/g' "$f.svg"
  if grep -q foreignObject "$f.svg"; then echo "foreignObject in $f.svg" >&2; exit 1; fi
  if grep -qi -e verdana -e trebuchet -e apple-system "$f.svg"; then echo "stray font in $f.svg" >&2; exit 1; fi
done
echo ok
