import { timingSafeEqual } from "node:crypto";
import { runReminders } from "@/lib/email/reminders";

// The daily reminder run. Vercel Cron calls it with GET and sends `Authorization: Bearer
// $CRON_SECRET`; anything else is refused. It lives outside /api on purpose, and `?on=YYYY-MM-DD`
// reminds for that clinic-local date instead of tomorrow (a rehearsal or a re-run), for whoever
// holds the secret.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const given = req.headers.get("authorization") ?? "";
  const want = `Bearer ${secret}`;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: Request): Promise<Response> {
  if (!authorised(req)) {
    return Response.json(
      { error: "unauthorised" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  const on = new URL(req.url).searchParams.get("on") ?? undefined;
  const summary = await runReminders(on);
  return Response.json(summary, {
    status: summary.error ? 502 : 200,
    headers: { "cache-control": "no-store" },
  });
}
