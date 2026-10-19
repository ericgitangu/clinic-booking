// What cannot be listed behind a figure yet, in plain words, and the read that would fix it. Shown in
// the figure's own sheet so the gap is named where a person looks for the list.
export const REASON_GAP =
  "The visits behind a reason cannot be listed yet. The service groups reasons by the day a visit was cancelled, while the appointment list can only be filtered by the day a visit starts, so a list here would not add up to this number. It needs a read that lists cancelled visits by cancellation date, with the reason group.";

export const ACTIVITY_GAP =
  "The bookings, moves and cancellations made on a day cannot be listed yet: the appointment list filters by the day a visit starts, not by the day something was done to it. It needs a read of changes by the day they were made.";

export const RESCHEDULE_GAP =
  "The visits that were moved cannot be listed yet: no read lists changes across appointments, only one appointment's history at a time. It needs a read of moves in a date range, with the appointment each belongs to.";
