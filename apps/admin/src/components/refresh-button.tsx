"use client";

import { useState, useTransition } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@clinic/ui/components/ui/button";
import { notify } from "@clinic/ui/lib/notify";
import { refreshMetrics } from "@/lib/actions";

// The metrics are cached for a minute; this asks for fresh ones now.
//
// The server action both expires the tag and revalidates the page, and Next sends the re-rendered
// page back in the action's own response. There is deliberately no router.refresh() on top: that
// would start a second render that the action's promise does not wait for, which can fill the cache
// after the caller believes the refresh is over.
export function RefreshButton() {
  const [pending, start] = useTransition();
  // Counts finished refreshes. It changes only after the action has returned and the new page is
  // in place, so a test (or anything else) can wait on it instead of guessing.
  const [done, setDone] = useState(0);
  return (
    <Button
      variant="outline"
      className="min-h-11"
      disabled={pending}
      aria-busy={pending}
      data-testid="refresh-metrics"
      data-refreshes={done}
      onClick={() =>
        start(async () => {
          const res = await refreshMetrics();
          if (!res.ok) {
            notify.error(res.message);
            return;
          }
          setDone((n) => n + 1);
        })
      }
    >
      <RefreshCwIcon aria-hidden className={pending ? "animate-spin" : ""} />
      Refresh
    </Button>
  );
}
