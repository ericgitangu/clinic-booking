#!/usr/bin/env bash
# Renders apps/booking/diagrams/*.mmd to light and dark SVGs in apps/booking/public/diagrams/, the
# way scripts/render_architecture.sh does for the landing diagram. A one-off authoring tool: Mermaid
# is not a dependency of any app and nothing renders it in the browser. Needs Node and network access.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
out=apps/booking/public/diagrams
mkdir -p "$out"
echo '{"args":["--no-sandbox"]}' > "$tmp/puppeteer.json"
for theme in light dark; do
  t=default; [ "$theme" = dark ] && t=dark
  printf '{"theme":"%s","htmlLabels":false,"flowchart":{"htmlLabels":false,"curve":"basis"},"themeVariables":{"fontFamily":"system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif","fontSize":"16px"}}' "$t" > "$tmp/$theme.json"
  for src in apps/booking/diagrams/*.mmd; do
    name="$(basename "$src" .mmd)"
    npx -y @mermaid-js/mermaid-cli@11.4.2 -p "$tmp/puppeteer.json" -c "$tmp/$theme.json" -b transparent \
      -i "$src" -o "$out/$name-$theme.svg"
  done
done

# mermaid-cli writes width="100%", which gives an <img> no intrinsic size. Take it from the viewBox.
python3 - <<'PY'
import glob, re
for p in glob.glob("apps/booking/public/diagrams/*.svg"):
    s = open(p).read()
    m = re.search(r'viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"', s)
    w, h = round(float(m.group(1))), round(float(m.group(2)))
    s = s.replace('width="100%"', f'width="{w}" height="{h}"', 1)
    open(p, "w").write(s)
    print(p, w, h)
PY
