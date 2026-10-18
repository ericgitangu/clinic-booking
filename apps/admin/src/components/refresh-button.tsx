"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@clinic/ui/components/ui/button";
import { notify } from "@clinic/ui/lib/notify";
import { refreshMetrics } from "@/lib/actions";

// The metrics are cached for a minute; this asks for fresh ones now.
export function RefreshButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      className="min-h-11"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await refreshMetrics();
          if (!res.ok) {
            notify.error(res.message);
            return;
          }
          router.refresh();
        })
      }
    >
      <RefreshCwIcon aria-hidden className={pending ? "animate-spin" : ""} />
      Refresh
    </Button>
  );
}
