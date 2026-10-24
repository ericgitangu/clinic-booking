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
 * RULE 2: a pushed event is applied only if its sequence is after the last one applied. If the
 * response on screen already reflects the event (the time is gone for a `slot_taken`, or already
 * free for a `slot_freed`), it is ignored and its sequence is remembered. A taken slot is removed
 * here, at once; a freed slot is not added here: whether a time is offerable is the server's call,
 * so the caller refetches once.
 *
 * The cursor on screen stays the response's own, but it is a horizon (`<xmin>.0`), not a promise
 * that the response saw every event at or before it. A gap between the cursor and the grid is
 * resolved in favour of the grid: a `slot_taken` for a time still on offer is applied, because a
 * bookable taken time is the worse error. A `slot_freed` for a time still absent asks the server
 * once. Event order is tracked by `lastSeq`, and a taken time is held back from older responses
 * by `reapplyTaken`.
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

  // The grid is the evidence that decides whether the event is already reflected. The cursor can
  // sit at or beyond the event while a response still shows the old state; the event wins when
  // the two disagree, because a taken time left on offer is worse than one extra render.
  const stillFree = data.slots.some((s) =>
    sameInstant(s.starts_at, ev.starts_at),
  );
  if (ev.kind === "slot_taken" && !stillFree)
    return { ...ignored, lastSeq: ev.seq };
  if (ev.kind === "slot_freed" && stillFree)
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
