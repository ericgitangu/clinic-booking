import type { ReactNode } from "react";
import { requireStaff } from "@/lib/session";

// The check runs here, above loading.tsx's Suspense boundary. A page inside that boundary starts
// streaming a 200 before its own forbidden() can run; checking in the layout keeps the real 403
// (and the redirect for the signed-out) on the first byte. The pages still check for themselves.
export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireStaff("view");
  return children;
}
