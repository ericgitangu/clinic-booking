// When "Veto and lock" is worth offering. A veto undoes the patient's most recent change, so it is
// shown only when the latest thing that happened to the appointment is a move the patient made, and
// the visit is not cancelled (a cancelled visit has nothing left to put back on the screen). A
// locked appointment offers Unlock instead. The API still refuses anything else (NOTHING_TO_VETO).
export interface VetoEvent {
  event_type: "booked" | "rescheduled" | "cancelled";
  actor?: "patient" | "staff" | null;
}

export function canVeto(
  events: readonly VetoEvent[],
  status: "booked" | "cancelled",
  locked: boolean,
): boolean {
  if (locked || status === "cancelled") return false;
  const last = events.at(-1);
  return last?.event_type === "rescheduled" && last.actor === "patient";
}
