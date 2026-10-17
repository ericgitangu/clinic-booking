// Sessions for the end-to-end tests: Better Auth's real OAuth sign-in, with only Google's token
// endpoint stood in for (see oauth-flow.ts). The cookies are signed and encrypted with the same
// BETTER_AUTH_SECRET as the running app, so the app reads them through its real path.
import { AUTH_SECRET, BASE_URL } from "./stack";
import { buildAuth, signInAs, type Person } from "./oauth-flow";

export { newPerson, type Person } from "./oauth-flow";

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax";
  expires: number;
}

const auth = buildAuth(AUTH_SECRET, BASE_URL);

const WANTED = [
  "better-auth.session_token",
  "better-auth.session_data",
  "better-auth.account_data",
];

export async function sessionCookies(person: Person): Promise<Cookie[]> {
  const jar = await signInAs(auth, person);
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24;
  const cookies = jar
    .map((c) => c.split(";")[0])
    .map((pair) => ({
      name: pair.slice(0, pair.indexOf("=")),
      value: pair.slice(pair.indexOf("=") + 1),
    }))
    .filter((c) => WANTED.includes(c.name));
  for (const name of WANTED) {
    if (!cookies.some((c) => c.name === name))
      throw new Error(`Better Auth did not set ${name}`);
  }
  return cookies.map((c) => ({
    ...c,
    domain: "localhost",
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "Lax" as const,
    expires,
  }));
}
