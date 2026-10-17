"use client";

import { LogOutIcon } from "lucide-react";
import { Badge } from "@clinic/ui/components/ui/badge";
import { Button } from "@clinic/ui/components/ui/button";
import { notify } from "@clinic/ui/lib/notify";
import { authClient } from "@/lib/auth-client";
import { ROLE_LABEL, type Role } from "@/lib/roles";

// Who is signed in and with what role, plus sign-out. Sign-out ends only the browser's cookie.
export function StaffBar({
  email,
  role,
}: {
  email: string;
  role: Role | null;
}) {
  async function signOut() {
    const res = await authClient.signOut();
    if (res.error) {
      notify.error("Could not sign out. Try again.");
      return;
    }
    notify.success("Signed out.");
    window.location.assign("/");
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-3">
      <p className="flex min-w-0 items-center gap-2 text-sm">
        <span className="truncate" data-testid="staff-email">
          {email}
        </span>
        <Badge variant="outline" data-testid="staff-role">
          {role ? ROLE_LABEL[role] : "No access"}
        </Badge>
      </p>
      <Button variant="ghost" className="min-h-11" onClick={signOut}>
        <LogOutIcon aria-hidden /> Sign out
      </Button>
    </div>
  );
}
