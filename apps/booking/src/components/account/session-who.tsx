"use client";

import { SignOutButton } from "@/components/account/sign-out-button";
import { authClient } from "@/lib/auth-client";

// The live session: Better Auth's own hook, so it follows the session when it changes elsewhere
// (the tab regains focus, another tab signs in or out, the page refreshes after sign-in).
export function SessionWho() {
  const { data } = authClient.useSession();
  const user = data?.user;
  if (!user) return null;
  return (
    <div className="flex items-center">
      <span
        className="hidden max-w-40 truncate text-base text-muted-foreground md:inline"
        title={user.email}
      >
        {user.name}
      </span>
      <SignOutButton />
    </div>
  );
}
