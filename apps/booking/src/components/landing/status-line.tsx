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

// Shown while the readiness answer is on its way. The page streams its first screen without waiting
// for the API, so the intro text and the buttons arrive at once; this pill has the same size as the
// real one, so nothing moves when it is replaced.
export function StatusPending() {
  return (
    <p className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-card px-4 text-base">
      <span aria-hidden className="size-2.5 rounded-full bg-muted-foreground" />
      Checking the API
    </p>
  );
}
