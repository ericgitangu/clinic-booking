#!/usr/bin/env bash
# Renders apps/booking/src/content/architecture.mmd to the two SVGs the booking landing page serves.
# A one-off authoring tool: Mermaid is not a dependency of any app, and nothing renders it in the
# browser. Needs Node and network access (npx fetches mermaid-cli and a headless Chrome).
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo '{"args":["--no-sandbox"]}' > "$tmp/puppeteer.json"
for theme in light dark; do
  t=default; [ "$theme" = dark ] && t=dark
  # htmlLabels must be false at the top level (a flowchart-level setting is ignored): it makes
  # labels plain SVG text instead of foreignObject boxes that clip when the font differs.
  printf '{"theme":"%s","htmlLabels":false,"flowchart":{"htmlLabels":false,"curve":"basis"},"themeVariables":{"fontFamily":"system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif","fontSize":"18px"}}' "$t" > "$tmp/$theme.json"
  npx -y @mermaid-js/mermaid-cli@11.4.2 -p "$tmp/puppeteer.json" -c "$tmp/$theme.json" -b transparent \
    -i apps/booking/src/content/architecture.mmd -o "apps/booking/public/architecture-$theme.svg"
done

# mermaid-cli writes width="100%", which gives an <img> no intrinsic size. Give the root element the
# size from its own viewBox.
python3 - <<'PY'
import re
for theme in ("light", "dark"):
    p = f"apps/booking/public/architecture-{theme}.svg"
    s = open(p).read()
    m = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', s)
    w, h = round(float(m.group(1))), round(float(m.group(2)))
    s = s.replace('width="100%"', f'width="{w}" height="{h}"', 1)
    open(p, "w").write(s)
PY
