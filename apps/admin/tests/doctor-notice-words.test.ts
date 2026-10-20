import { describe, expect, it, vi } from "vitest";
import { RECHECK_AFTER_MS, doctorEmailSuffix } from "@/lib/doctor-notice-read";
import {
  arrivalMessage,
  sheetLead,
  sheetLine,
  toastSuffix,
  type NoticeFacts,
} from "@/lib/doctor-notice-words";
import type { DoctorNoticeView } from "@/lib/detail-read";

const base: NoticeFacts = {
  status: "pending",
  reason: null,
  attempts: 0,
  sentAt: null,
};

describe("what the toast and the sheet say about the doctor's email", () => {
  it("says it plainly for each state", () => {
    expect(
      toastSuffix({ ...base, status: "sent", sentAt: "2026-10-27T07:00:01Z" }),
    ).toBe("doctor emailed");
    expect(toastSuffix(base)).toBe("doctor email on its way");
    expect(toastSuffix({ ...base, status: "failed", attempts: 1 })).toBe(
      "doctor email failed",
    );
    expect(
      toastSuffix({ ...base, status: "skipped", reason: "no_email" }),
    ).toBe("email not sent (no doctor email)");
    expect(
      toastSuffix({ ...base, status: "skipped", reason: "allowance_day" }),
    ).toBe("email not sent (today's email limit is used up)");
  });

  it("gives the sheet the time it went, or the reason it did not", () => {
    expect(
      sheetLine(
        { ...base, status: "sent", sentAt: "2026-10-27T07:00:01Z" },
        true,
      ),
    ).toBe("Doctor emailed at 10:00 EAT.");
    expect(
      sheetLine({ ...base, status: "skipped", reason: "no_email" }, true),
    ).toBe(
      "The doctor was not emailed: the doctor has no email address on file.",
    );
    expect(
      sheetLine({ ...base, status: "failed", attempts: 2 }, true),
    ).toContain("2 tries");
    expect(sheetLine(base, true)).toBe(
      "The email to the doctor is on its way.",
    );
    // Pending but nothing is sending it any more: it did not go out, so say that, not "on its way".
    expect(sheetLine({ ...base, retryable: true }, true)).toBe(
      "The email didn't go out. Send it again.",
    );
    expect(sheetLine({ ...base, retryable: true }, true)).not.toContain(
      "on its way",
    );
    expect(toastSuffix({ ...base, retryable: true })).toBe(
      "doctor email did not go out",
    );
  });
});

describe("'Send it again.' is said only when the button is there", () => {
  const stale = { ...base, retryable: true };
  const failed = {
    ...base,
    status: "failed" as const,
    attempts: 1,
    retryable: true,
  };

  it("says it when the person can resend, and not when they cannot", () => {
    expect(sheetLine(stale, true)).toBe(
      "The email didn't go out. Send it again.",
    );
    expect(sheetLine(stale, false)).toBe("The email didn't go out.");
    expect(sheetLine(failed, true)).toContain("Send it again.");
    expect(sheetLine(failed, false)).not.toContain("Send it again");
    expect(sheetLine(failed, false)).toContain("could not be sent (1 try)");
  });
});

describe("the lead and the arrival message follow the status", () => {
  it("says 'notified' only when the doctor was", () => {
    // A sent email has no lead: its line, "Doctor emailed at 10:00 EAT.", says it all.
    expect(sheetLead({ ...base, status: "sent" })).toBe("");
    for (const status of ["pending", "failed", "skipped"] as const)
      expect(sheetLead({ ...base, status })).toMatch(/^Doctor not notified/);
    expect(sheetLead({ ...base, status: "pending" })).toBe(
      "Doctor not notified yet.",
    );
    expect(sheetLead({ ...base, retryable: true })).toBe(
      "Doctor not notified.",
    );
  });

  it("gives the person who marked the arrival one message with the email's state", () => {
    expect(arrivalMessage(null)).toBe("Marked arrived.");
    expect(arrivalMessage({ status: "pending", reason: null })).toBe(
      "Marked arrived. Doctor email on its way.",
    );
    expect(arrivalMessage({ status: "skipped", reason: "no_email" })).toBe(
      "Marked arrived. Email not sent (no doctor email).",
    );
  });
});

describe("doctorEmailSuffix", () => {
  const view = (over: Partial<DoctorNoticeView>): DoctorNoticeView => ({
    id: "n",
    status: "pending",
    reason: null,
    attempts: 0,
    sentAt: null,
    retryable: false,
    ...over,
  });
  const yes = () => true;
  const sent = view({ status: "sent", sentAt: "2026-10-27T07:00:01Z" });

  it("says nothing when the state cannot be read", async () => {
    const add = vi.fn();
    const wait = vi.fn(async () => undefined);
    await doctorEmailSuffix("a", add, yes, async () => null, wait);
    expect(add).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledTimes(RECHECK_AFTER_MS.length); // it keeps looking, then stops
  });

  it("reports a skipped email once, with the reason", async () => {
    const add = vi.fn();
    const read = vi.fn(async () =>
      view({ status: "skipped", reason: "no_email" }),
    );
    await doctorEmailSuffix("a", add, yes, read);
    expect(add.mock.calls).toEqual([["email not sent (no doctor email)"]]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("looks again at 2.5 s, 6 s and 15 s while pending, then stops", async () => {
    const add = vi.fn();
    const waits: number[] = [];
    const read = vi.fn(async () => view({}));
    await doctorEmailSuffix(
      "a",
      add,
      yes,
      read,
      async (ms) => void waits.push(ms),
    );
    expect(waits).toEqual([2500, 3500, 9000]); // the gaps between reads at 2.5, 6 and 15 s
    expect(read).toHaveBeenCalledTimes(4);
    expect(add).toHaveBeenCalledTimes(4);
  });

  it("a send that finishes after the second look still updates the toast", async () => {
    const add = vi.fn();
    const answers = [view({}), view({}), view({}), sent];
    const read = vi.fn(async () => answers.shift() ?? null);
    await doctorEmailSuffix("a", add, yes, read, async () => undefined);
    expect(add.mock.calls.at(-1)).toEqual(["doctor emailed"]);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("stops asking once the toast is gone", async () => {
    const add = vi.fn();
    let up = true;
    const read = vi.fn(async () => {
      up = false; // swiped away after the first look
      return view({});
    });
    await doctorEmailSuffix(
      "a",
      add,
      () => up,
      read,
      async () => undefined,
    );
    expect(read).toHaveBeenCalledTimes(1);
  });
});
