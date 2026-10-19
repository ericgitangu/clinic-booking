// The API refusing the caller's signed assertion (401) means the session is no longer good: the person
// signs in again. A 403 is different: they are signed in and are not allowed, so signing in again
// would change nothing; they are told so and given a way back.
export const needsSignIn = (f: { status: number }): boolean => f.status === 401;
export const isForbidden = (f: { status: number }): boolean => f.status === 403;

export const FORBIDDEN_MESSAGE = "You don't have access to this.";
