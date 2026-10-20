import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/actions", () => ({
  retryDoctorEmail: async () => ({ ok: true, message: "" }),
}));

import { DoctorNoticeLine } from "@/components/doctor-notice-line";
import type { DoctorNoticeView } from "@/lib/detail-read";

const notice = (over: Partial<DoctorNoticeView>): DoctorNoticeView => ({
  id: "n",
  status: "pending",
  reason: null,
  attempts: 0,
  sentAt: null,
  retryable: false,
  ...over,
});
const html = (n: DoctorNoticeView, canAct = true) =>
  renderToStaticMarkup(
    <DoctorNoticeLine
      appointmentId="a"
      notice={n}
      canAct={canAct}
      reload={() => undefined}
    />,
  );

describe("the doctor line on the appointment sheet", () => {
  it("says the doctor was notified only for a sent email", () => {
    const sent = html(
      notice({ status: "sent", sentAt: "2026-10-27T07:00:01Z" }),
    );
    expect(sent).toContain("Doctor emailed at 10:00 EAT.");
    expect(sent).not.toContain("Doctor notified");
    for (const n of [
      notice({}),
      notice({ status: "failed", attempts: 3 }),
      notice({ status: "skipped", reason: "no_email" }),
    ])
      expect(html(n)).not.toMatch(/Doctor (notified|emailed)/);
    expect(html(notice({ status: "skipped", reason: "no_email" }))).toContain(
      "Doctor not notified.",
    );
  });

  it("offers a resend for a failed email with tries left and for a pending one nothing is sending", () => {
    expect(
      html(notice({ status: "failed", attempts: 1, retryable: true })),
    ).toContain("Send the email again");
    expect(html(notice({ status: "pending", retryable: true }))).toContain(
      "Send the email again",
    );
  });

  it("points at the button only when it is there", () => {
    const stale = notice({ status: "pending", retryable: true });
    const asAdmin = html(stale, true);
    expect(asAdmin).toContain("Send it again.");
    expect(asAdmin).toContain("Send the email again");
    const asViewer = html(stale, false).replaceAll("&#x27;", "'");
    expect(asViewer).toContain("The email didn't go out.");
    expect(asViewer).not.toContain("Send it again.");
    expect(asViewer).not.toContain("Send the email again");
    const failed = notice({ status: "failed", attempts: 1, retryable: true });
    expect(html(failed, true)).toContain("Send it again.");
    expect(html(failed, false)).not.toContain("Send it again");
  });

  it("is a polite live region, so a change of state is announced", () => {
    expect(html(notice({}))).toContain('aria-live="polite"');
  });

  it("offers no resend while it is on its way, when nothing is left to try, or to a viewer", () => {
    expect(html(notice({}))).not.toContain("Send the email again");
    expect(html(notice({ status: "failed", attempts: 3 }))).not.toContain(
      "Send the email again",
    );
    expect(
      html(notice({ status: "failed", retryable: true }), false),
    ).not.toContain("Send the email again");
  });
});
