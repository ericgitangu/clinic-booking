import { describe, expect, it } from "vitest";
import { identityFrom, patientName } from "@/lib/identity";

const ok = {
  user: { email: "Pat@Example.TEST", emailVerified: true, name: "Pat Person" },
  googleSub: "104857600123456789012",
};

describe("identityFrom", () => {
  it("is Google's subject and the lower-cased verified email", () => {
    expect(identityFrom(ok)).toEqual({
      sub: "104857600123456789012",
      email: "pat@example.test",
      name: "Pat Person",
      image: null,
    });
  });
  it("carries the Google picture URL when there is one, trimmed", () => {
    const withPic = {
      ...ok,
      user: { ...ok.user, image: " https://lh3.googleusercontent.com/a/x " },
    };
    expect(identityFrom(withPic)?.image).toBe(
      "https://lh3.googleusercontent.com/a/x",
    );
  });
  it("is nobody without Google's subject, even with a user id in the session", () => {
    expect(identityFrom({ ...ok, googleSub: null })).toBeNull();
    expect(identityFrom({ ...ok, googleSub: undefined })).toBeNull();
    expect(
      identityFrom({
        user: { ...ok.user, id: "better-auth-made-up-id" },
      } as never),
    ).toBeNull();
  });
  it("is nobody with an email Google has not verified", () => {
    expect(
      identityFrom({ ...ok, user: { ...ok.user, emailVerified: false } }),
    ).toBeNull();
  });
  it("is nobody without a session or an email", () => {
    expect(identityFrom(null)).toBeNull();
    expect(identityFrom({ googleSub: "1" })).toBeNull();
    expect(
      identityFrom({ ...ok, user: { ...ok.user, email: null } }),
    ).toBeNull();
  });
  it("shows the email when there is no display name", () => {
    expect(
      identityFrom({ ...ok, user: { ...ok.user, name: "  " } })?.name,
    ).toBe("pat@example.test");
  });
});

describe("patientName (the API wants 2 to 200 characters)", () => {
  it("keeps a normal name", () => {
    expect(patientName({ name: "Amina Wanjiku", email: "a@x.test" })).toBe(
      "Amina Wanjiku",
    );
  });
  it("falls back to the part of the email before the @ for a one-letter name", () => {
    expect(patientName({ name: "A", email: "amina.w@x.test" })).toBe("amina.w");
  });
  it("pads when the name and the email name are both one character", () => {
    const n = patientName({ name: "A", email: "b@x.test" });
    expect(n.length).toBeGreaterThanOrEqual(2);
    expect(n.startsWith("A")).toBe(true);
  });
  it("copes with an empty name and an odd email", () => {
    expect(patientName({ name: "", email: "" }).length).toBeGreaterThanOrEqual(
      2,
    );
  });
  it("collapses whitespace and cuts a very long name to 200", () => {
    expect(patientName({ name: "  Ann   Lee ", email: "a@x.test" })).toBe(
      "Ann Lee",
    );
    expect(
      patientName({ name: "x".repeat(500), email: "a@x.test" }),
    ).toHaveLength(200);
  });
});
