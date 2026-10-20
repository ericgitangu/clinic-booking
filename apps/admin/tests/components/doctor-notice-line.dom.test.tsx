// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const retried = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/actions", () => ({
  retryDoctorEmail: async () => {
    retried.calls += 1;
    return { ok: true, message: "Sending the email to the doctor again." };
  },
}));
vi.mock("@clinic/ui/lib/notify", () => ({
  notify: { info: () => undefined, error: () => undefined },
}));

import { DoctorNoticeLine } from "@/components/doctor-notice-line";
import type { DoctorNoticeView } from "@/lib/detail-read";

const pending: DoctorNoticeView = {
  id: "n",
  status: "pending",
  reason: null,
  attempts: 1,
  sentAt: null,
  retryable: false,
};

function answer(notice: DoctorNoticeView) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, notice }),
  }));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the doctor line on an open sheet", () => {
  it("moves from on its way to the time it went, by itself, through the effect", async () => {
    const fetchMock = answer({
      ...pending,
      status: "sent",
      sentAt: "2026-10-27T07:00:01Z",
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DoctorNoticeLine
        appointmentId="a"
        notice={pending}
        canAct
        reload={() => undefined}
      />,
    );
    const line = screen.getByTestId("sheet-doctor-notice");
    expect(line.textContent).toContain(
      "The email to the doctor is on its way.",
    );

    // The first look, straight away.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledWith("/dashboard/read/doctor-notice/a", {
      cache: "no-store",
    });
    expect(line.textContent).toContain("Doctor emailed at 10:00 EAT.");
    expect(line.textContent).not.toContain("on its way");
    expect(line.getAttribute("data-status")).toBe("sent");
  });

  it("turns into 'didn't go out' with the button once the row can be sent again", async () => {
    const stale = { ...pending, retryable: true };
    vi.stubGlobal("fetch", answer(stale));
    render(
      <DoctorNoticeLine
        appointmentId="a"
        notice={pending}
        canAct
        reload={() => undefined}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const line = screen.getByTestId("sheet-doctor-notice");
    expect(line.textContent).toContain(
      "The email didn't go out. Send it again.",
    );
    expect(
      screen.getByRole("button", { name: "Send the email again" }),
    ).toBeTruthy();
  });

  it("keeps looking past the first minute and stops when the tab is gone", async () => {
    const fetchMock = answer(pending);
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(
      <DoctorNoticeLine
        appointmentId="a"
        notice={pending}
        canAct
        reload={() => undefined}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    const looks = fetchMock.mock.calls.length;
    expect(looks).toBeGreaterThanOrEqual(5); // 0, 2.5, 6, 15, 30, 60 s
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200_000);
    });
    expect(fetchMock.mock.calls.length).toBe(looks);
  });

  it("once the resend is asked for, both the button and the words 'Send it again.' go, though the row is still retryable", async () => {
    retried.calls = 0;
    const stale = { ...pending, retryable: true };
    vi.stubGlobal("fetch", answer(stale));
    render(
      <DoctorNoticeLine
        appointmentId="a"
        notice={stale}
        canAct
        reload={() => undefined}
      />,
    );
    const line = screen.getByTestId("sheet-doctor-notice");
    // Before: the words and the button agree.
    expect(line.textContent).toContain("Send it again.");
    const button = screen.getByRole("button", { name: "Send the email again" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(retried.calls).toBe(1);
    // After: the button is gone, and so are the words that pointed at it.
    expect(
      screen.queryByRole("button", { name: "Send the email again" }),
    ).toBeNull();
    expect(line.textContent).not.toContain("Send it again");
    expect(line.textContent).toContain("The email didn't go out.");
  });

  it("without the right to act, a retryable row has neither the button nor the words", () => {
    const stale = { ...pending, retryable: true };
    vi.stubGlobal("fetch", answer(stale));
    render(
      <DoctorNoticeLine
        appointmentId="a"
        notice={stale}
        canAct={false}
        reload={() => undefined}
      />,
    );
    const line = screen.getByTestId("sheet-doctor-notice");
    expect(line.textContent).not.toContain("Send it again");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
