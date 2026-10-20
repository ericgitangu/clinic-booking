import { describe, expect, it, vi } from "vitest";
import {
  SHEET_RECHECK_AFTER_MS,
  watchDoctorNotice,
} from "@/lib/doctor-notice-read";
import { followArrivalToast } from "@/lib/arrival-toast";
import type { DoctorNoticeView } from "@/lib/detail-read";

const view = (over: Partial<DoctorNoticeView> = {}): DoctorNoticeView => ({
  id: "n",
  status: "pending",
  reason: null,
  attempts: 0,
  sentAt: null,
  retryable: false,
  ...over,
});
const sent = view({ status: "sent", sentAt: "2026-10-27T07:00:01Z" });
const now = () => Promise.resolve();

describe("watchDoctorNotice", () => {
  it("says nothing to someone who left while the read was out", async () => {
    let here = true;
    const onNotice = vi.fn();
    await watchDoctorNotice("a", onNotice, {
      alive: () => here,
      read: async () => {
        here = false; // gone while the read was in flight
        return sent;
      },
      wait: now,
    });
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("stops after a wait if whoever asked has gone", async () => {
    let here = true;
    const read = vi.fn(async () => view());
    await watchDoctorNotice("a", () => undefined, {
      alive: () => here,
      read,
      wait: async () => {
        here = false;
      },
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps looking for the sheet until the row can be resent: 2.5 s up to 140 s", async () => {
    const waits: number[] = [];
    const read = vi.fn(async () => view());
    await watchDoctorNotice("a", () => undefined, {
      read,
      delays: SHEET_RECHECK_AFTER_MS,
      wait: async (ms) => void waits.push(ms),
    });
    expect(read).toHaveBeenCalledTimes(SHEET_RECHECK_AFTER_MS.length + 1);
    // The last look is past the 2 minutes after which an unclaimed row becomes retryable.
    expect(SHEET_RECHECK_AFTER_MS.at(-1)).toBeGreaterThan(120_000);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(
      SHEET_RECHECK_AFTER_MS.at(-1),
    );
  });

  it("stops at the first state that can be resent", async () => {
    const answers = [view(), view(), view({ retryable: true })];
    const read = vi.fn(async () => answers.shift() ?? view());
    const seen: boolean[] = [];
    await watchDoctorNotice("a", (n) => seen.push(n.retryable), {
      read,
      delays: SHEET_RECHECK_AFTER_MS,
      done: (n) => n.status !== "pending" || n.retryable,
      wait: now,
    });
    expect(read).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([false, false, true]);
  });

  it("waits while the tab is hidden and looks when it is shown", async () => {
    const order: string[] = [];
    let show: () => void = () => undefined;
    const shown = new Promise<void>((ok) => (show = ok));
    const read = vi.fn(async () => {
      order.push("read");
      return sent;
    });
    const done = watchDoctorNotice("a", () => order.push("notice"), {
      read,
      untilVisible: async () => {
        order.push("wait for the tab");
        await shown;
        order.push("tab shown");
      },
      wait: now,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(read).not.toHaveBeenCalled(); // hidden: no look
    show();
    await done;
    expect(order).toEqual(["wait for the tab", "tab shown", "read", "notice"]);
  });
});

describe("followArrivalToast", () => {
  it("updates the one toast in place and ends on the final state", async () => {
    const shown: [string, string, string, number][] = [];
    const answers = [view(), view(), sent];
    await followArrivalToast(
      "a",
      "t1",
      (id, message, kind, ms) => shown.push([id, message, kind, ms]),
      { read: async () => answers.shift() ?? null, wait: now },
    );
    // The same id every time; the unchanged "on its way" is not repeated; the end is final.
    expect(new Set(shown.map((s) => s[0]))).toEqual(new Set(["t1"]));
    expect(shown.map((s) => s[1])).toEqual([
      "Marked arrived. Doctor email on its way.",
      "Marked arrived. Doctor emailed.",
    ]);
    expect(shown.at(-1)?.[2]).toBe("success");
    expect(shown.at(-1)?.[3]).toBe(6000);
    expect(shown[0][3]).toBe(17_000); // long enough to outlast the last look at 15 s
  });

  it.each([
    ["failed", "Marked arrived. Doctor email failed.", "warning"],
    [
      "skipped",
      "Marked arrived. Email not sent (today's email limit is used up).",
      "info",
    ],
  ] as const)(
    "ends on %s with its own words",
    async (status, message, kind) => {
      const shown: string[][] = [];
      await followArrivalToast("a", "t1", (_id, m, k) => shown.push([m, k]), {
        read: async () =>
          view({
            status,
            reason: status === "skipped" ? "allowance_day" : null,
          }),
        wait: now,
      });
      expect(shown.at(-1)).toEqual([message, kind]);
    },
  );
});
