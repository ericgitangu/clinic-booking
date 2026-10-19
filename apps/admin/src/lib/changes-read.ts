import "server-only";
import { opsChanges } from "@/lib/api";
import type { ChangesPage, ChangesQuery, ChangesResult } from "@/lib/changes";
import { authorise, callerFor } from "@/lib/session";

const PAGE = 100;
const MAX_PAGES = 5;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(["booked", "rescheduled", "cancelled"]);

// Reads the changes behind a figure, up to 500, through the read described in lib/changes.ts. Any
// signed-in role may look; the API decides what a viewer sees. When the API does not have the read
// yet (404) the result says so, and the sheet shows the figures and names the gap.
export async function loadChanges(q: ChangesQuery): Promise<ChangesResult> {
  const staff = await authorise("view");
  if (!staff)
    return { ok: false, message: "Your account is not allowed to do this." };
  if (
    !KINDS.has(q.kind) ||
    !DAY.test(q.from) ||
    !DAY.test(q.to) ||
    q.from >= q.to
  )
    return { ok: false, message: "Pick a start date before the end date." };
  const caller = callerFor(staff, staff.role);
  const rows: ChangesPage["items"] = [];
  let view: "full" | "minimised" = "full";
  let total = 0;
  let cursor: string | null = null;
  let truncated = false;
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await opsChanges(caller, {
      kind: q.kind,
      from: q.from,
      to: q.to,
      reason: q.reason,
      limit: PAGE,
      cursor: cursor ?? undefined,
    });
    if (!res.ok) {
      if (res.status === 404) return { ok: false, notBuilt: true };
      return {
        ok: false,
        message: "The clinic service did not answer. Try again.",
      };
    }
    const page = res.data as ChangesPage;
    view = page.view;
    total = page.total;
    rows.push(...page.items);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
    if (i === MAX_PAGES - 1) truncated = true;
  }
  return { ok: true, view, total, rows, truncated };
}
