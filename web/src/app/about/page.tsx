import type { Metadata } from "next";
import { LegalPage } from "@/components/layout/legal-page";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Business case",
  description: `Why ${SITE.name} exists, who it serves and what this demo proves.`,
  alternates: { canonical: "/about" },
};
export const dynamic = "force-static";

const LINK = "text-primary underline underline-offset-4";
const README = "https://github.com/ericgitangu/clinic-booking";

export default function AboutPage() {
  return (
    <LegalPage title="Business case" updated="17 October 2026">
      <p className="rounded-md border border-border bg-muted px-4 py-3 text-sm">
        Illustrative, written for an assessment. This is my reading of the
        problem, not research, and it contains no figures from a real clinic.
      </p>

      <h2>The problem</h2>
      <p>
        Small private clinics in Kenya often book by phone call or WhatsApp
        message. Two people can be given the same slot, and patients forget or
        cannot easily cancel, so slots go unused. That is what I set out to fix.
      </p>

      <h2>Who it serves</h2>
      <ul>
        <li>Patients, who want to see free times and book without a call.</li>
        <li>
          The front desk, who want one list instead of a chat history to
          reconcile.
        </li>
        <li>Doctors, who want a day that is not double booked.</li>
      </ul>

      <h2>What this demo proves</h2>
      <ul>
        <li>
          Conflict-free booking: the database itself refuses a second booking
          for the same doctor and time.
        </li>
      </ul>

      <h2>Planned next</h2>
      <p>These are being built and are not live yet.</p>
      <ul>
        <li>Email reminders the day before a visit.</li>
        <li>An admin view of the day for the front desk.</li>
      </ul>

      <h2>How it could grow</h2>
      <ul>
        <li>More than one clinic on the same system.</li>
        <li>A slot length set per doctor.</li>
        <li>M-Pesa deposits to reduce no-shows.</li>
        <li>SMS reminders for patients who do not read email.</li>
      </ul>

      <h2>What it does not do, and the risks</h2>
      <ul>
        <li>It is not a medical record system and gives no medical advice.</li>
        <li>It has no payments, insurance handling or video visits today.</li>
        <li>
          Real patient data would need a data residency and security review
          first. See{" "}
          <a className={LINK} href="/data">
            data handling
          </a>
          .
        </li>
        <li>
          I have not tested it with real clinic staff, so how well it fits their
          day is an assumption.
        </li>
      </ul>

      <h2>Why it is built this way</h2>
      <p>
        The design and the trade-offs are written up in the README, in{" "}
        <a
          className={LINK}
          href={`${README}#3-system-design`}
          rel="noopener noreferrer"
          target="_blank"
        >
          section 3, system design
        </a>{" "}
        and{" "}
        <a
          className={LINK}
          href={`${README}#4-key-decisions--trade-offs`}
          rel="noopener noreferrer"
          target="_blank"
        >
          section 4, key decisions and trade-offs
        </a>
        .
      </p>
    </LegalPage>
  );
}
