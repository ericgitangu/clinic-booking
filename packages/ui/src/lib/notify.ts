import type { ExternalToast } from "sonner";
import { haptic } from "@clinic/ui/lib/haptics";
import {
  requestToaster,
  whenToasterMounted,
} from "@clinic/ui/lib/toaster-gate";

type Toast = typeof import("sonner").toast;

// The toast code is loaded when the first toast is raised (or when the page is idle), not with the
// page. The buzz is immediate, since it belongs to the tap that caused it.
function show(run: (toast: Toast) => unknown) {
  requestToaster();
  whenToasterMounted(() => {
    void import("sonner").then((m) => run(m.toast));
  });
}

// The one place results become a toast. Each call also buzzes by severity, so no page decides
// that on its own. `critical` is a booking that failed or a server error: it shows as an error
// toast that stays until dismissed.
export const notify = {
  success: (message: string, data?: ExternalToast) => {
    haptic("success");
    show((t) => t.success(message, data));
  },
  info: (message: string, data?: ExternalToast) => {
    haptic("info");
    show((t) => t.info(message, data));
  },
  warning: (message: string, data?: ExternalToast) => {
    haptic("warning");
    show((t) => t.warning(message, data));
  },
  error: (message: string, data?: ExternalToast) => {
    haptic("error");
    show((t) => t.error(message, data));
  },
  // A toast the person did not cause (something that happened elsewhere): no buzz, no sound. Give
  // it an `id` to replace it later or take it away with `dismiss`.
  quiet: (message: string, data?: ExternalToast) => {
    show((t) => t(message, data));
  },
  dismiss: (id: string) => {
    show((t) => t.dismiss(id));
  },
  critical: (message: string, data?: ExternalToast) => {
    haptic("critical");
    show((t) => t.error(message, { duration: Infinity, ...data }));
  },
};
