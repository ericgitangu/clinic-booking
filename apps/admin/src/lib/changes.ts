// The changes behind the figures the API gives as counts: bookings, moves and cancellations by the
// day they were made, read from GET /internal/admin/ops/changes (generated client). `total` is the
// count over the whole range and equals the figure the sheet was opened from.
import type { ChangeItem } from "@clinic/api/generated";

export type ChangeKind = ChangeItem["kind"];
export type ChangeRow = ChangeItem;

export interface ChangesQuery {
  kind: ChangeKind;
  from: string;
  to: string;
  /** Cancelled only: the reason group, as /ops/cancellation-reasons names it. */
  reason?: string;
}

export type ChangesResult =
  | {
      ok: true;
      view: "full" | "minimised";
      total: number;
      rows: ChangeRow[];
      truncated: boolean;
    }
  | { ok: false; message: string };
