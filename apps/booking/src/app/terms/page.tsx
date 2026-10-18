import type { Metadata } from "next";
import { LegalPage } from "@/components/layout/legal-page";
import { pageMetadata } from "@/lib/metadata";
import { CONTACT_EMAIL } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Terms",
  description:
    "The terms for using this demonstration booking system: what it is, and what it is not.",
  path: "/terms",
});
export const dynamic = "force-static";

export default function TermsPage() {
  return (
    <LegalPage title="Terms" updated="17 October 2026">
      <p>
        By using this site you agree to these terms. They are short because this
        is a demonstration system built for an assessment, not a real clinic.
      </p>

      <h2>What this is</h2>
      <p>
        Idyllic Clinic lets you see a doctor&rsquo;s free slots and book,
        reschedule or cancel a visit. The doctors, the clinic and the
        appointments are not real, and no medical service is provided.
      </p>

      <h2>No medical advice</h2>
      <p>
        Nothing here is medical advice. If you need care, contact a real clinic
        or emergency service.
      </p>

      <h2>Your account</h2>
      <p>
        You can sign in with Google. You are responsible for what happens under
        your account, and you can stop using it at any time. We may suspend an
        account that misuses the service. How we handle your data is described
        in the{" "}
        <a
          className="text-primary underline underline-offset-4"
          href="/privacy"
        >
          privacy page
        </a>
        .
      </p>

      <h2>Using it fairly</h2>
      <ul>
        <li>
          Do not enter real health information or other people&rsquo;s personal
          data.
        </li>
        <li>
          Do not try to overload the service or get around its protections.
        </li>
        <li>
          You may try the API and the interactive documentation as they are
          offered.
        </li>
      </ul>

      <h2>No warranty</h2>
      <p>
        The service is provided as it is. It may change, be reset or go away at
        any time, and bookings are not guaranteed to persist.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms. The date at the top shows the latest version,
        and continuing to use the site means you accept it.
      </p>

      <h2>Contact</h2>
      <p>
        <a
          className="text-primary underline underline-offset-4"
          href={`mailto:${CONTACT_EMAIL}`}
        >
          {CONTACT_EMAIL}
        </a>
      </p>
    </LegalPage>
  );
}
