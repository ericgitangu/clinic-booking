import { opsDaySheet } from "@/lib/api";
import { localDate } from "@/lib/clinic-time";
import { authorise, callerFor } from "@/lib/session";

export const dynamic = "force-dynamic";

// The day sheet as CSV, one row per appointment of the day. The rows are the API's own export
// (/ops/day-sheet.csv), which builds them server-side and guards spreadsheet formulas. This route
// only checks who is asking (owner and admin) and passes the file through.
export async function GET(request: Request): Promise<Response> {
  const staff = await authorise("manage-appointments");
  if (!staff) return new Response("Not allowed", { status: 403 });

  const asked = new URL(request.url).searchParams.get("date");
  const date =
    asked &&
    /^\d{4}-\d{2}-\d{2}$/.test(asked) &&
    !Number.isNaN(Date.parse(asked))
      ? asked
      : localDate(new Date());

  const res = await opsDaySheet(callerFor(staff, staff.role), date);
  if (!res.ok)
    return new Response("The day sheet could not be made.", { status: 502 });
  return new Response(String(res.data), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="day-sheet-${date}.csv"`,
      "cache-control": "no-store",
    },
  });
}
