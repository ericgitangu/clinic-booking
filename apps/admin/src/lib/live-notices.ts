// What a live event does besides appear in the feed panel: a toast, an unread count, and a short
// highlight on the doctor's card. Pure code, no framework and no browser, so the timing is tested
// with fake timers. The components that use it are live-notifications.tsx, live-feed.tsx and
// today-card.tsx.
import {
  describe,
  isAboutAppointment,
  type LiveEvent,
} from "@/lib/live-events";
import type { Role } from "@/lib/roles";

/** More than BURST_MAX events inside BURST_WINDOW_MS become one "N updates" toast. */
export const BURST_MAX = 3;
export const BURST_WINDOW_MS = 2000;
/** How long a doctor's card stays marked after a change to one of its visits. */
export const HIGHLIGHT_MS = 2000;

/** The words of a toast. Shaped for the role: a viewer's text has no patient and no staff name. */
export function toastText(
  ev: LiveEvent,
  doctorName: string | undefined,
  role: Role,
): string {
  return describe(ev, doctorName, role);
}

export function updatesText(n: number): string {
  return `${n} updates`;
}

type Handle = ReturnType<typeof setTimeout>;

export interface ToastSink {
  /** Shows a toast and returns the id to dismiss or update it by. */
  show(text: string): string;
  dismiss(id: string): void;
  /** Shows, or replaces the text of, the one summary toast. */
  summary(id: string, text: string): void;
}

/**
 * Up to BURST_MAX toasts, each as the event arrives. The next event inside the same two seconds
 * takes them away and puts one "N updates" toast in their place, which then counts up while events
 * keep arriving less than two seconds apart. A quiet two seconds starts over. Nothing is delayed:
 * every event is visible the moment it arrives, so a burst never makes a lone event late.
 */
export class ToastBatcher {
  private recent: number[] = [];
  private shown: string[] = [];
  private summaryId: string | null = null;
  private count = 0;
  private serial = 0;

  constructor(
    private readonly sink: ToastSink,
    private readonly now: () => number = Date.now,
  ) {}

  push(text: string) {
    const at = this.now();
    this.recent = this.recent.filter((t) => at - t <= BURST_WINDOW_MS);
    if (this.recent.length === 0) {
      // A quiet two seconds: this starts over, and an earlier summary is left to expire.
      this.shown = [];
      this.summaryId = null;
      this.count = 0;
    }
    this.recent.push(at);

    if (this.summaryId !== null) {
      this.count += 1;
      this.sink.summary(this.summaryId, updatesText(this.count));
      return;
    }
    if (this.recent.length > BURST_MAX) {
      for (const id of this.shown) this.sink.dismiss(id);
      this.shown = [];
      this.summaryId = `live-updates-${(this.serial += 1)}`;
      this.count = this.recent.length;
      this.sink.summary(this.summaryId, updatesText(this.count));
      return;
    }
    this.shown.push(this.sink.show(text));
  }
}

/** Appointment events change a visit; the staff actions (a reminder, an invitation) do not. */
export function changesAVisit(ev: LiveEvent): boolean {
  return (
    isAboutAppointment(ev) &&
    ev.kind !== "reminder_now" &&
    ev.kind !== "running_late"
  );
}

/** The key a doctor's card for a given day is known by. */
export function cardKey(doctorId: string, date: string): string {
  return `${doctorId}|${date}`;
}

/** The cards an event touches: the doctor on the day of the visit, and on the day it moved from. */
export function cardsTouched(ev: LiveEvent): string[] {
  if (!ev.doctorId || !changesAVisit(ev)) return [];
  const dates = [ev.localDate, ev.fromLocalDate].filter(
    (d): d is string => d !== null,
  );
  return [...new Set(dates)].map((d) => cardKey(ev.doctorId as string, d));
}

type Timers = {
  setTimeout: (f: () => void, ms: number) => Handle;
  clearTimeout: (h: Handle) => void;
};

/**
 * Which doctor cards are marked right now. A mark lasts HIGHLIGHT_MS from the latest change and is
 * renewed by another. Subscribers are told when the set changes.
 */
export class Highlights {
  private readonly marked = new Map<string, Handle>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly timers: Timers = {
      setTimeout: (f, ms) => setTimeout(f, ms),
      clearTimeout: (h) => clearTimeout(h),
    },
  ) {}

  mark(key: string) {
    const old = this.marked.get(key);
    if (old !== undefined) this.timers.clearTimeout(old);
    this.marked.set(
      key,
      this.timers.setTimeout(() => {
        this.marked.delete(key);
        this.emit();
      }, HIGHLIGHT_MS),
    );
    this.emit();
  }

  has(key: string): boolean {
    return this.marked.has(key);
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}

/** The browser's one set of marks, shared by the stream listener and the cards. */
export const highlights = new Highlights();

/** What the unread count becomes after an event: replays and events seen as they arrived add none. */
export function nextUnread(
  count: number,
  event: { replay: boolean },
  panelSeen: boolean,
): number {
  return event.replay || panelSeen ? count : count + 1;
}

/** "3 new", "99+ new", or nothing at zero. */
export function unreadText(count: number): string {
  if (count <= 0) return "";
  return `${count > 99 ? "99+" : count} new`;
}
