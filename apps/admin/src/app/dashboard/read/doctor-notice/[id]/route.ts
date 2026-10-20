import { doctorNotice } from "@/lib/api";
import type { DoctorNoticeView } from "@/lib/detail-read";
import { authorise, callerFor } from "@/lib/session";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Where telling the doctor of one arrival stands, for the toast that says "Marked arrived" and the
// sheet. A plain GET so it never queues behind writes. Owner and admin only: a viewer's stream
// carries no names and gets nothing about the doctor's email either (403 here, and the toast never
// asks).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  const staff = await authorise("manage-appointments");
  if (!staff) return Response.json({ ok: false }, { status: 403, headers });
  const { id } = await params;
  if (!UUID.test(id))
    return Response.json({ ok: false }, { status: 404, headers });
  const res = await doctorNotice(callerFor(staff, staff.role), id);
  if (!res.ok) return Response.json({ ok: false }, { status: 404, headers });
  const notice: DoctorNoticeView = {
    id: res.data.id,
    status: res.data.status,
    reason: res.data.reason,
    attempts: res.data.attempts,
    sentAt: res.data.sent_at,
  };
  return Response.json({ ok: true, notice }, { headers });
}
