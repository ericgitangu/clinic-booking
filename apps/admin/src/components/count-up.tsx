"use client";

import { useEffect, useRef } from "react";

// A key number that settles into place once on load.
//
// - The real value is in the HTML from the first byte, so it reads right with no script, in a
//   screen reader (the visually hidden copy below is what assistive technology reads, and it never
//   changes) and in tests.
// - The drawn copy is aria-hidden and only it animates. It starts at 70% of the value, not at zero,
//   so a page that has just painted the final number does not visibly drop to nothing before it
//   climbs back.
// - Width is reserved for the final digits (min-width in ch, tabular figures), so nothing around it
//   moves while the digits change.
// - Skipped for reduced motion, for anything that is not a whole number or whole percentage, and
//   once the page has been open a few seconds (a refresh or a filter change does not replay it).
const PLAY_WITHIN_MS = 3000;

export function CountUp({
  value,
  testId,
  className,
}: {
  value: string;
  /** Put on the hidden copy that holds the real value; tests and readers use it. */
  testId?: string;
  className?: string;
}) {
  const drawn = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = drawn.current;
    const m = /^(\d+)(%?)$/.exec(value);
    if (
      !node ||
      !m ||
      performance.now() > PLAY_WITHIN_MS ||
      Number(m[1]) < 2 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const target = Number(m[1]);
    const from = Math.floor(target * 0.7);
    const unit = m[2] ?? "";
    const start = performance.now();
    const ms = 600;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - (1 - t) ** 3;
      node.textContent = `${Math.round(from + (target - from) * eased)}${unit}`;
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      node.textContent = value;
    };
  }, [value]);
  return (
    <>
      <span className="sr-only" data-testid={testId}>
        {value}
      </span>
      <span
        ref={drawn}
        aria-hidden="true"
        className={`inline-block tabular-nums ${className ?? ""}`}
        style={{ minWidth: `${value.length}ch` }}
      >
        {value}
      </span>
    </>
  );
}
