import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { callApi } from "@clinic/api/call";
import { linkAccountInternalAccountsLinkPost } from "@clinic/api/generated";
import { identityFrom, patientName } from "@/lib/identity";
import {
  asCookieHeader,
  buildAuth,
  newPerson,
  signInAs,
} from "../e2e/support/oauth-flow";

// The same Google person signs in on two app instances that have never seen each other (two cold
// starts, a session that expired, a second server). Better Auth keeps no database here, so each
// instance makes up its own user id: that id must never be what names the person's patient.
// What is stood in for: only Google's token endpoint (see e2e/support/oauth-flow.ts). The rest is
// Better Auth's real OAuth callback, and, when REAL_API_URL is set, the real API.
const SECRET = randomBytes(24).toString("hex");
const BASE = "http://localhost:3100";

async function sessionOn(
  auth: ReturnType<typeof buildAuth>,
  person: ReturnType<typeof newPerson>,
) {
  const cookies = await signInAs(auth, person);
  const session = await auth.api.getSession({
    headers: new Headers({ cookie: asCookieHeader(cookies) }),
  });
  return { session, identity: identityFrom(session) };
}

describe("the same Google person on two separate app instances", () => {
  const person = newPerson();

  it("gets the same identity, even though each instance made up a different user id", async () => {
    const a = await sessionOn(buildAuth(SECRET, BASE), person);
    const b = await sessionOn(buildAuth(SECRET, BASE), person);
    expect(a.session?.user.id).toBeTruthy();
    expect(a.session?.user.id).not.toBe(b.session?.user.id); // what used to be (wrongly) the key
    expect(a.identity?.sub).toBe(person.googleSub);
    expect(b.identity?.sub).toBe(person.googleSub);
    expect(a.identity).toEqual(b.identity);
  });

  it("is a different identity for a different Google person", async () => {
    const auth = buildAuth(SECRET, BASE);
    const other = newPerson();
    const a = await sessionOn(auth, person);
    const b = await sessionOn(auth, other);
    expect(a.identity?.sub).not.toBe(b.identity?.sub);
  });

  it("is nobody when Google has not verified the email", async () => {
    const unverified = newPerson({ emailVerified: false });
    const s = await sessionOn(buildAuth(SECRET, BASE), unverified);
    expect(s.identity).toBeNull();
  });
});

// Against the real API (the e2e-real job and `make e2e` set REAL_API_URL and INTERNAL_SIGNING_KEY).
describe.skipIf(!process.env.REAL_API_URL)("and the real API", () => {
  it("links both to the same patient, and a one-letter Google name does not stop the link", async () => {
    process.env.API_URL = process.env.REAL_API_URL;
    expect(
      process.env.INTERNAL_SIGNING_KEY,
      "INTERNAL_SIGNING_KEY",
    ).toBeTruthy();
    const person = newPerson({ name: "Z" });
    const link = async (auth: ReturnType<typeof buildAuth>) => {
      const { identity } = await sessionOn(auth, person);
      expect(identity).not.toBeNull();
      const who = identity!;
      return callApi(
        "linkAccount",
        (client) =>
          linkAccountInternalAccountsLinkPost({
            client,
            body: { full_name: patientName(who) },
          }),
        {
          caller: {
            sub: who.sub,
            email: who.email,
            role: "patient",
            emailVerified: true,
          },
        },
      );
    };
    const first = await link(buildAuth(SECRET, BASE));
    expect(first).toMatchObject({ ok: true, status: 201 });
    const second = await link(buildAuth(SECRET, BASE));
    expect(second).toMatchObject({ ok: true, status: 200 });
    if (first.ok && second.ok) {
      expect(second.data.patient_id).toBe(first.data.patient_id);
      expect(second.data.created).toBe(false);
    }
  });
});
