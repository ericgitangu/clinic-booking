// The browser side of "what became of the email to the doctor": reads the notification's state
// from the admin app's own route and hands the words to the toast. Browser code, no framework.
import type { DoctorNoticeView } from "@/lib/detail-read";
import { toastSuffix } from "@/lib/doctor-notice-words";

/** Waits between reads while the email is still pending: 2.5 s, 6 s and 15 s after the arrival
 *  (the email goes out after the response and, with the real provider, can take several seconds). */
export const RECHECK_AFTER_MS = [2500, 6000, 15000] as const;

/**
 * Reads the state at once, then again at each of RECHECK_AFTER_MS while it is still pending, and
 * stops at the first final state, when `alive` says whoever wants it is gone, or when the delays
 * run out. Never throws; says nothing if it cannot read.
 */
export async function watchDoctorNotice(
  appointmentId: string,
  onNotice: (notice: DoctorNoticeView) => void,
  alive: () => boolean = () => true,
  read: (id: string) => Promise<DoctorNoticeView | null> = readNotice,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  let waited = 0;
  for (let step = 0; step <= RECHECK_AFTER_MS.length; step++) {
    if (!alive()) return;
    const notice = await read(appointmentId);
    if (notice) {
      onNotice(notice);
      if (notice.status !== "pending") return;
    }
    const next = RECHECK_AFTER_MS[step];
    if (next === undefined) return;
    await wait(next - waited);
    waited = next;
  }
}

/** The same, as the words at the end of a toast. */
export function doctorEmailSuffix(
  appointmentId: string,
  add: (suffix: string) => void,
  alive?: () => boolean,
  read?: (id: string) => Promise<DoctorNoticeView | null>,
  wait?: (ms: number) => Promise<void>,
): Promise<void> {
  return watchDoctorNotice(
    appointmentId,
    (n) => add(toastSuffix(n)),
    alive,
    read,
    wait,
  );
}

async function readNotice(id: string): Promise<DoctorNoticeView | null> {
  try {
    const res = await fetch(`/dashboard/read/doctor-notice/${id}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      ok: boolean;
      notice?: DoctorNoticeView;
    };
    return body.ok && body.notice ? body.notice : null;
  } catch {
    return null;
  }
}
