"use client";

import { useEffect } from "react";
import { notify } from "@clinic/ui/lib/notify";
import type { ActionState } from "@/lib/action-state";

// Every outcome of an action buzzes and toasts the same way, so no screen decides that itself.
export function useActionFeedback(state: ActionState, onDone?: () => void) {
  useEffect(() => {
    if (state.status === "done") {
      notify.success(state.message);
      onDone?.();
    } else if (state.status === "error") {
      if (state.severity === "critical") notify.critical(state.message);
      else if (state.severity === "warning") notify.warning(state.message);
      else notify.error(state.message);
    }
    // onDone is a fresh closure each render; the state object identity is what marks a new outcome.
  }, [state]);
}
