import { describe, expect, it, vi } from "vitest";
import {
  noticeOfInvite,
  noticeToPatient,
  type Senders,
} from "@/lib/staff-mail";

const caller = {
  sub: "s",
  email: "admin@clinic.test",
  role: "admin" as const,
  emailVerified: true,
};
const change = {
  audit_id: "aud-1",
  patient_email: "mwangi@mailbox.co.ke",
  patient_name: "Mwangi Kamau",
  doctor_name: "Dr Achieng",
  starts_at: "2026-11-02T07:00:00Z",
  timezone: "Africa/Nairobi",
  previous_starts_at: "2026-11-01T07:00:00Z",
};
const done = {
  auditId: "aud-1",
  outcome: "sent",
  sent: true,
  notified: true,
} as const;

function senders() {
  const staff = vi.fn(async () => done);
  const invite = vi.fn(async () => done);
  return { staff, invite } as unknown as Senders & {
    staff: ReturnType<typeof vi.fn>;
    invite: ReturnType<typeof vi.fn>;
  };
}

describe("the patient's email after a staff action", () => {
  it.each([
    ["booked", "booked"],
    ["rescheduled", "moved"],
    ["cancelled", "cancelled"],
    ["vetoed", "restored"],
  ] as const)(
    "%s sends one email, keyed on the audit row",
    async (kind, word) => {
      const s = senders();
      await noticeToPatient(kind, caller, change, "clinic needs it", s);
      expect(s.staff).toHaveBeenCalledTimes(1);
      const arg = s.staff.mock.calls[0]![0];
      expect(arg.auditId).toBe("aud-1");
      expect(arg.to).toBe("mwangi@mailbox.co.ke");
      expect(arg.deliver).toBe(true);
      expect(arg.caller).toBe(caller);
      expect(arg.mail.subject).toContain(word);
      expect(JSON.stringify(arg.mail)).toContain("clinic needs it");
    },
  );

  it("passes the previous time into a move and a veto", async () => {
    const s = senders();
    await noticeToPatient("rescheduled", caller, change, "reason", s);
    expect(JSON.stringify(s.staff.mock.calls[0]![0].mail)).toContain("Was");
  });

  it("gives the sender an empty id when the write left no audit row, so nothing is sent", async () => {
    const s = senders();
    await noticeToPatient(
      "cancelled",
      caller,
      { ...change, audit_id: null },
      "reason",
      s,
    );
    expect(s.staff.mock.calls[0]![0].auditId).toBe("");
  });

  it("a visit with no email on file still goes to the sender, which refuses it", async () => {
    const s = senders();
    await noticeToPatient(
      "booked",
      caller,
      { ...change, patient_email: null },
      "reason",
      s,
    );
    expect(s.staff.mock.calls[0]![0].to).toBeNull();
  });
});

describe("the invitation email", () => {
  it("carries the invite id, audit id, deliver flag and the one-time token", async () => {
    const s = senders();
    await noticeOfInvite(
      caller,
      {
        id: "inv-1",
        audit_id: "aud-2",
        email: "new@example.com",
        deliver: false,
        role: "viewer",
        expires_at: "2026-11-05T00:00:00Z",
        token: "fake-invite",
      },
      s,
    );
    expect(s.invite).toHaveBeenCalledWith({
      caller,
      inviteId: "inv-1",
      auditId: "aud-2",
      to: "new@example.com",
      deliver: false,
      role: "viewer",
      expiresAt: "2026-11-05T00:00:00Z",
      token: "fake-invite",
    });
  });
});
