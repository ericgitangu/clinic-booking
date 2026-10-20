import { describe, expect, it, vi } from "vitest";
import { doctorEmailSuffix } from "@/lib/doctor-notice-read";
import {
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
      sheetLine({ ...base, status: "sent", sentAt: "2026-10-27T07:00:01Z" }),
    ).toMatch(/^Doctor notified by email at .*10:00/);
    expect(sheetLine({ ...base, status: "skipped", reason: "no_email" })).toBe(
      "The doctor was not emailed: the doctor has no email address on file.",
    );
    expect(sheetLine({ ...base, status: "failed", attempts: 2 })).toContain(
      "2 tries",
    );
    expect(sheetLine(base)).toBe("The email to the doctor is on its way.");
  });
});

describe("doctorEmailSuffix", () => {
  const view = (over: Partial<DoctorNoticeView>): DoctorNoticeView => ({
    id: "n",
    status: "pending",
    reason: null,
    attempts: 0,
    sentAt: null,
    ...over,
  });

  it("says nothing when the state cannot be read", async () => {
    const add = vi.fn();
    await doctorEmailSuffix("a", add, async () => null);
    expect(add).not.toHaveBeenCalled();
  });

  it("reports a skipped email once, with the reason", async () => {
    const add = vi.fn();
    const read = vi.fn(async () =>
      view({ status: "skipped", reason: "no_email" }),
    );
    await doctorEmailSuffix("a", add, read);
    expect(add.mock.calls).toEqual([["email not sent (no doctor email)"]]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads again while pending and reports the final state", async () => {
    const add = vi.fn();
    const answers = [
      view({}),
      view({ status: "sent", sentAt: "2026-10-27T07:00:01Z" }),
    ];
    const read = vi.fn(async () => answers.shift() ?? null);
    const wait = vi.fn(async () => undefined);
    await doctorEmailSuffix("a", add, read, wait);
    expect(add.mock.calls).toEqual([
      ["doctor email on its way"],
      ["doctor emailed"],
    ]);
    expect(wait).toHaveBeenCalledTimes(1);
  });
});
