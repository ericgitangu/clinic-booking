import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorNoticeFinish } from "@clinic/api/generated";
import { doctorArrived, firstNameAndInitial } from "@/emails";
import {
  sendDoctorArrival,
  sendKey,
  type DoctorNoticePorts,
} from "@/emails/doctor-arrival";
import { SITE } from "@/lib/site";

const ID = "6f0c1a52-3f0e-4c0e-9d57-0b6f1c2f8a11";
const APPT = "0f1d2c3b-4a5e-6f70-8192-a3b4c5d6e7f8";
const caller = {
  sub: "s",
  email: "admin@clinic.example",
  role: "admin",
} as never;

const job = {
  id: ID,
  appointment_id: APPT,
  attempt: 1,
  doctor_email: "dr.otieno@clinic.co.ke",
  doctor_name: "Dr. Achieng Otieno",
  patient_name: "Wanjiru Kamau Mwangi",
  starts_at: "2026-10-27T07:00:00Z",
  timezone: "Africa/Nairobi",
};

function ports(over: Partial<DoctorNoticePorts> = {}) {
  const finished: DoctorNoticeFinish[] = [];
  const sends: { to: string; key: string; text: string; html: string }[] = [];
  const p: DoctorNoticePorts = {
    claim: async () => ({ ok: true, data: job }),
    finish: async (_c, _id, body) => {
      finished.push(body);
      return { ok: true, data: true };
    },
    reserve: async () => ({
      ok: true,
      data: {
        granted: true,
        reason: null,
        day: "2026-10-27",
        month: "2026-10-01",
        budget: {} as never,
      },
    }),
    release: vi.fn(async () => ({ ok: true as const, data: true as const })),
    send: async (to, mail, key) => {
      sends.push({ to, key, text: mail.text, html: mail.html });
      return { ok: true, id: "re_1" };
    },
    markNotified: async () => ({ ok: true, data: true }),
    ...over,
  };
  return { p, finished, sends };
}

describe("the Patient arrived email", () => {
  it("names the patient by first name and last initial and nothing else about them", () => {
    expect(firstNameAndInitial("Wanjiru Kamau Mwangi")).toBe("Wanjiru M.");
    expect(firstNameAndInitial("  amina  ")).toBe("Patient A.");
    const mail = doctorArrived({
      patientName: "Wanjiru Kamau Mwangi",
      doctor: "Dr. Achieng Otieno",
      startsAt: "2026-10-27T07:00:00Z",
      timezone: "Africa/Nairobi",
      appointmentId: APPT,
    });
    for (const body of [mail.html, mail.text, mail.subject]) {
      expect(body).not.toContain("Kamau");
      expect(body).not.toContain("Mwangi");
      expect(body).not.toMatch(/\+254|@example|phone|notes?:/i);
    }
    expect(mail.subject).toBe(
      "Wanjiru M. has arrived for Tuesday 27 October, 10:00",
    );
    expect(mail.text).toContain("East Africa Time (GMT+03:00)");
    expect(mail.text).toContain(`${SITE.url}/dashboard/appointments/${APPT}`);
    expect(mail.html).toContain(
      `href="${SITE.url}/dashboard/appointments/${APPT}"`,
    );
    expect(mail.text).not.toMatch(/<[a-z][^>]*>/i);
    expect(Object.keys(mail).sort()).toEqual(["html", "subject", "text"]);
  });
});

describe("firstNameAndInitial reads a free-text name with care", () => {
  it.each([
    ["Kamau, Amina", "Amina K."],
    ["Kamau,Amina Wanjiru", "Amina K."],
    ["Amina Wanjiru Kamau", "Amina K."],
    ["Mary-Anne O'Brien", "Mary-Anne O."],
    ["AminaWanjiru", "Patient A."],
    ["Kamau,", "Patient K."],
    ["  ,  ", "A patient"],
    ["", "A patient"],
    ["Amina (Mina) K.", "Amina K."],
  ])("%s -> %s", (name, shown) => {
    expect(firstNameAndInitial(name)).toBe(shown);
  });

  it("never lets the rest of a name into the email", () => {
    for (const name of [
      "Kamau, Amina",
      "AminaWanjiru",
      "Wanjiru Kamau Mwangi",
    ]) {
      const mail = doctorArrived({
        patientName: name,
        doctor: "Dr. Otieno",
        startsAt: "2026-10-27T07:00:00Z",
        appointmentId: APPT,
      });
      for (const part of ["Kamau", "Wanjiru", "Mwangi", "AminaWanjiru"]) {
        if (
          name.includes(part) &&
          !firstNameAndInitial(name).startsWith(part)
        ) {
          expect(mail.html + mail.text + mail.subject).not.toContain(part);
        }
      }
    }
  });
});

describe("sendDoctorArrival", () => {
  beforeEach(() => vi.stubEnv("RESEND_API_KEY", "re_test_key_value"));
  afterEach(() => vi.unstubAllEnvs());

  it("sends once under the notification's key and records it as sent only after the provider accepted", async () => {
    const t = ports();
    const out = await sendDoctorArrival({ caller, id: ID }, t.p);
    expect(out).toBe("sent");
    expect(t.sends).toHaveLength(1);
    expect(t.sends[0].to).toBe("dr.otieno@clinic.co.ke");
    expect(t.sends[0].key).toBe(sendKey(ID, "dr.otieno@clinic.co.ke"));
    expect(t.finished).toEqual([
      { attempt: 1, outcome: "sent", provider_id: "re_1" },
    ]);
    expect(t.p.release).not.toHaveBeenCalled();
  });

  it("sends nothing when the API hands out nothing (already sent, skipped, or held)", async () => {
    const t = ports({ claim: async () => ({ ok: true, data: null }) });
    expect(await sendDoctorArrival({ caller, id: ID }, t.p)).toBe(
      "nothing-to-send",
    );
    expect(t.sends).toHaveLength(0);
    expect(t.finished).toEqual([]);
  });

  it.each([
    ["day", "allowance_day"],
    ["month", "allowance_month"],
  ] as const)(
    "a spent %s allowance is recorded as skipped and nothing is sent",
    async (cap, reason) => {
      const t = ports({
        reserve: async () => ({
          ok: true,
          data: {
            granted: false,
            reason: cap,
            day: "2026-10-27",
            month: "2026-10-01",
            budget: {} as never,
          },
        }),
      });
      expect(await sendDoctorArrival({ caller, id: ID }, t.p)).toBe("cap-hit");
      expect(t.sends).toHaveLength(0);
      expect(t.finished).toEqual([{ attempt: 1, outcome: "skipped", reason }]);
    },
  );

  it("an allowance that cannot be checked fails closed: nothing sent, recorded as failed", async () => {
    const t = ports({
      reserve: async () => ({ ok: false, code: "UPSTREAM_UNREACHABLE" }),
    });
    expect(await sendDoctorArrival({ caller, id: ID }, t.p)).toBe(
      "reserve-failed",
    );
    expect(t.sends).toHaveLength(0);
    expect(t.finished[0].outcome).toBe("failed");
  });

  it("a provider refusal gives the unit back, records a failure without the address, and can be tried again", async () => {
    const t = ports({
      send: async () => ({ ok: false, reason: "rejected", status: 422 }),
    });
    expect(await sendDoctorArrival({ caller, id: ID }, t.p)).toBe(
      "send-failed",
    );
    // Only the day and month go back: the API refuses a body with anything else.
    expect(t.p.release).toHaveBeenCalledWith(caller, {
      day: "2026-10-27",
      month: "2026-10-01",
    });
    expect(t.finished).toHaveLength(1);
    expect(t.finished[0].outcome).toBe("failed");
    expect(t.finished[0].error).not.toContain("clinic.co.ke");
  });

  it("records the email as not set up here when there is no provider key", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const t = ports();
    expect(await sendDoctorArrival({ caller, id: ID }, t.p)).toBe(
      "not-configured",
    );
    expect(t.finished).toEqual([
      { attempt: 1, outcome: "skipped", reason: "not_configured" },
    ]);
    expect(t.sends).toHaveLength(0);
  });

  it("never throws, and gives the unit back when the sender blows up", async () => {
    const t = ports({
      send: async () => {
        throw new TypeError("boom for dr.otieno@clinic.co.ke");
      },
    });
    expect(await sendDoctorArrival({ caller, id: ID }, t.p)).toBe("error");
    expect(t.p.release).toHaveBeenCalledTimes(1);
    // Said at once, for the attempt that was claimed, so a resend is offered now and not after the
    // 15 minute claim.
    expect(t.finished).toEqual([
      { attempt: 1, outcome: "failed", error: "Unexpected error." },
    ]);
  });

  it("a claim call that fails sends nothing, records nothing and says so", async () => {
    const t = ports({
      claim: async () => ({ ok: false, code: "UPSTREAM_UNREACHABLE" }),
    });
    expect(await sendDoctorArrival({ caller, id: ID }, t.p)).toBe(
      "claim-failed",
    );
    expect(t.sends).toHaveLength(0);
    expect(t.finished).toEqual([]);
    expect(t.p.release).not.toHaveBeenCalled();
  });

  it("tries again to record a send that went out, and does not send twice or reserve twice", async () => {
    let calls = 0;
    const t = ports({
      finish: async (_c, _id, body) => {
        calls += 1;
        if (calls < 2) return { ok: false, code: "UPSTREAM_UNREACHABLE" };
        t.finished.push(body);
        return { ok: true, data: true };
      },
    });
    const reserve = vi.spyOn(t.p, "reserve");
    expect(await sendDoctorArrival({ caller, id: ID }, t.p)).toBe("sent");
    expect(calls).toBe(2); // two tries at most: the path stays inside its 25 s
    expect(t.sends).toHaveLength(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(t.finished).toEqual([
      { attempt: 1, outcome: "sent", provider_id: "re_1" },
    ]);
  });

  it("names the attempt the claim returned in every result", async () => {
    const t = ports({
      claim: async () => ({ ok: true, data: { ...job, attempt: 2 } }),
    });
    await sendDoctorArrival({ caller, id: ID }, t.p);
    expect(t.finished[0].attempt).toBe(2);
  });
});

describe("the send key", () => {
  it("is the same for the same address and new for a corrected one (Resend refuses a reused key with a different payload for 24 hours)", () => {
    expect(sendKey(ID, "dr@clinic.co.ke")).toBe(
      sendKey(ID, " Dr@Clinic.co.ke "),
    );
    expect(sendKey(ID, "dr@clinic.co.ke")).not.toBe(
      sendKey(ID, "doctor@clinic.co.ke"),
    );
    expect(sendKey(ID, "dr@clinic.co.ke")).not.toContain("clinic.co.ke");
    expect(sendKey(ID, "dr@clinic.co.ke")).toMatch(
      new RegExp(`^doctor-arrival/${ID}/[0-9a-f]{12}$`),
    );
  });
});
