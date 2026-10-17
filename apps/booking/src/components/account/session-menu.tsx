"use client";

import { SignOutButton } from "@/components/account/sign-out-button";
import { authClient } from "@/lib/auth-client";

// Who is signed in, shown beside the theme control; signing out is one tap. It reads the session in
// the browser so the pages that do not need an account (the landing page, the legal pages) stay
// static. Signed out shows nothing: the pages that need an account say so themselves.
export function SessionMenu() {
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
