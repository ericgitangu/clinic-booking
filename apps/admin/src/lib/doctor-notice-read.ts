// The browser side of "what became of the email to the doctor": reads the notification's state
// from the admin app's own route and hands it to whoever is watching (a toast, the sheet). Browser
// code, no framework.
import type { DoctorNoticeView } from "@/lib/detail-read";
import { toastSuffix } from "@/lib/doctor-notice-words";

/** Gaps before each look for a toast, as times since the arrival: 2.5 s, 6 s and 15 s. The email
 *  goes out after the response and, with the real provider, can take several seconds. */
export const RECHECK_AFTER_MS = [2500, 6000, 15000] as const;

/** For the sheet, which stays open longer: it keeps looking until the row is final or can be
 *  resent. That is 2 minutes after an arrival nobody claimed (UNCLAIMED_GRACE in the API), which
 *  these looks reach (the last is at 140 s). A row that WAS claimed and whose sender died is held
 *  for the 15 minute claim before it can be resent, and these looks stop long before: that case
 *  needs the sheet reopened. */
export const SHEET_RECHECK_AFTER_MS = [
  2500, 6000, 15000, 30000, 60000, 120000, 140000,
] as const;

export interface WatchOptions {
  /** False once whoever wants the answer is gone. Checked after every wait and every read. */
  alive?: () => boolean;
  read?: (id: string) => Promise<DoctorNoticeView | null>;
  wait?: (ms: number) => Promise<void>;
  /** Times since the start of each look after the first. */
  delays?: readonly number[];
  /** Stop looking once this is true; by default, when the row is no longer pending. */
  done?: (notice: DoctorNoticeView) => boolean;
  /** Resolves when the tab is in front. A hidden tab does not look; it waits. */
  untilVisible?: () => Promise<void>;
}

/** A hidden tab pauses its looks and picks them up when it is shown again. */
export function untilVisible(): Promise<void> {
  if (typeof document === "undefined" || !document.hidden)
    return Promise.resolve();
  return new Promise((resolve) => {
    const on = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", on);
      resolve();
    };
    document.addEventListener("visibilitychange", on);
  });
}

/**
 * Reads the state at once, then again after each of `delays` while it is still pending, and stops
 * at the first final state (or `done`), when `alive` says whoever wants it is gone, or when the
 * delays run out. Never throws; says nothing if it cannot read.
 */
export async function watchDoctorNotice(
  appointmentId: string,
  onNotice: (notice: DoctorNoticeView) => void,
  {
    alive = () => true,
    read = readNotice,
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
    delays = RECHECK_AFTER_MS,
    done = (n) => n.status !== "pending",
    untilVisible: visible = untilVisible,
  }: WatchOptions = {},
): Promise<void> {
  let waited = 0;
  for (let step = 0; step <= delays.length; step++) {
    if (!alive()) return;
    await visible();
    if (!alive()) return;
    const notice = await read(appointmentId);
    // Whoever asked may have gone while the read was out: say nothing to them then.
    if (!alive()) return;
    if (notice) {
      onNotice(notice);
      if (done(notice)) return;
    }
    const next = delays[step];
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
  return watchDoctorNotice(appointmentId, (n) => add(toastSuffix(n)), {
    alive,
    read,
    wait,
  });
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
