// The model behind the time grid: which times are on it and which of them can be picked. Plain
// data in, plain data out, so it is tested without a browser and the live-update code (polling now,
// push later) only has to feed it the latest list.
import { clinicDay } from "@/lib/clinic-time";

/** A booked appointment the signed-in patient already holds (their own data, nothing else). */
export type OwnBooking = {
  starts_at: string;
  doctor_id: string;
  /** For words only; the grid does not need it. */
  doctor_name?: string;
};

export type ChipState =
  | "free" // can be picked
  | "yours" // the patient's own visit with this doctor
  | "yours-elsewhere" // the patient has a visit with another doctor at this time
  | "booked" // taken by someone, when the response says so (optional `taken` list)
  | "gone" // was on the grid, is not in the latest list, and we do not know why
  | "just-taken"; // confirmed taken: the API answered 409 SLOT_TAKEN, or a slot_taken event arrived

export type Chip = {
  starts_at: string;
  state: ChipState;
  /** The words under the time for an inactive chip; null for a free one. */
  label: string | null;
};

const instant = (iso: string) => Date.parse(iso);
export const sameInstant = (a: string, b: string) => instant(a) === instant(b);

/** The patient's booking at exactly this time, with any doctor. */
export function heldAt(
  own: readonly OwnBooking[],
  startsAt: string,
): OwnBooking | undefined {
  return own.find((o) => sameInstant(o.starts_at, startsAt));
}

export function addOwn(
  own: readonly OwnBooking[],
  b: OwnBooking,
): OwnBooking[] {
  return heldAt(own, b.starts_at) ? [...own] : [...own, b];
}

export function removeOwn(
  own: readonly OwnBooking[],
  startsAt: string,
): OwnBooking[] {
  return own.filter((o) => !sameInstant(o.starts_at, startsAt));
}

const LABEL: Record<Exclude<ChipState, "free">, string> = {
  yours: "Your visit",
  "yours-elsewhere": "You have another visit",
  booked: "Booked",
  gone: "No longer available",
  "just-taken": "Just taken",
};

export function buildChips(input: {
  doctorId: string;
  /** The clinic day on the grid, "YYYY-MM-DD". */
  day: string;
  /** The latest free times from the API. */
  slots: readonly { starts_at: string }[];
  /** Optional: every time of this doctor and day that is already taken (not in the contract yet). */
  taken?: readonly string[];
  own: readonly OwnBooking[];
  /** Every free time this grid has shown so far in this visit. */
  seen: readonly string[];
  /** Times confirmed taken by someone else (a 409 SLOT_TAKEN or a slot_taken event). */
  confirmedTaken?: readonly string[];
}): Chip[] {
  const chips = new Map<number, Chip>();
  const put = (iso: string, state: ChipState) =>
    chips.set(instant(iso), {
      starts_at: iso,
      state,
      label: state === "free" ? null : LABEL[state],
    });

  // Earlier facts first; later ones win, so the order below is the order of importance.
  for (const iso of input.seen) put(iso, "gone");
  for (const iso of input.confirmedTaken ?? []) put(iso, "just-taken");
  for (const iso of input.taken ?? []) put(iso, "booked");
  for (const s of input.slots) {
    const held = heldAt(input.own, s.starts_at);
    put(s.starts_at, held ? "yours-elsewhere" : "free");
  }
  for (const o of input.own) {
    if (o.doctor_id === input.doctorId && clinicDay(o.starts_at) === input.day)
      put(o.starts_at, "yours");
  }
  return [...chips.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
}
