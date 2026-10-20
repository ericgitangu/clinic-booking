import type { ReactNode } from "react";
import { requireStaff } from "@/lib/session";

// The check runs here, above loading.tsx's Suspense boundary. A page inside that boundary starts
// streaming a 200 before its own forbidden() can run; checking in the layout keeps the real 403
// (and the redirect for the signed-out) on the first byte. The pages still check for themselves.
// The arrival email to the doctor is sent after the response from the server action (about 25 s at
// worst, see emails/doctor-arrival.ts); this keeps the function alive for it.
export const maxDuration = 60;

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireStaff("view");
  return children;
}
