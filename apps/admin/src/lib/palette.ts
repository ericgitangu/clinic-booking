// Which option of the palette is active after an arrow key. Kept apart from the component so the
// edges can be tested: with nothing to choose from there is no active option to move, and the
// index never leaves the list.
export function nextActive(
  active: number,
  key: "ArrowDown" | "ArrowUp" | "Home" | "End",
  count: number,
): number {
  if (count <= 0) return 0;
  const last = count - 1;
  switch (key) {
    case "ArrowDown":
      return Math.max(0, Math.min(last, active + 1));
    case "ArrowUp":
      return Math.max(0, Math.min(last, active - 1));
    case "Home":
      return 0;
    case "End":
      return last;
  }
}
