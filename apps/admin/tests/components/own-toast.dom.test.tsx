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
  calls: [] as { fn: string; message: string; id?: string }[],
}));
vi.mock("@clinic/ui/lib/notify", () => {
  const rec = (fn: string) => (message: string, data?: { id?: string }) =>
    void toasts.calls.push({ fn, message, id: data?.id });
  return {
    notify: {
      success: rec("success"),
      info: rec("info"),
      warning: rec("warning"),
      error: rec("error"),
      quiet: rec("quiet"),
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

const arrivedEvent = (appointmentId: string, seq: string) =>
  JSON.stringify({
    event_type: "arrived",
    doctor_id: DOCTOR,
    local_date: "2026-10-27",
    from_local_date: null,
    from_starts_at: null,
    to_starts_at: "2026-10-27T07:00:00.000000Z",
    seq,
    appointment_id: appointmentId,
    patient_name: "Wanjiru Kamau",
    cancellation_reason: null,
    actor_email: null,
    actor_role: null,
    staff_reason: null,
  });

const live = (appointmentId: string, seq: string) =>
  act(async () => {
    stream.listener?.onEvent(
      seq,
      "arrived",
      arrivedEvent(appointmentId, seq),
      false,
    );
  });

function Page({
  run,
  owns = APPT,
}: {
  run: () => Promise<ActionResult>;
  owns?: string;
}) {
  return (
    <>
      <LiveNotifications
        role="owner"
        person="p"
        doctors={[{ id: DOCTOR, name: "Dr. Otieno" }]}
      />
      <ConfirmAction
        trigger={<Button>Mark arrived</Button>}
        title="Mark as arrived?"
        description="d"
        confirmLabel="Confirm"
        ownsAppointment={owns}
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
    // The gateway sends this person's own arrival back to them: no second toast for it.
    await live(APPT, "10.1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    const mine = toasts.calls;
    expect(mine.some((c) => c.fn === "quiet")).toBe(false); // the live toast stayed away
    expect(new Set(mine.map((c) => c.id)).size).toBe(1); // one toast, updated in place
    expect(mine[0].message).toBe("Marked arrived. Doctor email on its way.");
    expect(mine.at(-1)).toMatchObject({
      fn: "success",
      message: "Marked arrived. Doctor emailed.",
    });
  });

  it("does not hide a colleague's change to the same appointment when this one failed", async () => {
    render(<Page run={async () => ({ ok: false, message: "Not allowed." })} />);
    await mark();
    expect(toasts.calls.map((c) => c.fn)).toEqual(["error"]);
    await live(APPT, "10.2");
    expect(toasts.calls.filter((c) => c.fn === "quiet")).toHaveLength(1);
  });

  it("does not toast again for an appointment a veto booked as the successor", async () => {
    render(
      <Page
        run={async () => ({
          ok: true,
          message: "Change undone and the appointment locked.",
          alsoOwns: [SUCCESSOR],
        })}
      />,
    );
    await mark();
    await live(SUCCESSOR, "10.3");
    expect(toasts.calls.filter((c) => c.fn === "quiet")).toHaveLength(0);
  });

  it("still toasts for someone else's change to a different appointment", async () => {
    render(<Page run={async () => ({ ok: true, message: "Done." })} />);
    await mark();
    await live("9f9d2c3b-4a5e-6f70-8192-a3b4c5d6e7aa", "10.4");
    expect(toasts.calls.filter((c) => c.fn === "quiet")).toHaveLength(1);
  });
});
