"use client";

import { AccountMenu } from "@clinic/ui/components/account/account-menu";
import { Badge } from "@clinic/ui/components/ui/badge";
import { notify } from "@clinic/ui/lib/notify";
import { authClient } from "@/lib/auth-client";
import { ROLE_LABEL, type Role } from "@/lib/roles";

// Who is signed in and with what role, and the menu to sign out. Sign-out ends only the browser's
// cookie.
export function StaffBar({
  name,
  email,
  image,
  role,
}: {
  name: string;
  email: string;
  image: string | null;
  role: Role | null;
}) {
  async function signOut() {
    const res = await authClient.signOut();
    if (res.error) {
      notify.error("We could not sign you out. Try again.");
      return;
    }
    notify.success("Signed out.");
    window.location.assign("/");
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2">
      <p className="flex min-w-0 items-center gap-2 text-sm">
        <span className="truncate" data-testid="staff-email">
          {email}
        </span>
        <Badge variant="outline" data-testid="staff-role">
          {role ? ROLE_LABEL[role] : "No access"}
        </Badge>
      </p>
      <AccountMenu
        name={name}
        email={email}
        image={image}
        onSignOut={signOut}
      />
    </div>
  );
}
