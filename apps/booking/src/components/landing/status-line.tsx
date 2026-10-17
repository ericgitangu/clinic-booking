import { ready } from "@/lib/api";

// The API's own readiness check, run on the server (it reaches the database) and cached for 30
// seconds, so the page shows what the API says now, not what it said at build time.
export async function StatusLine() {
  const r = await ready();
  const up = r.ok;
  return (
    <p
      role="status"
      data-testid="api-status"
      className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-card px-4 text-base"
    >
      <span
        aria-hidden
        className={
          "size-2.5 rounded-full " + (up ? "bg-emerald-500" : "bg-amber-500")
        }
      />
      {up ? "API ready" : "API status unknown right now"}
      <span className="text-sm text-muted-foreground">
        checked on the server, cached 30 seconds
      </span>
    </p>
  );
}
