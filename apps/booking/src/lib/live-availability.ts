// The rules that keep a live grid from going backwards, as pure functions. A polled response and a
// pushed event can arrive in any order; these decide which one may change what is on screen.
import type { Availability } from "@clinic/api/generated";
import { compareSeq, cursorNotOlder, parseSeq } from "@/lib/cursor";
import { sameInstant } from "@/lib/slot-chips";

export type SlotEventLike = {
  doctor_id: string;
  local_date: string;
  kind: "slot_taken" | "slot_freed";
  seq: string;
  starts_at: string;
};

/** RULE 1: a polled (or refetched) response replaces the one on screen only if it is not older. */
export function acceptPolled(
  old: Availability | undefined,
  next: Availability,
): Availability {
  if (old && !cursorNotOlder(next.cursor, old.cursor)) return old;
  return next;
}

export type EventResult =
  | { effect: "ignored"; data: Availability; lastSeq: string | null }
  | { effect: "taken" | "freed"; data: Availability; lastSeq: string };

/**
 * RULE 2: a pushed event is applied only if its sequence is after the last one applied and its
 * (txid, id) is after the cursor of the response on screen (anything at or before that cursor is
 * already in the slots). A taken slot is removed here, at once; a freed slot is not added here:
 * whether a time is offerable is the server's call, so the caller refetches once.
 */
export function applyEvent(
  data: Availability,
  lastSeq: string | null,
  ev: SlotEventLike,
): EventResult {
  const seq = parseSeq(ev.seq);
  const ignored = { effect: "ignored", data, lastSeq } as const;
  if (!seq) return ignored;
  if (ev.doctor_id !== data.doctor_id || ev.local_date !== data.date)
    return ignored;
  const last = lastSeq ? parseSeq(lastSeq) : null;
  if (last && compareSeq(seq, last) <= 0) return ignored;
  const cursor = parseSeq(data.cursor);
  if (cursor && compareSeq(seq, cursor, 2) <= 0)
    return { ...ignored, lastSeq: ev.seq };

  if (ev.kind === "slot_freed")
    return { effect: "freed", data, lastSeq: ev.seq };
  return {
    effect: "taken",
    lastSeq: ev.seq,
    data: {
      ...data,
      cursor: `${seq[0]}.${seq[1]}`,
      slots: data.slots.filter((s) => !sameInstant(s.starts_at, ev.starts_at)),
      taken: data.taken.some((t) => sameInstant(t, ev.starts_at))
        ? data.taken
        : [...data.taken, ev.starts_at],
    },
  };
}

/** RULE 3: the API said 409 for this time, or the patient's own booking took it: patch at once. */
export function withTaken(data: Availability, startsAt: string): Availability {
  return {
    ...data,
    slots: data.slots.filter((s) => !sameInstant(s.starts_at, startsAt)),
    taken: data.taken.some((t) => sameInstant(t, startsAt))
      ? data.taken
      : [...data.taken, startsAt],
  };
}
