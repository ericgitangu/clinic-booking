// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every toast either component raises goes through notify; record them all, in order.
const toasts = vi.hoisted(() => ({
  calls: [] as {
    fn: string;
    message: string;
    id?: string;
    onDismiss?: () => void;
  }[],
}));
vi.mock("@clinic/ui/lib/notify", () => {
  type Data = { id?: string; onDismiss?: () => void };
  const rec = (fn: string) => (message: string, data?: Data) =>
    void toasts.calls.push({
      fn,
      message,
      id: data?.id,
      onDismiss: data?.onDismiss,
    });
  return {
    notify: {
      success: rec("success"),
      info: rec("info"),
      warning: rec("warning"),
      error: rec("error"),
      quiet: rec("quiet"),
      // A later version of a toast: no buzz; recorded with its look.
      update: (
        kind: string,
        message: string,
        data?: { id?: string; onDismiss?: () => void },
      ) =>
        void toasts.calls.push({
          fn: `update:${kind}`,
          message,
          id: data?.id,
          onDismiss: data?.onDismiss,
        }),
      dismiss: () => undefined,
    },
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

// The one stream the browser shares: the test plays the gateway through the listener it is given.
const stream = vi.hoisted(() => ({
  listener: undefined as
    | undefined
    | {
        onEvent: (
          id: string,
          event: string,
          data: string,
          replay?: boolean,
        ) => void;
      },
}));
vi.mock("@/lib/live-share", () => ({
  sharedStream: () => ({
    subscribe: (l: NonNullable<typeof stream.listener>) => {
      stream.listener = l;
      return () => undefined;
    },
  }),
}));

import { ConfirmAction } from "@/components/confirm-action";
import { LiveNotifications } from "@/components/live-notifications";
import { Button } from "@clinic/ui/components/ui/button";
import type { ActionResult } from "@/lib/failure-copy";

const APPT = "0f1d2c3b-4a5e-6f70-8192-a3b4c5d6e7f8";
const SUCCESSOR = "1a1d2c3b-4a5e-6f70-8192-a3b4c5d6e7f9";
const DOCTOR = "e52e9da0-f7f3-5a6a-93d3-d7f658947afa";
const ME = "admin@clinic.example";
const COLLEAGUE = "owner@clinic.example";

const eventJson = (
  kind: string,
  appointmentId: string,
  seq: string,
  actor: string | null,
) =>
  JSON.stringify({
    event_type: kind,
    doctor_id: DOCTOR,
    local_date: "2026-10-27",
    from_local_date: null,
    from_starts_at: null,
    to_starts_at: "2026-10-27T07:00:00.000000Z",
    seq,
    appointment_id: appointmentId,
    patient_name: "Wanjiru Kamau",
    cancellation_reason: null,
    actor_email: actor,
    actor_role: actor ? "admin" : null,
    staff_reason: null,
  });

const live = (
  kind: string,
  appointmentId: string,
  seq: string,
  actor: string | null = ME,
) =>
  act(async () => {
    stream.listener?.onEvent(
      seq,
      kind,
      eventJson(kind, appointmentId, seq, actor),
      false,
    );
  });

function Page({
  run,
  who = ME,
}: {
  run: () => Promise<ActionResult>;
  who?: string;
}) {
  return (
    <>
      <LiveNotifications
        role="admin"
        person="p"
        self={who}
        doctors={[{ id: DOCTOR, name: "Dr. Otieno" }]}
      />
      <ConfirmAction
        trigger={<Button>Mark arrived</Button>}
        title="Mark as arrived?"
        description="d"
        confirmLabel="Confirm"
        run={run}
      />
    </>
  );
}

async function mark(reason = "patient is at the desk") {
  fireEvent.click(screen.getByRole("button", { name: "Mark arrived" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(dialog.querySelector("textarea") as HTMLTextAreaElement, {
    target: { value: reason },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  toasts.calls.length = 0;
  stream.listener = undefined;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// The action's answer, held back until the test lets it go, so an event can arrive before it.
function later<T>() {
  let release: (v: T) => void = () => undefined;
  const promise = new Promise<T>((ok) => (release = ok));
  return { promise, release };
}

const quiet = () => toasts.calls.filter((c) => c.fn === "quiet");

describe("the toast of the person who marks an arrival", () => {
  it("is exactly one toast, with one id, and it ends on what became of the email", async () => {
    const states = [
      { status: "pending", retryable: false },
      { status: "pending", retryable: false },
      { status: "sent", retryable: false },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        notice: {
          id: "n",
          reason: null,
          attempts: 1,
          sentAt: "2026-10-27T07:00:03Z",
          ...(states.shift() ?? { status: "sent", retryable: false }),
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const answer = later<ActionResult>();
    render(<Page run={() => answer.promise} />);
    await mark();
    // The gateway sends this person's own arrival back before the action has answered.
    await live("arrived", APPT, "10.1");
    await act(async () => {
      answer.release({
        ok: true,
        message: "Marked arrived. Doctor email on its way.",
        watch: { appointmentId: APPT },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(quiet()).toHaveLength(0); // no second toast for their own change
    const mine = toasts.calls;
    expect(new Set(mine.map((c) => c.id)).size).toBe(1); // one toast, updated in place
    expect(mine[0].message).toBe("Marked arrived. Doctor email on its way.");
    expect(mine.at(-1)).toMatchObject({
      fn: "update:success",
      message: "Marked arrived. Doctor emailed.",
    });
    // The first look says what the answer said, so nothing is repeated.
    expect(mine.map((c) => c.message)).toEqual([
      "Marked arrived. Doctor email on its way.",
      "Marked arrived. Doctor emailed.",
    ]);
  });

  it("stops, and brings nothing back, once the person closes the toast", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        notice: {
          id: "n",
          status: "pending",
          reason: null,
          attempts: 1,
          sentAt: null,
          retryable: false,
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <Page
        run={async () => ({
          ok: true,
          message: "Marked arrived. Doctor email on its way.",
          watch: { appointmentId: APPT },
        })}
      />,
    );
    await mark();
    const first = toasts.calls[0];
    await act(async () => {
      first.onDismiss?.(); // swiped away
      await vi.advanceTimersByTimeAsync(60_000);
    });
    // Nothing more was said, not even "still sending", and the looks stopped.
    expect(toasts.calls).toHaveLength(1);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("does not toast a veto of a cancel, whose events are about a NEW appointment, when they arrive before the answer", async () => {
    const answer = later<ActionResult>();
    render(<Page run={() => answer.promise} />);
    await mark();
    await live("booked", SUCCESSOR, "11.1");
    await live("vetoed", SUCCESSOR, "11.2");
    await act(async () => {
      answer.release({
        ok: true,
        message: "Change undone and the appointment locked.",
      });
    });
    expect(quiet()).toHaveLength(0);
  });

  it("does not toast a veto of a reschedule, whose events are about the SAME appointment, when they arrive before the answer", async () => {
    const answer = later<ActionResult>();
    render(<Page run={() => answer.promise} />);
    await mark();
    await live("rescheduled", APPT, "12.1");
    await live("vetoed", APPT, "12.2");
    await act(async () => {
      answer.release({
        ok: true,
        message: "Change undone and the appointment locked.",
      });
    });
    expect(quiet()).toHaveLength(0);
  });

  it("holds in another tab of the same person too: nothing here made the change, the actor is the same", async () => {
    render(<Page run={async () => ({ ok: true, message: "x" })} />);
    await live("arrived", APPT, "13.1");
    expect(quiet()).toHaveLength(0);
  });

  it("still toasts a colleague's change to the very same appointment", async () => {
    const answer = later<ActionResult>();
    render(<Page run={() => answer.promise} />);
    await mark();
    await live("rescheduled", APPT, "14.1", COLLEAGUE);
    expect(quiet()).toHaveLength(1);
    expect(quiet()[0].message).toContain("Rescheduled");
  });

  it("toasts an event that names no actor (nothing to say it is theirs)", async () => {
    render(<Page run={async () => ({ ok: true, message: "x" })} />);
    await live("booked", APPT, "15.1", null);
    expect(quiet()).toHaveLength(1);
  });

  it("says so when the call itself throws, and keeps working", async () => {
    render(
      <Page
        run={async () => {
          throw new Error("network");
        }}
      />,
    );
    await mark();
    expect(toasts.calls.map((c) => c.fn)).toEqual(["error"]);
    expect(toasts.calls[0].message).toBe("That did not go through. Try again.");
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });
});
