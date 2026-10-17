import { toast, type ExternalToast } from "sonner";
import { vibrate } from "@clinic/ui/lib/haptics";

// The one place results become a toast. Each call also buzzes by severity, so no page decides
// that on its own. `critical` is a booking that failed or a server error: it shows as an error
// toast that stays until dismissed.
export const notify = {
  success: (message: string, data?: ExternalToast) => {
    vibrate("success");
    return toast.success(message, data);
  },
  info: (message: string, data?: ExternalToast) => {
    vibrate("info");
    return toast.info(message, data);
  },
  warning: (message: string, data?: ExternalToast) => {
    vibrate("warning");
    return toast.warning(message, data);
  },
  error: (message: string, data?: ExternalToast) => {
    vibrate("error");
    return toast.error(message, data);
  },
  critical: (message: string, data?: ExternalToast) => {
    vibrate("critical");
    return toast.error(message, { duration: Infinity, ...data });
  },
};
