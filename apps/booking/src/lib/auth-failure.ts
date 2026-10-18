// The API refusing the caller's signed assertion (401) or the account (403) means the session is no
// longer good: the person is sent to sign in again, never shown "not found" or a generic error.
export const needsSignIn = (f: { status: number }): boolean =>
  f.status === 401 || f.status === 403;
