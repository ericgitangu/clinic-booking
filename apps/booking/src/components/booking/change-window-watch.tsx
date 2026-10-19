"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { clockOffset, insideChangeWindow } from "@/lib/change-window";

// A page left open across the boundary: when the visit comes within the hour, ask the server to
// draw the page again (it then shows why the visit can no longer be moved) instead of leaving
// times on screen that the API will refuse. The clock is the server's, read once at load.
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
      if (insideChangeWindow(startsAt, Date.now() + offset)) {
        clearInterval(timer);
        router.refresh();
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, [startsAt, offset, router]);
  return null;
}
