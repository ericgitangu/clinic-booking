import type { ReactNode } from "react";
import { requireStaff } from "@/lib/session";

// The check runs here, above loading.tsx's Suspense boundary. A page inside that boundary starts
// streaming a 200 before its own forbidden() can run; checking in the layout keeps the real 403
// (and the redirect for the signed-out) on the first byte. The pages still check for themselves.
// Marking an arrival answers, re-renders the page, and then sends the email to the doctor in
// after(): all inside one function. The worst case adds up to about 80 s (src/lib/arrival-budget.ts
// lists the steps; tests/arrival-budget.test.ts keeps the sum at least 10 s inside this value).
// Vercel allows a Hobby function up to 300 s with fluid compute, the default
// (https://vercel.com/docs/functions/configuring-functions/duration), so 120 s is within the free plan.
export const maxDuration = 120;

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireStaff("view");
  return children;
}
