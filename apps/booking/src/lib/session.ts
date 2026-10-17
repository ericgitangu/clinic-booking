import "server-only";
import { headers } from "next/headers";
import { cache } from "react";
import type { Caller } from "@clinic/api/call";
import { getAuth } from "@/lib/auth";
import { identityFrom, type Identity } from "@/lib/identity";

export type { Identity } from "@/lib/identity";

// Read on every request from the signed, encrypted session cookie, and only memoised for that one
// request.
export const getIdentity = cache(async (): Promise<Identity | null> => {
  const session = await getAuth().api.getSession({ headers: await headers() });
  return identityFrom(session);
});

// The signed assertion the API wants on /internal/*: who is asking. A patient has no staff role.
export const callerFor = (who: Identity): Caller => ({
  sub: who.sub,
  email: who.email,
  role: "patient",
  emailVerified: true,
});
