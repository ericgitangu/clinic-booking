import "server-only";
import { headers } from "next/headers";
import { cache } from "react";
import type { Caller } from "@clinic/api/call";
import { getAuth } from "@/lib/auth";

export interface Identity {
  /** Stable id from the sign-in provider. */
  sub: string;
  email: string;
  name: string;
}

// Read on every request from the signed, encrypted session cookie, and only memoised for that one
// request. An address Google has not verified is not an identity we act on.
export const getIdentity = cache(async (): Promise<Identity | null> => {
  const session = await getAuth().api.getSession({ headers: await headers() });
  const user = session?.user;
  if (!user?.email || !user.emailVerified) return null;
  return {
    sub: user.id,
    email: user.email.toLowerCase(),
    name: user.name || user.email,
  };
});

// The signed assertion the API wants on /internal/*: who is asking. A patient has no staff role.
export const callerFor = (who: Identity): Caller => ({
  sub: who.sub,
  email: who.email,
  role: "patient",
});
