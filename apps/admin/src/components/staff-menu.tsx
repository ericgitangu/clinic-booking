"use client";

import { AccountMenu } from "@clinic/ui/components/account/account-menu";
import { Badge } from "@clinic/ui/components/ui/badge";
import { notify } from "@clinic/ui/lib/notify";
import { authClient } from "@/lib/auth-client";
import { ROLE_HELP, ROLE_LABEL, type Role } from "@/lib/roles";

// Who is signed in, in the header: their picture opens the menu with name, email, role and Sign
// out. The role also sits beside the picture as a small label so it is never a tap away. Sign-out
// ends only the browser's cookie.
export function StaffMenu({
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
  const label = role ? ROLE_LABEL[role] : "No access";
  return (
    <div className="flex items-center gap-1">
      <Badge
        variant="outline"
        data-testid="staff-role"
        className="hidden min-[400px]:inline-flex"
      >
        {label}
      </Badge>
      <AccountMenu name={name} email={email} image={image} onSignOut={signOut}>
        <span className="mt-1 text-xs text-muted-foreground">
          {role ? `${label}. ${ROLE_HELP[role]}` : "No access yet."}
        </span>
      </AccountMenu>
    </div>
  );
}
