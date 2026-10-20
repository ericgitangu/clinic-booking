// Links shared before the cards were renumbered point at "#adr-0033". Map them to "decision-33" so
// they keep working. The old ids are never in the HTML, only recognised here from the number.
export const DECISION_COUNT = 34;

export function currentDecisionAnchor(hash: string): string | null {
  const m = /^adr-(\d{4})$/.exec(hash);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= DECISION_COUNT ? `decision-${n}` : null;
}
