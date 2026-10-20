// The browser side of "what became of the email to the doctor": reads the notification's state
// from the admin app's own route and hands the words to the toast. Browser code, no framework.
import type { DoctorNoticeView } from "@/lib/detail-read";
import { toastSuffix } from "@/lib/doctor-notice-words";

/** Reads the state at once, then again after RECHECK_MS while it is still pending (the email goes
 *  out a moment after the arrival, off the request). Never throws; says nothing if it cannot read. */
export const RECHECK_MS = 2500;

export async function doctorEmailSuffix(
  appointmentId: string,
  add: (suffix: string) => void,
  read: (id: string) => Promise<DoctorNoticeView | null> = readNotice,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const first = await read(appointmentId);
  if (!first) return;
  add(toastSuffix(first));
  if (first.status !== "pending") return;
  await wait(RECHECK_MS);
  const later = await read(appointmentId);
  if (later && later.status !== "pending") add(toastSuffix(later));
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
