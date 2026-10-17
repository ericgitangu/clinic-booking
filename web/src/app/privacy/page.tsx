import type { Metadata } from "next";
import { LegalPage } from "@/components/layout/legal-page";
import { CONTACT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy",
  alternates: { canonical: "/privacy" },
};
export const dynamic = "force-static";

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy" updated="17 October 2026">
      <p>
        This is a demonstration clinic booking system built for an assessment.
        It is not a real clinic, and the data in it is meant to be test data.
        Please do not enter real health information.
      </p>

      <h2>What is stored</h2>
      <ul>
        <li>
          Your name, and optionally your phone number and email address, when
          you register or sign in.
        </li>
        <li>
          Your appointments: the doctor, the time, and whether it was booked,
          rescheduled or cancelled, with the reason you give when you cancel.
        </li>
        <li>
          A record of each booking change (what changed and when), so the
          history of an appointment can be shown.
        </li>
      </ul>

      <h2>Signing in with Google</h2>
      <p>
        You can sign in with your Google account. We receive your name, email
        address and whether Google has verified the address. Your session is
        kept in a cookie on this site only. We never see your Google password.
      </p>

      <h2>Protection against automated abuse</h2>
      <p>
        Forms that change a booking use Google reCAPTCHA. It looks at signals
        from your browser to score whether a request comes from a person, and
        Google handles that data under its own privacy policy.
      </p>

      <h2>Email</h2>
      <p>
        When you book, reschedule or cancel, and the day before an appointment,
        we send an email through Resend to the address on your account. The
        email contains the appointment details.
      </p>

      <h2>Where it lives</h2>
      <p>
        The site runs on Vercel, the booking service on Google Cloud, and the
        database on Neon. Appointment data is not sold or shared for
        advertising.
      </p>

      <h2>Deleting your data</h2>
      <p>
        Because this is a demonstration, test data may be removed at any time.
        To have your data deleted sooner, write to{" "}
        <a
          className="text-primary underline underline-offset-4"
          href={`mailto:${CONTACT_EMAIL}`}
        >
          {CONTACT_EMAIL}
        </a>
        .
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this page or your data:{" "}
        <a
          className="text-primary underline underline-offset-4"
          href={`mailto:${CONTACT_EMAIL}`}
        >
          {CONTACT_EMAIL}
        </a>
        .
      </p>
    </LegalPage>
  );
}
