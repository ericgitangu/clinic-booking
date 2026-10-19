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
 *
 * The cursor on screen stays the response's own. The server's cursor is "<xmin>.0", which can sit
 * behind the (txid, id) of an event already pushed; moving it to the event made the refetch after
 * a freed event look older and be dropped. Event order is tracked by `lastSeq` instead, and a taken
 * time is held back from older responses by `reapplyTaken`.
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
      slots: data.slots.filter((s) => !sameInstant(s.starts_at, ev.starts_at)),
      taken: data.taken.some((t) => sameInstant(t, ev.starts_at))
        ? data.taken
        : [...data.taken, ev.starts_at],
    },
  };
}

/**
 * A taken time is kept off a polled response that is older than the event that took it (its cursor
 * has not reached the event's (txid, id)), so a slow poll cannot bring a taken time back. The caller
 * forgets a time when a freed event for it arrives.
 */
export function reapplyTaken(
  data: Availability,
  taken: readonly { startsAt: string; seq: string }[],
): Availability {
  const cursor = parseSeq(data.cursor);
  let out = data;
  for (const t of taken) {
    const seq = parseSeq(t.seq);
    if (cursor && seq && compareSeq(seq, cursor, 2) <= 0) continue;
    out = withTaken(out, t.startsAt);
  }
  return out;
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
