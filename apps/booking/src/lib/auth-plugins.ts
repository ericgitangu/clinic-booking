import { getAccountCookie } from "better-auth/cookies";
import { customSession } from "better-auth/plugins";

// Who the person is, as Google knows them, in the session itself.
//
// Better Auth has no database here, so it makes up a random id for the user every time someone
// signs in on an instance that has not seen them (a cold start, an expired session, a second
// instance). That id cannot name a patient: the same person would get a second patient and their
// appointments would seem to vanish. Google's own subject, which the account cookie keeps as the
// account id, is stable, so the session carries it as `googleSub` and everything keys on that.
export function identityPlugins() {
  return [
    customSession(async ({ user, session }, ctx) => {
      const account = await getAccountCookie(ctx);
      const googleSub =
        account?.providerId === "google" ? account.accountId : null;
      return { user, session, googleSub };
    }),
  ];
}
