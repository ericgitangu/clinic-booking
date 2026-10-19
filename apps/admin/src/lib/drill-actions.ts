"use server";

import { appointmentsPage } from "@/lib/api";
import type { DrillRow, DrillSpec } from "@/lib/drill";
import { authorise, callerFor } from "@/lib/session";

export type DrillResult =
  | {
      ok: true;
      rows: DrillRow[];
      view: "full" | "minimised";
      /** True when the list was cut at the bound; the sheet says so. */
      truncated: boolean;
      /** The server's clock at the read, for "still to come". */
      nowMs: number;
    }
  | { ok: false; message: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PAGE = 100;
const MAX_PAGES = 5;

// Reads the appointments behind a number: every status the spec asks for, in the date range, from
// the same admin list the dashboard uses, so a viewer gets the API's minimised names and an owner
// the full ones. Any signed-in staff role may look; nothing is written.
export async function loadDrill(spec: DrillSpec): Promise<DrillResult> {
  const staff = await authorise("view");
  if (!staff)
    return { ok: false, message: "Your account is not allowed to do this." };
  if (!DAY.test(spec.from) || !DAY.test(spec.to) || spec.from >= spec.to)
    return { ok: false, message: "Pick a start date before the end date." };
  if (spec.doctorId && !/^[0-9a-f-]{36}$/i.test(spec.doctorId))
    return { ok: false, message: "That doctor is not available." };

  const caller = callerFor(staff, staff.role);
  const rows: DrillRow[] = [];
  let view: "full" | "minimised" = "full";
  let cursor: string | null = null;
  let truncated = false;
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await appointmentsPage(caller, {
      status: spec.status,
      from: spec.from,
      to: spec.to,
      limit: PAGE,
      cursor,
      ...(spec.doctorId ? { doctor_id: spec.doctorId } : {}),
    });
    if (!res.ok)
      return {
        ok: false,
        message: "The clinic service did not answer. Try again.",
      };
    view = res.data.view;
    for (const a of res.data.items) {
      rows.push({
        id: a.id,
        doctor_id: a.doctor_id,
        doctor_name: a.doctor_name,
        patient_name: a.patient_name,
        starts_at: a.starts_at,
        created_at: a.created_at,
        status: a.status,
        attendance: a.attendance ?? null,
      });
    }
    if (!res.data.next_cursor) break;
    cursor = res.data.next_cursor;
    if (i === MAX_PAGES - 1) truncated = true;
  }
  return { ok: true, rows, view, truncated, nowMs: Date.now() };
}
