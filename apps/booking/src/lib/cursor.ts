// Ordering of the push service's cursors and sequence numbers: "<txid>.<id>" for an availability
// response, "<txid>.<id>.<part>" for a pushed message. All parts are integers; compare them as
// BigInt, txid first (a string compare would put 10 before 9).
export type Seq = readonly [bigint, bigint, bigint];

export function parseSeq(s: string): Seq | null {
  if (!/^\d+\.\d+(\.\d+)?$/.test(s)) return null;
  const [a, b, c] = s.split(".");
  return [BigInt(a), BigInt(b), BigInt(c ?? "0")];
}

const cmp = (x: bigint, y: bigint) => (x < y ? -1 : x > y ? 1 : 0);

/** Compare two sequences over their first `parts` parts (2 = the cursor, 3 = the full sequence). */
export function compareSeq(a: Seq, b: Seq, parts: 2 | 3 = 3): number {
  return (
    cmp(a[0], b[0]) || cmp(a[1], b[1]) || (parts === 3 ? cmp(a[2], b[2]) : 0)
  );
}

/** True when `next` is not older than `old`. An unreadable cursor never wins over a readable one. */
export function cursorNotOlder(next: string, old: string): boolean {
  const n = parseSeq(next);
  const o = parseSeq(old);
  if (!o) return true;
  if (!n) return false;
  return compareSeq(n, o, 2) >= 0;
}
