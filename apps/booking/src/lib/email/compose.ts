import { createElement } from "react";
import { render } from "@react-email/components";
import { formatWhen, zoneLabel } from "@/lib/clinic-time";
import { SITE } from "@/lib/site";
import {
  emailSubject,
  IdyllicEmail,
  type EmailData,
  type EmailKind,
} from "@/lib/email/idyllic-email";

export interface Composed {
  subject: string;
  html: string;
  text: string;
}

export interface Facts {
  kind: EmailKind;
  name: string;
  doctor: string;
  specialty: string;
  /** ISO times from the API; formatted here in `timezone`. */
  startsAt: string;
  /** The IANA zone of the clinic the appointment is at (the appointment's own `timezone`). */
  timezone: string;
  previousStartsAt?: string;
  reason?: string | null;
}

export function emailData(f: Facts): EmailData {
  return {
    kind: f.kind,
    name: f.name,
    doctor: f.doctor,
    specialty: f.specialty,
    when: formatWhen(f.startsAt, f.timezone),
    zone: zoneLabel(f.startsAt, f.timezone),
    previousWhen: f.previousStartsAt
      ? formatWhen(f.previousStartsAt, f.timezone)
      : undefined,
    reason: f.reason ?? undefined,
    siteUrl: SITE.url,
  };
}

// The HTML and the plain-text version of the same email, and its subject.
export async function compose(f: Facts): Promise<Composed> {
  const data = emailData(f);
  const element = createElement(IdyllicEmail, data);
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { subject: emailSubject(data), html, text };
}
