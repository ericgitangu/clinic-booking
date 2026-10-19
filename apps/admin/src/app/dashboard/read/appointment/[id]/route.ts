import { loadDetail } from "@/lib/detail-read";

export const dynamic = "force-dynamic";

// The detail of one appointment for the sheet that opens over a row. A plain GET, not a server
// action: a read must not queue behind writes (actions run one at a time) and must not touch the
// router. Who is asking is checked inside; the answer is the API's own view for that person.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const res = await loadDetail(id);
  return Response.json(res, {
    status: res.ok ? 200 : 404,
    headers: { "cache-control": "no-store" },
  });
}
