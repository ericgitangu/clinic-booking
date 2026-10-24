#!/usr/bin/env bash
# Pre-render every diagram source to SVG. htmlLabels is false at the top level of the config so
# the SVGs carry plain <text> (no foreignObject), which WeasyPrint draws. Edge-label backgrounds
# are made opaque afterwards so a line never runs through a label. The ER diagram uses its own
# config with a larger font so its attribute text prints at 6.5 pt or more.
set -euo pipefail
cd "$(dirname "$0")"
for f in architecture er state booking-race; do
  cfg=mermaid.config.json
  [ -f "$f.config.json" ] && cfg="$f.config.json"
  # The design sources in this folder are .md; older checkouts used .mmd. Accept either.
  src="$f.mmd"
  [ -f "$src" ] || src="$f.md"
  [ -f "$src" ] || { echo "missing diagram source: $f.mmd or $f.md" >&2; exit 1; }
  if [ -f "$f.svg" ] && [ "$f.svg" -nt "$src" ]; then
    echo "fresh: $f.svg"
    continue
  fi
  npx -y @mermaid-js/mermaid-cli@11.4.2 -i "$src" -o "$f.svg" -c "$cfg" -b white >/dev/null
  sed -i '' -e 's/edgeLabel rect{opacity:0.5;/edgeLabel rect{opacity:1;/g' "$f.svg"
  # Mermaid's built-in stacks name trebuchet ms and verdana; pin every text run to the body face.
  sed -i '' -E -e 's/"trebuchet ms", *verdana, *arial, *sans-serif/"Helvetica Neue", Helvetica, Arial, sans-serif/g' \
    -e 's/trebuchet ms, *verdana, *arial/"Helvetica Neue", Helvetica, Arial/g' "$f.svg"
  if [ "$f" = er ]; then sed -i '' -e 's/\.edgeLabel \.label{fill:#243a8c;font-size:14px;}/.edgeLabel .label{fill:#243a8c;font-size:19px;}/' "$f.svg"; fi
  if grep -q foreignObject "$f.svg"; then echo "foreignObject in $f.svg" >&2; exit 1; fi
  if grep -qi -e verdana -e trebuchet -e apple-system "$f.svg"; then echo "stray font in $f.svg" >&2; exit 1; fi
done
echo ok
