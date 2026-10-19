"use client";

import { CheckCircle2, CircleMinus, Loader2, XCircle } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@clinic/ui/components/ui/button";
// Types only: the runner and the collection load when a run starts, not with the page.
import type { Mode, Outcome } from "@/lib/api-checks";

type State =
  | { kind: "idle" }
  | { kind: "running"; mode: Mode; outcomes: Outcome[] }
  | { kind: "done"; mode: Mode; outcomes: Outcome[] }
  | { kind: "error"; message: string };

const ICON = {
  pass: (
    <CheckCircle2
      aria-hidden
      className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400"
    />
  ),
  fail: <XCircle aria-hidden className="size-5 shrink-0 text-destructive" />,
  skip: (
    <CircleMinus
      aria-hidden
      className="size-5 shrink-0 text-muted-foreground"
    />
  ),
};
const WORD = { pass: "passed", fail: "failed", skip: "skipped" };

function summary(outcomes: Outcome[]): string {
  const count = (s: Outcome["state"]) =>
    outcomes.filter((o) => o.state === s).length;
  const assertions = outcomes.reduce((n, o) => n + o.assertions.length, 0);
  const parts = [`${count("pass")} of ${outcomes.length} requests passed`];
  if (count("fail")) parts.push(`${count("fail")} failed`);
  if (count("skip")) parts.push(`${count("skip")} skipped`);
  return `${parts.join(", ")} (${assertions} assertions).`;
}

export function ApiChecksPanel() {
  const [writes, setWrites] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const writesId = useId();
  const running = state.kind === "running";

  async function start() {
    const mode: Mode = writes ? "write" : "read";
    setState({ kind: "running", mode, outcomes: [] });
    try {
      const lib = await import("@/lib/api-checks");
      const extracted = lib.extractChecks(await lib.loadCollection());
      if (!extracted.ok) {
        setState({ kind: "error", message: extracted.error });
        return;
      }
      const outcomes: Outcome[] = [];
      await lib.run(extracted.checks, {
        mode,
        base: "/api",
        fetch: window.fetch.bind(window),
        onOutcome: (o) => {
          outcomes.push(o);
          setState({ kind: "running", mode, outcomes: [...outcomes] });
        },
      });
      setState({ kind: "done", mode, outcomes });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const outcomes =
    state.kind === "running" || state.kind === "done" ? state.outcomes : [];

  return (
    <div
      className="mt-6 rounded-xl border border-border bg-card p-5"
      data-testid="api-checks"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="lg"
          className="h-12 px-5 text-base"
          onClick={start}
          disabled={running}
        >
          {running ? <Loader2 aria-hidden className="animate-spin" /> : null}
          {writes ? "Run with writes" : "Run the API checks"}
        </Button>
        <p
          role="status"
          aria-live="polite"
          className="text-base"
          data-testid="api-checks-summary"
        >
          {state.kind === "running"
            ? `Running: ${state.outcomes.length} done`
            : state.kind === "done"
              ? summary(state.outcomes)
              : state.kind === "error"
                ? `The run stopped: ${state.message}`
                : null}
        </p>
      </div>

      <div className="mt-4 flex items-start gap-3">
        <input
          id={writesId}
          type="checkbox"
          checked={writes}
          disabled={running}
          onChange={(e) => setWrites(e.target.checked)}
          className="mt-1 size-5 shrink-0 accent-primary"
          aria-describedby={`${writesId}-what`}
        />
        <div className="min-w-0">
          <label
            htmlFor={writesId}
            className="-my-2 inline-block py-2 font-medium"
          >
            Also run writes
          </label>
          <p
            id={`${writesId}-what`}
            className="mt-1 max-w-[65ch] text-sm leading-6 text-muted-foreground"
          >
            Books, replays, double-books and cancels one visit. Leaves two test
            patients and a cancelled visit in the live database.
          </p>
        </div>
      </div>

      {outcomes.length ? (
        <ol
          className="mt-5 divide-y divide-border border-t border-border"
          aria-label="Results"
        >
          {outcomes.map((o, i) => {
            const failed = o.assertions.filter((a) => a.error);
            return (
              <li key={i} className="py-3" data-state={o.state}>
                <div className="flex items-start gap-3">
                  {ICON[o.state]}
                  <div className="min-w-0 flex-1">
                    <p className="text-base">
                      <span className="sr-only">{WORD[o.state]}: </span>
                      <span className="text-muted-foreground">
                        {o.check.folder} ·{" "}
                      </span>
                      {o.check.name}
                    </p>
                    <p className="mt-0.5 break-all font-mono text-sm text-muted-foreground">
                      {o.check.method} /api{o.url ?? o.check.path}
                      {" · expected "}
                      {o.check.status}
                      {o.check.code ? ` ${o.check.code}` : ""}
                      {o.got !== null ? ` · got ${o.got}` : ""}
                      {o.assertions.length
                        ? ` · ${o.assertions.length - failed.length}/${o.assertions.length} assertions`
                        : ""}
                    </p>
                    {o.note ? <p className="mt-1 text-sm">{o.note}</p> : null}
                    {failed.length ? (
                      <ul className="mt-1 list-disc pl-5 text-sm">
                        {failed.map((a) => (
                          <li key={a.name}>
                            {a.name}: {a.error}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
