// Better Auth's own OAuth sign-in, run without a browser and without Google.
//
// What is stood in for: Google's token endpoint (oauth2.googleapis.com/token), which is on the public
// network and cannot be part of a repeatable run. Everything else is Better Auth's real OAuth
// callback on an instance built from the very same options and plugins as the app: the sign-in
// starts, the state cookie is kept, the "code" comes back, Better Auth exchanges it (the one stubbed
// call, answering with an id token carrying a Google-style subject, email and name), creates the user
// and account, and sets the cookies a real sign-in sets: the signed session, its encrypted cache and
// the account cookie that carries Google's subject. No user id is chosen here: Better Auth makes it
// up, as it does for a real person.
import { randomBytes, randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { authOptions } from "../../src/lib/auth-options";
import { identityPlugins } from "../../src/lib/auth-plugins";

export const CLIENT_ID = "e2e-google-client-id";

// A new instance with its own memory, built from the app's options. Two of these are two app
// instances (two cold starts, or two servers) that have never seen each other.
export function buildAuth(secret: string, baseURL: string) {
  return betterAuth({
    ...authOptions({
      baseURL,
      secret,
      googleClientId: CLIENT_ID,
      googleClientSecret: "e2e-google-client-secret",
    }),
    plugins: identityPlugins(),
  });
}

export type TestAuth = ReturnType<typeof buildAuth>;

export interface Person {
  email: string;
  name: string;
  /** Google's subject: a long number, the same for a person whichever device or instance. */
  googleSub: string;
  emailVerified: boolean;
}

// A person nobody has used before: a fresh address and a fresh Google subject, so every scenario
// gets its own patient.
export const newPerson = (overrides: Partial<Person> = {}): Person => {
  const id = randomUUID().slice(0, 8);
  return {
    email: `e2e-${id}@clinic.example`,
    name: `Pat ${id}`,
    googleSub: BigInt(`0x${randomBytes(8).toString("hex")}`).toString(),
    emailVerified: true,
    ...overrides,
  };
};

const b64 = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64url");

function idToken(p: Person): string {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: p.googleSub,
    email: p.email,
    email_verified: p.emailVerified,
    name: p.name,
    iat: now,
    exp: now + 3600,
  })}.stubbed-signature`;
}

const cookieHeader = (headers: Headers) =>
  headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

// Runs the callback with only Google's token endpoint answered locally; any other call goes out.
async function withGoogleStub<T>(p: Person, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          access_token: `stub-${randomUUID()}`,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid email profile",
          id_token: idToken(p),
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return real(input, init);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

// Signs the person in on this instance and returns the cookies the sign-in set.
export async function signInAs(
  auth: TestAuth,
  person: Person,
): Promise<string[]> {
  return withGoogleStub(person, async () => {
    const start = await auth.api.signInSocial({
      body: { provider: "google", callbackURL: "/" },
      returnHeaders: true,
    });
    const state = new URL(start.response.url!).searchParams.get("state")!;
    const callback = await auth.api.callbackOAuth({
      params: { id: "google" },
      query: { code: "stubbed-code", state },
      headers: new Headers({ cookie: cookieHeader(start.headers) }),
      asResponse: true,
    });
    return callback.headers.getSetCookie();
  });
}

export const asCookieHeader = (setCookies: string[]) =>
  setCookies.map((c) => c.split(";")[0]).join("; ");
