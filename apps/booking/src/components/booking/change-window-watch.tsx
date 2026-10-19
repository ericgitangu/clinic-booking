"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { clockOffset, insideChangeWindow } from "@/lib/change-window";

// A page left open across the boundary: when the visit comes within the hour, ask the server to
// draw the page again (it then shows why the visit can no longer be moved, and this component is
// no longer on the page) instead of leaving times on screen that the API will refuse. It keeps
// asking every 30 seconds until the server agrees, so a render that still saw the visit outside the
// window (a clock difference of a few seconds) is followed by another. The clock is the server's,
// read once at load.
export function ChangeWindowWatch({
  startsAt,
  serverNow,
}: {
  startsAt: string;
  serverNow: string;
}) {
  const router = useRouter();
  const [offset] = useState(() => clockOffset(serverNow, Date.now()));
  useEffect(() => {
    const timer = setInterval(() => {
      if (insideChangeWindow(startsAt, Date.now() + offset)) router.refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [startsAt, offset, router]);
  return null;
}
