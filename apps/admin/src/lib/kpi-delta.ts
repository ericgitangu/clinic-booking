// How a key number moved against the period before it. Pure, so the wording is tested on its own.
// "better" says which direction is good news for the clinic; it only sets the tone of the icon,
// the words always carry the meaning.
export type Better = "up" | "down" | "none";
export type Tone = "good" | "bad" | "neutral";

export interface Delta {
  direction: "up" | "down" | "same";
  tone: Tone;
  /** Reads on its own, e.g. "Up 3 from 9". */
  text: string;
}

function toneFor(direction: Delta["direction"], better: Better): Tone {
  if (direction === "same" || better === "none") return "neutral";
  return direction === better ? "good" : "bad";
}

export function countDelta(
  current: number,
  previous: number,
  better: Better,
): Delta {
  const diff = current - previous;
  const direction = diff > 0 ? "up" : diff < 0 ? "down" : "same";
  const text =
    direction === "same"
      ? `No change from ${previous}`
      : `${direction === "up" ? "Up" : "Down"} ${Math.abs(diff)} from ${previous}`;
  return { direction, tone: toneFor(direction, better), text };
}

/** Utilisation is a share (0 to 1) or null when nobody had working hours. Moves in points. */
export function shareDelta(
  current: number | null,
  previous: number | null,
  better: Better,
  /** What to say when the period before had nothing to compare with. */
  nothingBefore = "No hours before",
): Delta | null {
  if (current === null) return null;
  if (previous === null) {
    return { direction: "same", tone: "neutral", text: nothingBefore };
  }
  const points = Math.round(current * 100) - Math.round(previous * 100);
  const direction = points > 0 ? "up" : points < 0 ? "down" : "same";
  const was = `${Math.round(previous * 100)}%`;
  const text =
    direction === "same"
      ? `No change from ${was}`
      : `${direction === "up" ? "Up" : "Down"} ${Math.abs(points)} ${Math.abs(points) === 1 ? "point" : "points"} from ${was}`;
  return { direction, tone: toneFor(direction, better), text };
}

/** "6 h" under two days, "2.4 days" from there on. */
export function formatLead(hours: number): string {
  return hours < 48
    ? `${Math.max(0, Math.round(hours))} h`
    : `${(hours / 24).toFixed(1)} days`;
}

/** Change in a length of time, in the words of formatLead. Neutral: longer is not good or bad. */
export function durationDelta(
  current: number | null,
  previous: number | null,
): Delta | null {
  if (current === null) return null;
  if (previous === null) {
    return {
      direction: "same",
      tone: "neutral",
      text: "Nothing before to compare",
    };
  }
  const diff = current - previous;
  // Within half an hour counts as no change; a figure of hours should not wobble on rounding.
  if (Math.abs(diff) < 0.5) {
    return {
      direction: "same",
      tone: "neutral",
      text: `No change from ${formatLead(previous)}`,
    };
  }
  const direction = diff > 0 ? "up" : "down";
  return {
    direction,
    tone: "neutral",
    text: `${direction === "up" ? "Up" : "Down"} ${formatLead(Math.abs(diff))} from ${formatLead(previous)}`,
  };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}
