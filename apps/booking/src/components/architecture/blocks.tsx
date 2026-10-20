import { DIAGRAMS } from "@/content/architecture/diagrams";
import { SCREENSHOTS } from "@/content/architecture/screenshots";
import type { Block } from "@/content/architecture/types";
import { highlight } from "./highlight";
import { Inline, LINK_CLASS } from "./inline";

const TOKEN_CLASS: Record<string, string> = {
  plain: "",
  comment: "italic text-muted-foreground",
  string: "text-primary",
  flag: "font-semibold",
  key: "font-semibold text-primary",
  keyword: "font-semibold text-primary",
};

function Code({ block }: { block: Extract<Block, { t: "code" }> }) {
  return (
    <figure className="min-w-0">
      {block.caption ? (
        <figcaption className="mb-1.5 text-sm text-muted-foreground">
          {block.caption}
        </figcaption>
      ) : null}
      {/* A focusable scroll box: a long command scrolls inside it and never widens the page. */}
      <pre
        tabIndex={0}
        className="overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-sm leading-6 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <code>
          {highlight(block.lang, block.code.replace(/\n$/, "")).map((t, i) =>
            t.kind === "plain" ? (
              t.text
            ) : (
              <span key={i} className={TOKEN_CLASS[t.kind]}>
                {t.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </figure>
  );
}

function Table({ block }: { block: Extract<Block, { t: "table" }> }) {
  return (
    <div
      tabIndex={0}
      className="overflow-x-auto rounded-md border border-border focus-visible:outline-2 focus-visible:outline-ring"
    >
      <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
        <caption className="sr-only">{block.caption}</caption>
        <thead className="bg-muted">
          <tr>
            {block.head.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r} className="border-t border-border align-top">
              {row.map((cell, c) =>
                c === 0 ? (
                  <th
                    key={c}
                    scope="row"
                    className="px-3 py-2 font-medium break-words"
                  >
                    <Inline text={cell} />
                  </th>
                ) : (
                  <td key={c} className="px-3 py-2">
                    <Inline text={cell} />
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Diagram({ id }: { id: keyof typeof DIAGRAMS }) {
  const d = DIAGRAMS[id];
  return (
    <figure className="min-w-0">
      <div
        role="img"
        aria-label={d.label}
        tabIndex={0}
        className="overflow-x-auto rounded-md border border-border bg-card p-3 focus-visible:outline-2 focus-visible:outline-ring"
      >
        {/* Natural size up to 1200px, so the text stays readable; a narrower screen scrolls inside the box. */}
        <div style={{ minWidth: Math.min(d.width, 1200) }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- static files with explicit size; the fragments render outside the client tree, where next/image cannot */}
          <img
            src={d.light}
            alt=""
            width={d.width}
            height={d.height}
            loading="lazy"
            decoding="async"
            className="h-auto w-full dark:hidden"
          />
          {/* eslint-disable-next-line @next/next/no-img-element -- static files with explicit size; the fragments render outside the client tree, where next/image cannot */}
          <img
            src={d.dark}
            alt=""
            width={d.width}
            height={d.height}
            loading="lazy"
            decoding="async"
            className="hidden h-auto w-full dark:block"
          />
        </div>
      </div>
      <figcaption className="mt-2 text-sm text-muted-foreground">
        Scroll the diagram sideways on a small screen, or{" "}
        <a className={LINK_CLASS} href={d.light}>
          open it full size
        </a>{" "}
        to zoom. The text around it says the same.
      </figcaption>
    </figure>
  );
}

function Shot({ id }: { id: string }) {
  const s = SCREENSHOTS.find((x) => x.id === id);
  if (!s) return null;
  return (
    <figure className="min-w-0">
      {/* eslint-disable-next-line @next/next/no-img-element -- static files with explicit size; the fragments render outside the client tree, where next/image cannot */}
      <img
        src={s.light}
        alt={s.alt}
        width={s.width}
        height={s.height}
        loading="lazy"
        decoding="async"
        className="h-auto w-full rounded-md border border-border dark:hidden"
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- static files with explicit size; the fragments render outside the client tree, where next/image cannot */}
      <img
        src={s.dark}
        alt={s.alt}
        width={s.width}
        height={s.height}
        loading="lazy"
        decoding="async"
        className="hidden h-auto w-full rounded-md border border-border dark:block"
      />
      <figcaption className="mt-2 text-sm text-muted-foreground">
        {s.caption}
      </figcaption>
    </figure>
  );
}

export function Blocks({ blocks }: { blocks: readonly Block[] }) {
  return (
    <div className="space-y-4 leading-7">
      {blocks.map((b, i) => {
        switch (b.t) {
          case "p":
            return (
              <p key={i} className="max-w-[68ch]">
                <Inline text={b.text} />
              </p>
            );
          case "ul":
            return (
              <ul key={i} className="max-w-[68ch] list-disc space-y-1.5 pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inline text={it} />
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol
                key={i}
                className="max-w-[68ch] list-decimal space-y-2 pl-5 marker:font-semibold"
              >
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inline text={it} />
                  </li>
                ))}
              </ol>
            );
          case "note":
            return (
              <p
                key={i}
                className="max-w-[68ch] border-l-4 border-primary bg-muted px-4 py-3 text-base"
              >
                <Inline text={b.text} />
              </p>
            );
          case "facts":
            return (
              <dl
                key={i}
                className="grid max-w-[68ch] gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]"
              >
                {b.items.map((f) => (
                  <div key={f.label} className="contents">
                    <dt className="font-semibold">{f.label}</dt>
                    <dd>
                      <Inline text={f.value} />
                    </dd>
                  </div>
                ))}
              </dl>
            );
          case "code":
            return <Code key={i} block={b} />;
          case "table":
            return <Table key={i} block={b} />;
          case "diagram":
            return <Diagram key={i} id={b.id} />;
          case "image":
            return <Shot key={i} id={b.id} />;
        }
      })}
    </div>
  );
}
