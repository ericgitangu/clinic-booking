import "server-only";
import { forbidden, redirect } from "next/navigation";
import { headers } from "next/headers";
import { cache } from "react";
import { getAuth } from "@/lib/auth";
import { sessionInfo, type Caller } from "@/lib/api";
import { can, type Capability, type Role } from "@/lib/roles";

export interface Identity {
  /** Stable id from the sign-in provider. */
  sub: string;
  email: string;
  name: string;
  /** Google profile picture address, when the account has one. */
  image: string | null;
}

export interface Staff extends Identity {
  /** The role held right now; null when the email has no active access. */
  role: Role | null;
}

export function ownerEmails(): ReadonlySet<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function identity(): Promise<Identity | null> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  const user = session?.user;
  // Google's own subject (see auth-plugins.ts), never Better Auth's per-instance user id; and an
  // address Google has not verified is not an identity we act on.
  const sub = session?.googleSub;
  if (!sub || !user?.email || !user.emailVerified) return null;
  return {
    sub,
    email: user.email.toLowerCase(),
    name: user.name || user.email,
    image: user.image ?? null,
  };
}

export function callerFor(who: Identity, role: Role | "none"): Caller {
  return { sub: who.sub, email: who.email, role };
}

async function resolveRole(who: Identity): Promise<Role | null> {
  if (ownerEmails().has(who.email)) return "owner";
  const res = await sessionInfo(callerFor(who, "none"));
  if (!res.ok) {
    // Never fall back to a role: an outage must not turn into access.
    throw new Error(`could not resolve the role (${res.status} ${res.code})`);
  }
  return res.data.role;
}

// Looked up on every request and only memoised for the length of that one request, so a revoke
// takes effect on the person's next click.
export const getStaff = cache(async (): Promise<Staff | null> => {
  const who = await identity();
  if (!who) return null;
  return { ...who, role: await resolveRole(who) };
});

export type Authorised = Staff & { role: Role };

/** For pages: sends the signed-out to sign-in and answers 403 for anyone without the capability. */
export async function requireStaff(
  capability: Capability,
): Promise<Authorised> {
  const staff = await getStaff();
  if (!staff) redirect("/");
  if (!can(staff.role, capability)) forbidden();
  return staff as Authorised;
}

/** For server actions: the same check, answered as a value because an action returns a result. */
export async function authorise(
  capability: Capability,
): Promise<Authorised | null> {
  const staff = await getStaff();
  if (!staff || !can(staff.role, capability)) return null;
  return staff as Authorised;
}
