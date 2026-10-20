"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Tab = { id: string; label: string };

// The tab bar is the only script on /architecture. The panels are rendered on the server, all of
// them, so the content is in the HTML for a crawler, a reader without JavaScript and a find-in-page.
// This component only chooses which panel is visible: it reads the address (a tab id, a card id or
// ?tab=), keeps the arrow keys and Home/End working, and opens a card when a link points at it.
// Without JavaScript a <noscript> rule shows every panel, one after the other.

const panelOf = (id: string) => document.getElementById(id);

function fromLocation(tabs: readonly Tab[]): {
  tab: string | null;
  target: HTMLElement | null;
} {
  const ids = new Set(tabs.map((t) => t.id));
  let hash = "";
  try {
    hash = decodeURIComponent(window.location.hash.slice(1));
  } catch {
    hash = "";
  }
  if (hash && ids.has(hash)) return { tab: hash, target: null };
  if (hash) {
    const el = document.getElementById(hash);
    const panel = el?.closest<HTMLElement>('[role="tabpanel"]');
    if (el && panel && ids.has(panel.id)) return { tab: panel.id, target: el };
  }
  const q = new URLSearchParams(window.location.search).get("tab");
  if (q && ids.has(q)) return { tab: q, target: null };
  return { tab: null, target: null };
}

export function TabBar({ tabs }: { tabs: readonly Tab[] }) {
  const [active, setActive] = useState(tabs[0]!.id);
  const [expanded, setExpanded] = useState(false);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Show the active panel, hide the others. The panels belong to the server render, so this sets
  // the attribute directly instead of passing the content through a client component.
  useEffect(() => {
    for (const t of tabs) {
      const p = panelOf(t.id);
      if (p) p.toggleAttribute("data-off", t.id !== active);
    }
    setExpanded(false);
  }, [active, tabs]);

  const follow = useCallback(() => {
    const { tab, target } = fromLocation(tabs);
    if (tab) setActive(tab);
    if (target) {
      if (target instanceof HTMLDetailsElement) target.open = true;
      // The panel is shown by the effect above; scroll once it has.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => target.scrollIntoView({ block: "start" })),
      );
    }
  }, [tabs]);

  useEffect(() => {
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [follow]);

  const select = (id: string, focus: boolean) => {
    setActive(id);
    const url = new URL(window.location.href);
    url.searchParams.delete("tab");
    url.hash = id;
    window.history.replaceState(null, "", url);
    if (focus) refs.current[id]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const last = tabs.length - 1;
    const next =
      e.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : e.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    select(tabs[next]!.id, true);
  };

  const toggleAll = () => {
    const open = !expanded;
    panelOf(active)
      ?.querySelectorAll<HTMLDetailsElement>("details[data-card]")
      .forEach((d) => {
        d.open = open;
      });
    setExpanded(open);
  };

  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-border">
      <div
        role="tablist"
        aria-label="Architecture sections"
        className="-mb-px flex flex-wrap gap-x-1"
      >
        {tabs.map((t, i) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[t.id] = el;
              }}
              role="tab"
              type="button"
              id={`tab-${t.id}`}
              aria-selected={on}
              aria-controls={t.id}
              tabIndex={on ? 0 : -1}
              onClick={() => select(t.id, false)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={
                "min-h-11 rounded-t-md border-b-2 px-3 text-base font-medium focus-visible:outline-2 focus-visible:outline-ring " +
                (on
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground")
              }
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        data-tab-extra
        onClick={toggleAll}
        className="mb-1 min-h-11 rounded-md px-3 text-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
      >
        {expanded ? "Close all cards" : "Open all cards"}
      </button>
    </div>
  );
}
