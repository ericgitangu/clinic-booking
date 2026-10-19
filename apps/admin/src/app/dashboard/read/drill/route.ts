import { loadDrill } from "@/lib/drill-read";

export const dynamic = "force-dynamic";

// The appointments behind a number, for the drill-down sheet. A plain GET for the same reason as
// the appointment detail: a read, not a write. Dates and the doctor are checked inside.
export async function GET(request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const status = q.get("status");
  const res = await loadDrill({
    from: q.get("from") ?? "",
    to: q.get("to") ?? "",
    status: status === "booked" || status === "cancelled" ? status : "all",
    doctorId: q.get("doctor") ?? undefined,
  });
  return Response.json(res, {
    status: res.ok ? 200 : 400,
    headers: { "cache-control": "no-store" },
  });
}
