import type { Metadata } from "next";
import { LegalPage } from "@/components/layout/legal-page";
import { CONTACT_EMAIL, SITE } from "@/lib/site";

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
          Your name and email address, taken from your Google account the first
          time you book. The booking service can also hold a phone number, but
          this site does not ask for one.
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

      <h2>Google user data</h2>
      <p>
        You can sign in with your Google account. We ask Google only for the
        OpenID Connect scopes <code>openid</code>, <code>email</code> and{" "}
        <code>profile</code>, and from them we receive your name, email address,
        whether Google has verified that address, and your profile picture. We
        never see your Google password, and we do not ask for access to Gmail,
        Drive, Calendar, contacts or any other Google service.
      </p>
      <h3>How we use it</h3>
      <p>
        Only to sign you in, to show you your own appointments, and to send
        appointment emails to your address. We do not use it for advertising,
        profiling or analytics, and no person reads it except to support you.
      </p>
      <h3>How it is stored and shared</h3>
      <p>
        Your name, email address and picture are stored in our database on Neon,
        and your sign-in session lives in a cookie on this site only. We never
        sell Google user data or share it with anyone for their own purposes.
        The only service that receives your email address is Resend, which
        delivers the appointment emails for us.
      </p>
      <h3>Retention and deletion</h3>
      <p>
        We keep your account data until you ask us to delete it, or until the
        demonstration data is reset. To delete your account and everything tied
        to it, write to{" "}
        <a
          className="text-primary underline underline-offset-4"
          href={`mailto:${CONTACT_EMAIL}?subject=Delete%20my%20data`}
        >
          {CONTACT_EMAIL}
        </a>{" "}
        from the address on the account, and we will remove it within 30 days.
        You can also revoke access at any time in your{" "}
        <a
          className="text-primary underline underline-offset-4"
          href="https://myaccount.google.com/permissions"
        >
          Google account permissions
        </a>
        .
      </p>
      <h3>Google API Services User Data Policy</h3>
      <p>
        {SITE.name}&rsquo;s use and transfer to any other app of information
        received from Google APIs will adhere to the{" "}
        <a
          className="text-primary underline underline-offset-4"
          href="https://developers.google.com/terms/api-services-user-data-policy"
        >
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>

      <h2>Protection against automated abuse</h2>
      <p>
        Forms that change a booking use Google reCAPTCHA. It looks at signals
        from your browser to score whether a request comes from a person, and
        Google handles that data under its own privacy policy. This site is
        protected by reCAPTCHA and the Google Privacy Policy and Terms of
        Service apply.
      </p>

      <h2>Email</h2>
      <p>
        When you book, reschedule or cancel, and the evening before an
        appointment, we send an email through Resend to the address on your
        account. The email contains the appointment details.
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
