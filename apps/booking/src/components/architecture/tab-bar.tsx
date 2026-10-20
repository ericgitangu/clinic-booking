"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Tab = { id: string; label: string };

// The tab bar is the only script this page adds. The first tab (the ten decisions) is rendered on
// the server. Each other tab is a static HTML fragment at /decisions/panel/<id>, fetched the first
// time the tab is opened, so the page stays light. This component reads the address (a tab id, a
// card id or ?tab=), keeps the arrow keys and Home/End working, loads the tab, and opens a card
// when a link points at it. Without JavaScript a <noscript> rule shows every panel and each lazy
// panel carries a link to its fragment as a plain page.

const byId = (id: string) => document.getElementById(id);

async function load(panel: HTMLElement): Promise<boolean> {
  if (panel.dataset.loaded === "1") return true;
  const src = panel.dataset.src;
  if (!src) return true;
  panel.setAttribute("aria-busy", "true");
  const slot = panel.querySelector<HTMLElement>("[data-slot]");
  if (slot) slot.textContent = "Loading this tab...";
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(String(res.status));
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const main = doc.querySelector("[data-fragment]");
    if (!main) throw new Error("no fragment");
    // Own-origin static HTML built from the repo's content; it carries no script.
    panel.innerHTML = main.innerHTML;
    panel.dataset.loaded = "1";
    return true;
  } catch {
    if (slot) {
      slot.textContent = "This tab did not load. ";
      const a = document.createElement("a");
      a.href = src;
      a.textContent = "Open it as a plain page";
      a.className = "text-primary underline underline-offset-4";
      slot.append(a, ".");
    }
    return false;
  } finally {
    panel.removeAttribute("aria-busy");
  }
}

export function TabBar({
  tabs,
  cardTabs,
}: {
  tabs: readonly Tab[];
  cardTabs: Readonly<Record<string, string>>;
}) {
  const [active, setActive] = useState(tabs[0]!.id);
  const [expanded, setExpanded] = useState(false);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const pending = useRef<string | null>(null);

  const reveal = useCallback((id: string) => {
    const el = byId(id);
    if (!el) return;
    if (el instanceof HTMLDetailsElement) el.open = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => el.scrollIntoView({ block: "start" })),
    );
  }, []);

  // Show the active panel, hide the others, and load the panel if it is a fragment. The panels
  // belong to the server render (or to the fetched HTML), so this sets an attribute directly.
  useEffect(() => {
    for (const t of tabs)
      byId(t.id)?.toggleAttribute("data-off", t.id !== active);
    setExpanded(false);
    const panel = byId(active);
    if (!panel) return;
    void load(panel).then((ok) => {
      // Only the card that sits in the panel that just loaded: a slower load of another tab must
      // not consume a link that is waiting on this one.
      const id = pending.current;
      if (ok && id && panel.contains(byId(id))) {
        pending.current = null;
        reveal(id);
      }
    });
  }, [active, tabs, reveal]);

  const follow = useCallback(() => {
    let hash = "";
    try {
      hash = decodeURIComponent(window.location.hash.slice(1));
    } catch {
      hash = "";
    }
    const ids = new Set(tabs.map((t) => t.id));
    let tab: string | null = null;
    if (hash && ids.has(hash)) tab = hash;
    else if (hash && cardTabs[hash]) {
      tab = cardTabs[hash]!;
      pending.current = hash;
    } else if (hash) {
      // One of the ten decisions, already on the page.
      const el = byId(hash);
      const panel = el?.closest<HTMLElement>('[role="tabpanel"]');
      if (el && panel && ids.has(panel.id)) {
        tab = panel.id;
        pending.current = hash;
      }
    }
    if (!tab) {
      const q = new URLSearchParams(window.location.search).get("tab");
      if (q && ids.has(q)) tab = q;
    }
    if (!tab) return;
    if (tab === active) {
      // Already showing: the effect will not run, so reveal here when the card is on the page.
      if (pending.current && byId(pending.current)) {
        const id = pending.current;
        pending.current = null;
        reveal(id);
      }
    } else setActive(tab);
  }, [tabs, cardTabs, active, reveal]);

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
    byId(active)
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
        aria-label="Decisions page sections"
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
      {active !== tabs[0]!.id ? (
        <button
          type="button"
          data-tab-extra
          onClick={toggleAll}
          className="mb-1 min-h-11 rounded-md px-3 text-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {expanded ? "Close all cards" : "Open all cards"}
        </button>
      ) : null}
    </div>
  );
}
