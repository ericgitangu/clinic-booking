import { loadChanges } from "@/lib/changes-read";
import type { ChangeKind } from "@/lib/changes";

export const dynamic = "force-dynamic";

// The changes behind a figure, for its sheet: a plain GET, like the other reads.
export async function GET(request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const res = await loadChanges({
    kind: (q.get("kind") ?? "") as ChangeKind,
    from: q.get("from") ?? "",
    to: q.get("to") ?? "",
    reason: q.get("reason") ?? undefined,
  });
  return Response.json(res, {
    status: res.ok ? 200 : res.notBuilt ? 200 : 400,
    headers: { "cache-control": "no-store" },
  });
}
