// The sha256 of every inline script in a built HTML page, in the form a Content-Security-Policy
// script-src takes. Scripts with a src, and data blocks (type="application/json", ld+json), are not
// executed inline and are left out. Used by csp-hashes.mjs after `next build`, and tested.
import { createHash } from "node:crypto";

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

export function inlineScriptHashes(html) {
  const out = new Set();
  for (const [, attrs, body] of html.matchAll(SCRIPT)) {
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i
      .exec(attrs)?.[1]
      ?.toLowerCase();
    if (
      type &&
      !/^(text|application)\/(javascript|ecmascript)$|^module$/.test(type)
    )
      continue;
    if (body.trim() === "") continue;
    out.add(`'sha256-${createHash("sha256").update(body).digest("base64")}'`);
  }
  return [...out];
}

// Replaces each __INLINE_SCRIPT_HASHES:<page>__ token in a headers list with that page's hashes.
// `hashesOf(page)` returns the list or throws. Returns how many tokens were filled.
export function fillTokens(headers, hashesOf) {
  let filled = 0;
  for (const entry of headers)
    for (const h of entry.headers) {
      h.value = h.value.replace(
        /__INLINE_SCRIPT_HASHES:([A-Za-z0-9_-]+?)__/g,
        (_, page) => {
          filled++;
          const hashes = hashesOf(page);
          if (hashes.length === 0)
            throw new Error(`csp-hashes: ${page} has no inline script to hash`);
          return hashes.join(" ");
        },
      );
    }
  return filled;
}
