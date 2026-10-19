import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";

// One template for the four emails (booked, rescheduled, cancelled, reminder), in the Idyllic
// colours: ink navy for text, lotus blue for the button, mist behind a white card. Written for
// mail clients, so it uses inline styles and a PNG mark rather than the web app's CSS.
export type EmailKind = "booked" | "rescheduled" | "cancelled" | "reminder";

export interface EmailData {
  kind: EmailKind;
  /** First name or full name of the person. */
  name: string;
  doctor: string;
  specialty: string;
  /** The appointment time, already formatted in the clinic's own zone, e.g. "Tuesday 20 October, 09:00". */
  when: string;
  /** The clinic's zone, named for the reader, e.g. "East Africa Time (GMT+03:00)". */
  zone: string;
  /** For a moved appointment, the time it was moved from. */
  previousWhen?: string;
  /** For a cancelled appointment, the reason the person gave. */
  reason?: string;
  /** The site's address, for the links and the logo. */
  siteUrl: string;
}

const INK = "#14204f";
const LOTUS = "#243a8c";
const MIST = "#f4f8fc";
const AQUA = "#e3eef9";
const MUTED = "#4a5878";

interface Copy {
  subject: (d: EmailData) => string;
  preview: (d: EmailData) => string;
  heading: string;
  lead: (d: EmailData) => string;
  button: { label: string; path: string };
}

const COPY: Record<EmailKind, Copy> = {
  booked: {
    subject: (d) => `Your appointment is booked: ${d.when}`,
    preview: (d) => `${d.when} with ${d.doctor}`,
    heading: "You are booked",
    lead: (d) => `Hello ${d.name}, your visit is confirmed.`,
    button: { label: "See my appointments", path: "/appointments" },
  },
  rescheduled: {
    subject: (d) => `Your appointment was moved to ${d.when}`,
    preview: (d) => `Now ${d.when} with ${d.doctor}`,
    heading: "Your appointment was moved",
    lead: (d) => `Hello ${d.name}, your visit has a new time.`,
    button: { label: "See my appointments", path: "/appointments" },
  },
  cancelled: {
    subject: (d) => `Your appointment on ${d.when} was cancelled`,
    preview: (d) => `Cancelled: ${d.when} with ${d.doctor}`,
    heading: "Your appointment was cancelled",
    lead: (d) =>
      `Hello ${d.name}, this visit is cancelled and the time is free for someone else.`,
    button: { label: "Book another visit", path: "/book" },
  },
  reminder: {
    subject: (d) => `Reminder: your appointment tomorrow, ${d.when}`,
    preview: (d) => `Tomorrow: ${d.when} with ${d.doctor}`,
    heading: "Your appointment is tomorrow",
    lead: (d) => `Hello ${d.name}, a reminder of your visit.`,
    button: { label: "Move or cancel it", path: "/appointments" },
  },
};

export const emailSubject = (d: EmailData) => COPY[d.kind].subject(d);

export function IdyllicEmail(d: EmailData) {
  const copy = COPY[d.kind];
  return (
    <Html lang="en">
      <Head />
      <Preview>{copy.preview(d)}</Preview>
      <Body
        style={{
          backgroundColor: MIST,
          margin: 0,
          padding: "24px 12px",
          fontFamily: "Helvetica, Arial, sans-serif",
          color: INK,
        }}
      >
        <Container style={{ maxWidth: 520, margin: "0 auto" }}>
          <Section style={{ padding: "0 0 16px" }}>
            <Img
              src={`${d.siteUrl}/brand/idyllic-mark.png`}
              width="44"
              height="44"
              alt="Idyllic"
            />
            <Text style={{ margin: "8px 0 0", fontSize: 14, color: MUTED }}>
              Idyllic Clinic
            </Text>
          </Section>
          <Section
            style={{
              backgroundColor: "#ffffff",
              borderRadius: 12,
              padding: "28px 24px",
              border: `1px solid ${AQUA}`,
            }}
          >
            <Heading
              as="h1"
              style={{
                margin: "0 0 12px",
                fontSize: 24,
                lineHeight: "30px",
                color: INK,
              }}
            >
              {copy.heading}
            </Heading>
            <Text
              style={{ margin: "0 0 20px", fontSize: 16, lineHeight: "24px" }}
            >
              {copy.lead(d)}
            </Text>
            <Section
              style={{
                backgroundColor: AQUA,
                borderRadius: 8,
                padding: "14px 16px",
              }}
            >
              {d.previousWhen ? (
                <Text
                  style={{
                    margin: "0 0 6px",
                    fontSize: 14,
                    color: MUTED,
                    textDecoration: "line-through",
                  }}
                >
                  Was: {d.previousWhen}
                </Text>
              ) : null}
              <Text style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
                {d.when}
              </Text>
              <Text style={{ margin: "4px 0 0", fontSize: 15 }}>
                {d.doctor}, {d.specialty}
              </Text>
              <Text style={{ margin: "4px 0 0", fontSize: 13, color: MUTED }}>
                {d.zone}, 30 minutes.
              </Text>
            </Section>
            {d.reason ? (
              <Text style={{ margin: "16px 0 0", fontSize: 14, color: MUTED }}>
                The reason you gave: {d.reason}
              </Text>
            ) : null}
            <Section style={{ padding: "24px 0 4px" }}>
              <Button
                href={`${d.siteUrl}${copy.button.path}`}
                style={{
                  backgroundColor: LOTUS,
                  color: "#ffffff",
                  borderRadius: 8,
                  padding: "12px 20px",
                  fontSize: 16,
                  fontWeight: 700,
                  textDecoration: "none",
                }}
              >
                {copy.button.label}
              </Button>
            </Section>
          </Section>
          <Hr style={{ borderColor: AQUA, margin: "24px 0 12px" }} />
          <Text
            style={{
              margin: 0,
              fontSize: 12,
              lineHeight: "18px",
              color: MUTED,
            }}
          >
            You are getting this because you booked on Idyllic Clinic, a
            demonstration made for an assessment, not a real clinic. Replies go
            to the engineer who built it. See{" "}
            <Link href={`${d.siteUrl}/privacy`} style={{ color: LOTUS }}>
              how your data is handled
            </Link>
            .
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
