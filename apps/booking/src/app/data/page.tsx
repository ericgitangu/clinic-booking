import type { Metadata } from "next";
import { LegalPage } from "@/components/layout/legal-page";
import { pageMetadata } from "@/lib/metadata";
import { CONTACT_EMAIL } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Data handling",
  description:
    "What this demo collects, why, where it is stored and how long it is kept.",
  path: "/data",
});
export const dynamic = "force-static";

const LINK = "text-primary underline underline-offset-4";

const ROWS = [
  [
    "Name",
    "To identify who the appointment is for",
    "Neon database (aws-us-east-1)",
    "Until you ask for deletion, or the demo data is reset",
  ],
  [
    "Phone number (public API only)",
    "Not collected by this site; the public API accepts one",
    "Neon database (aws-us-east-1)",
    "Same as above",
  ],
  [
    "Email address",
    "Matching your sign-in to your patient record, and appointment emails",
    "Neon database. Appointment emails are sent through Resend",
    "Same as above. Resend keeps sent-mail records for 30 days on the free plan",
  ],
  [
    "Google profile (name, email, picture)",
    "Sign-in only",
    "Neon database; session cookie in your browser",
    "Until you ask for deletion; the cookie ends with your session",
  ],
  [
    "Appointment times and doctor",
    "To show and manage your booking",
    "Neon database (aws-us-east-1)",
    "Same as above",
  ],
  [
    "Cancellation reason",
    "So the clinic knows why a slot opened",
    "Neon database (aws-us-east-1)",
    "Same as above",
  ],
  [
    "Request logs (no patient IDs)",
    "To find and fix faults",
    "Cloud Run in us-east4 and Vercel",
    "Platform defaults, which I do not change",
  ],
] as const;

export default function DataPage() {
  return (
    <LegalPage title="Data handling" updated="17 October 2026">
      <p className="rounded-md border border-border bg-muted px-4 py-3 text-sm">
        Illustrative, written for an assessment. The retention periods are what
        I set for a demonstration, not a promise for a live clinic.
      </p>

      <h2>What is collected</h2>
      <div
        className="overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label="Data items"
      >
        <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
          <caption className="sr-only">
            Every data item, why it is collected, where it is stored and how
            long it is kept
          </caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="py-2 pr-4 font-semibold">
                Data
              </th>
              <th scope="col" className="py-2 pr-4 font-semibold">
                Why
              </th>
              <th scope="col" className="py-2 pr-4 font-semibold">
                Where
              </th>
              <th scope="col" className="py-2 font-semibold">
                Kept for
              </th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r[0]} className="border-b border-border align-top">
                <th scope="row" className="py-2 pr-4 font-medium">
                  {r[0]}
                </th>
                <td className="py-2 pr-4">{r[1]}</td>
                <td className="py-2 pr-4">{r[2]}</td>
                <td className="py-2">{r[3]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Where it is hosted</h2>
      <p>
        The site runs on Vercel, the booking service on Google Cloud Run in
        us-east4, and the database on Neon in aws-us-east-1. Appointment emails
        are sent through Resend. The reasons for the region are in{" "}
        <a
          className={LINK}
          href="https://github.com/ericgitangu/clinic-booking/blob/main/docs/adr/0014-hosting-region-and-cost.md"
          target="_blank"
          rel="noopener noreferrer"
        >
          the hosting decision record
        </a>
        .
      </p>

      <h2>Kenya Data Protection Act, 2019</h2>
      <p>
        This demonstration uses synthetic data only, and you should not enter
        real health information. Hosting in the United States was chosen for
        cost and latency, and it would need a data residency review under the
        Act before any real patient data was stored. I have not done that
        review, and nothing here is legal advice.
      </p>

      <h2>Deletion requests</h2>
      <p>
        To have your data deleted, write to{" "}
        <a
          className={LINK}
          href={`mailto:${CONTACT_EMAIL}?subject=Delete%20my%20data`}
        >
          {CONTACT_EMAIL}
        </a>{" "}
        from the address on the account, or use the contact details on{" "}
        <a
          className={LINK}
          href="https://developer.ericgitangu.com"
          target="_blank"
          rel="noopener noreferrer"
        >
          developer.ericgitangu.com
        </a>
        . The general privacy notice is on the{" "}
        <a className={LINK} href="/privacy">
          privacy page
        </a>
        .
      </p>
    </LegalPage>
  );
}
