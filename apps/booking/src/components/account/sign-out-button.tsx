"use client";

import { useRouter } from "next/navigation";
import { Button } from "@clinic/ui/components/ui/button";
import { notify } from "@clinic/ui/lib/notify";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      className="h-11 px-3 text-base"
      onClick={async () => {
        try {
          await authClient.signOut();
        } catch {
          notify.error("We could not sign you out. Try again.");
          return;
        }
        router.push("/");
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
