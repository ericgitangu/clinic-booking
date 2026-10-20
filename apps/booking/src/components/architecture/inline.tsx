import type { ReactNode } from "react";

// The three inline marks content strings may use: `code`, **bold** and [label](target). Anything
// else is literal text, and React escapes it, so a string can never inject markup.
const MARK = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

export const LINK_CLASS =
  "rounded-sm text-primary underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export type Mark =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "link"; text: string; href: string };

export function parseInline(src: string): Mark[] {
  const out: Mark[] = [];
  let last = 0;
  for (const m of src.matchAll(MARK)) {
    if (m.index > last)
      out.push({ kind: "text", text: src.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "bold", text: m[2] });
    else out.push({ kind: "link", text: m[3]!, href: m[4]! });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ kind: "text", text: src.slice(last) });
  return out;
}

/** Every link target in a string, for the link test. */
export const linkTargets = (src: string): string[] =>
  parseInline(src).flatMap((m) => (m.kind === "link" ? [m.href] : []));

export function Inline({ text }: { text: string }): ReactNode {
  return parseInline(text).map((m, i) => {
    switch (m.kind) {
      case "code":
        return (
          <code
            key={i}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.9em] break-words"
          >
            {m.text}
          </code>
        );
      case "bold":
        return <strong key={i}>{m.text}</strong>;
      case "link": {
        const external = /^https?:\/\//.test(m.href);
        return (
          <a
            key={i}
            href={m.href}
            className={LINK_CLASS}
            {...(external
              ? { target: "_blank", rel: "noopener noreferrer" }
              : {})}
          >
            {m.text}
            {external ? (
              <span className="sr-only"> (opens in a new tab)</span>
            ) : null}
          </a>
        );
      }
      default:
        return m.text;
    }
  });
}
