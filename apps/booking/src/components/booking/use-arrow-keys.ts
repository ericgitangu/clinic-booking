"use client";

import { useEffect, type RefObject } from "react";

// Arrow keys move focus between the links inside a container, on top of the normal tab order (which
// is unchanged: every link stays a tab stop). Left/Right step by one, Up/Down jump to the link
// nearest above or below (so a wrapped grid behaves like a grid), Home/End go to the ends. It never
// acts on a key typed into a field, and never when a modifier is held.
export function useArrowKeys(
  ref: RefObject<HTMLElement | null>,
  { vertical }: { vertical: boolean },
) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (!target || target.tagName !== "A") return;
      const links = [...root.querySelectorAll<HTMLAnchorElement>("a[href]")];
      const at = links.indexOf(target as HTMLAnchorElement);
      if (at < 0) return;
      let next: HTMLAnchorElement | undefined;
      if (e.key === "ArrowRight") next = links[at + 1];
      else if (e.key === "ArrowLeft") next = links[at - 1];
      else if (e.key === "Home") next = links[0];
      else if (e.key === "End") next = links[links.length - 1];
      else if (vertical && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        const here = target.getBoundingClientRect();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        let best = Infinity;
        for (const l of links) {
          const r = l.getBoundingClientRect();
          if ((r.top - here.top) * dir < 4) continue; // not a row further that way
          const score =
            Math.abs(r.top - here.top) * 1000 + Math.abs(r.left - here.left);
          if (score < best) {
            best = score;
            next = l;
          }
        }
      } else return;
      if (!next) return;
      e.preventDefault();
      next.focus();
    };
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  }, [ref, vertical]);
}
