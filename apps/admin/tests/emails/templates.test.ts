import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  staffBooked,
  staffCancelled,
  staffInvite,
  staffRemind,
  staffRescheduled,
  staffRunningLate,
  staffVetoed,
} from "@/emails";
import { SITE } from "@/lib/site";

const appt = {
  name: "Amina Wanjiku",
  doctor: "Dr. Achieng Otieno",
  startsAt: "2026-10-20T09:00:00+03:00",
  timezone: "Africa/Nairobi",
};
const reason = "The doctor is on call that morning, so we moved you.";

const TOKEN = "Zq3_tOkEn-abcDEF0123456789abcdefghijklmnopqr";

const all = {
  staffBooked: () => staffBooked({ ...appt, reason }),
  staffRescheduled: () =>
    staffRescheduled({
      ...appt,
      reason,
      previousStartsAt: "2026-10-19T14:30:00+03:00",
    }),
  staffCancelled: () => staffCancelled({ ...appt, reason }),
  staffVetoed: () =>
    staffVetoed({
      ...appt,
      reason,
      previousStartsAt: "2026-10-21T11:00:00+03:00",
    }),
  staffRemind: () => staffRemind(appt),
  staffRunningLate: () =>
    staffRunningLate({ ...appt, minutes: 25, reason: "A late emergency." }),
  staffInvite: () =>
    staffInvite({
      role: "viewer",
      token: TOKEN,
      expiresAt: "2026-10-21T18:00:00+03:00",
    }),
} as const;

describe("staff email templates", () => {
  it.each(Object.entries(all))("%s: subject, html and text", (_n, make) => {
    const mail = make();
    expect(mail.subject).toMatchSnapshot("subject");
    expect(mail.html).toMatchSnapshot("html");
    expect(mail.text).toMatchSnapshot("text");
    expect(Object.keys(mail).sort()).toEqual(["html", "subject", "text"]);
    expect(mail.html).not.toContain("undefined");
    expect(mail.text).not.toContain("undefined");
    expect(mail.text).not.toMatch(/<[a-z][^>]*>/i);
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).toContain(`${SITE.url}/brand/idyllic-mark.png`);
  });

  it("shows East Africa Time and the clinic name", () => {
    const m = staffBooked({ ...appt, reason });
    expect(m.subject).toBe(
      "Your appointment has been booked: Tuesday 20 October, 09:00",
    );
    expect(m.html).toContain("East Africa Time (GMT+03:00)");
    expect(m.text).toContain("East Africa Time (GMT+03:00)");
    expect(m.html).toContain("Idyllic Clinic");
    expect(m.html).not.toContain("Idyllic Clinic Booking");
  });

  it("converts an instant given in UTC to Nairobi time", () => {
    const m = staffCancelled({
      ...appt,
      startsAt: "2026-10-20T06:00:00Z",
      reason,
    });
    expect(m.subject).toBe(
      "Your appointment on Tuesday 20 October, 09:00 has been cancelled",
    );
  });

  it.each([
    "staffBooked",
    "staffRescheduled",
    "staffCancelled",
    "staffVetoed",
  ] as const)("%s shows the reason to the patient", (n) => {
    const m = all[n]();
    expect(m.html).toContain(`Reason from the clinic: ${reason}`);
    expect(m.text).toContain(`Reason from the clinic: ${reason}`);
  });

  it("shows the old time on a moved visit and on a reversed change", () => {
    expect(all.staffRescheduled().text).toContain(
      "Was: Monday 19 October, 14:30",
    );
    expect(all.staffVetoed().text).toContain(
      "You had moved it to: Wednesday 21 October, 11:00",
    );
  });

  it("tells a vetoed patient the visit is locked", () => {
    expect(all.staffVetoed().text).toContain("locked");
  });

  it("running late names the delay", () => {
    const m = all.staffRunningLate();
    expect(m.subject).toBe(
      "Dr. Achieng Otieno is running about 25 minutes late today",
    );
    expect(staffRunningLate({ ...appt, minutes: 1 }).subject).toContain(
      "1 minute late",
    );
  });
});

describe("escaping", () => {
  const nasty = `<script>alert("x")</script> & 'quotes' "double"`;

  it.each(Object.keys(all).filter((n) => n !== "staffInvite"))(
    "%s escapes a reason full of markup",
    (n) => {
      const make = {
        staffBooked: staffBooked,
        staffRescheduled: staffRescheduled,
        staffCancelled: staffCancelled,
        staffVetoed: staffVetoed,
        staffRemind: staffRemind,
        staffRunningLate: (f: Parameters<typeof staffBooked>[0]) =>
          staffRunningLate({ ...f, minutes: 10 }),
      }[n as string]!;
      const m = make({ ...appt, reason: nasty });
      expect(m.html).not.toContain("<script");
      expect(m.html).toContain(
        "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39; &quot;double&quot;",
      );
      // the plain-text version is not HTML: the reason stays as it was written
      expect(m.text).toContain(nasty);
    },
  );

  it("escapes names and the doctor too", () => {
    const m = staffBooked({
      ...appt,
      name: `<img src=x onerror=alert(1)>`,
      doctor: `Dr <b>Bold</b>`,
      reason,
    });
    expect(m.html).not.toContain("<img src=x");
    expect(m.html).not.toContain("<b>Bold");
    expect(m.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("keeps a line break out of the subject", () => {
    const m = staffRunningLate({
      ...appt,
      doctor: "Dr A\r\nBcc: x@y.test",
      minutes: 5,
    });
    expect(m.subject).not.toMatch(/[\r\n]/);
  });

  it("escapeHtml covers the five characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("the invite", () => {
  const m = staffInvite({
    role: "admin",
    token: TOKEN,
    expiresAt: "2026-10-21T18:00:00+03:00",
  });

  it("carries the token in the URL path on the admin origin, once per part", () => {
    const link = `${SITE.url}/invite/${TOKEN}`;
    expect(m.html).toContain(`href="${link}"`);
    expect(m.text).toContain(link);
    expect(m.html.split(TOKEN).length - 1).toBe(1);
    expect(m.text.split(TOKEN).length - 1).toBe(1);
  });

  it("never puts the token in a query string, a fragment or the subject", () => {
    for (const part of [m.html, m.text]) {
      expect(part).not.toMatch(/[?&#]token=/i);
      expect(part).not.toContain(`?${TOKEN}`);
      expect(part).not.toContain(`#${TOKEN}`);
      expect(part).not.toMatch(/invite\?/);
    }
    expect(m.subject).not.toContain(TOKEN);
  });

  it("encodes a token that is not path-safe instead of letting it break out", () => {
    const odd = staffInvite({
      role: "viewer",
      token: "a/b?c=d#e",
      expiresAt: "2026-10-21T18:00:00+03:00",
    });
    expect(odd.text).toContain(`${SITE.url}/invite/a%2Fb%3Fc%3Dd%23e`);
  });

  it("says who can do what and until when", () => {
    expect(m.text).toContain("Role: admin");
    expect(m.text).toContain(
      "Open until Wednesday 21 October, 18:00, East Africa Time (GMT+03:00)",
    );
    const v = staffInvite({
      role: "viewer",
      token: TOKEN,
      expiresAt: "2026-10-21T18:00:00+03:00",
    });
    expect(v.text).toContain("viewer");
  });
});
