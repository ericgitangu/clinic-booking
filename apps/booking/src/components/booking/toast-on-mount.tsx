"use client";

import { useEffect } from "react";
import { notify } from "@clinic/ui/lib/notify";

// Shows one toast (with its vibration) when a page arrives after an action, e.g. a confirmation.
export function ToastOnMount({
  message,
  kind = "success",
}: {
  message: string;
  kind?: "success" | "info";
}) {
  useEffect(() => {
    notify[kind](message);
  }, [message, kind]);
  return null;
}
