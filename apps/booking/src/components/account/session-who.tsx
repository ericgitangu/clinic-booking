"use client";

import { useRouter } from "next/navigation";
import { AccountMenu } from "@clinic/ui/components/account/account-menu";
import { notify } from "@clinic/ui/lib/notify";
import { authClient } from "@/lib/auth-client";

const LINKS = [{ href: "/appointments", label: "My appointments" }] as const;

// The live session: Better Auth's own hook, so it follows the session when it changes elsewhere
// (the tab regains focus, another tab signs in or out, the page refreshes after sign-in).
export function SessionWho() {
  const router = useRouter();
  const { data } = authClient.useSession();
  const user = data?.user;
  if (!user) return null;
  return (
    <AccountMenu
      name={user.name}
      email={user.email}
      image={user.image}
      links={LINKS}
      onSignOut={async () => {
        try {
          await authClient.signOut();
        } catch {
          notify.error("We could not sign you out. Try again.");
          return;
        }
        router.push("/");
        router.refresh();
      }}
    />
  );
}
