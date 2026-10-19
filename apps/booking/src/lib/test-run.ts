// One definition of "this server was started for automated tests", shared by everything that is
// relaxed for tests (the human check, the sign-in rate limit). A person who sets E2E=1 on a real
// deployment gets nothing: all three must hold.
//   1. not Vercel production;
//   2. NODE_ENV=test or E2E=1;
//   3. the base URL is this machine (localhost, 127.0.0.1, [::1] or *.localhost).
type Env = Record<string, string | undefined>;

export function isLocalUrl(url: string | undefined): boolean {
  try {
    const host = new URL(url ?? "").hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

export function isTestRun(env: Env): boolean {
  return (
    env.VERCEL_ENV !== "production" &&
    (env.NODE_ENV === "test" || env.E2E === "1") &&
    isLocalUrl(env.BETTER_AUTH_URL)
  );
}
