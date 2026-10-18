"use client";

import Link from "next/link";
import {
  startTransition,
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Availability } from "@clinic/api/generated";
import { Button } from "@clinic/ui/components/ui/button";
import { rescheduleAppointment } from "@/app/actions";
import { initialState } from "@/lib/action-state";
import { clinicDay, formatTime } from "@/lib/clinic-time";
import { NextSlots } from "@/components/booking/next-slots";
import { SlotRadios } from "@/components/booking/slot-radios";
import { StickyCta } from "@/components/booking/sticky-cta";
import { useActionFeedback } from "@/components/booking/use-action-feedback";
import { useLiveSlots } from "@/components/booking/use-live-slots";
import { useRecaptcha } from "@/components/booking/use-recaptcha";
import { useOwnBooked } from "@/lib/own-bookings";
import { buildChips, type Chip, type OwnBooking } from "@/lib/slot-chips";

// `availability` is the server-rendered answer for one doctor and day; the chooser keeps it
// current. `own` is what the signed-in patient already holds (empty when signed out).
type Props = { own: OwnBooking[]; availability: Availability } & (
  | { mode: "details"; doctorId: string }
  | { mode: "reschedule"; appointmentId: string }
);

// What to tell someone whose pick stopped being a free time.
function lostPickText(chips: readonly Chip[], pick: string): string {
  if (!pick) return "";
  const t = formatTime(pick);
  const now = chips.find((c) => c.starts_at === pick)?.state;
  if (now === "yours" || now === "yours-elsewhere")
    return `${t} is already your visit. Pick another time.`;
  // "Just taken" is only said when the API has confirmed it; a time that merely left the list is
  // "no longer available" (it could be a booking, a cancelled day, a doctor's change).
  return now === "just-taken" || now === "booked"
    ? `${t} was just taken. Pick another time.`
    : `${t} is no longer available. Pick another time.`;
}

// The two status lines are always on the page, and only their text changes, so a screen reader
// announces a change instead of missing a node that appeared together with its words.
function LiveNotice({
  lost,
  idle,
  armed,
  failing,
  onResume,
}: {
  lost: string;
  idle: boolean;
  armed: boolean;
  failing: boolean;
  onResume: () => void;
}) {
  return (
    <>
      <span hidden data-polling={armed ? "armed" : "pending"} />
      <p
        role="status"
        aria-live="polite"
        data-testid="refresh-hint"
        className="mb-2 min-h-5 text-sm text-muted-foreground"
      >
        {!idle && failing
          ? "Couldn't refresh. We'll try again automatically."
          : ""}
      </p>
      <p
        role="status"
        aria-live="polite"
        data-testid="lost-pick"
        className={
          lost
            ? "mb-4 rounded-lg border border-border bg-muted p-4 text-base font-semibold"
            : "sr-only"
        }
      >
        {lost}
      </p>
      {idle ? (
        <button
          type="button"
          onClick={onResume}
          className="mb-4 min-h-11 rounded-full border border-border bg-muted px-4 py-2 text-base underline underline-offset-4"
        >
          Paused. Click to refresh.
        </button>
      ) : null}
    </>
  );
}

export function SlotChooser(props: Props) {
  const { availability } = props;
  const day = availability.date;
  const doctorId = availability.doctor_id;
  const live = useLiveSlots(availability);
  const own = useOwnBooked(props.own);

  // Every free time this grid has shown, so one that disappears stays in its place as "Just taken"
  // instead of vanishing and moving the others. Updated while rendering, only when there is
  // something new to add (the documented pattern for state derived from props).
  const [seen, setSeen] = useState<string[]>(() =>
    availability.slots.map((s) => s.starts_at),
  );
  const unseen = live.slots.filter((s) => !seen.includes(s.starts_at));
  if (unseen.length > 0) setSeen([...seen, ...unseen.map((s) => s.starts_at)]);

  // Times the API has said, with a 409, someone else holds. Only these are called "Just taken".
  const [confirmedTaken, setConfirmedTaken] = useState<string[]>([]);
  const attempted = useRef("");

  const chips = useMemo(
    () =>
      buildChips({
        doctorId,
        day,
        slots: live.slots,
        taken: live.taken,
        own,
        seen,
        confirmedTaken,
      }),
    [doctorId, day, live.slots, live.taken, own, seen, confirmedTaken],
  );

  const [selected, setSelected] = useState("");
  const [lost, setLost] = useState("");
  const selectedIsFree = chips.some(
    (c) => c.starts_at === selected && c.state === "free",
  );
  if (selected && !selectedIsFree) {
    setLost(lostPickText(chips, selected));
    setSelected("");
  }
  const choose = (v: string) => {
    setLost("");
    setSelected(v);
  };

  const [state, formAction, pending] = useActionState(
    rescheduleAppointment,
    initialState,
  );
  const getToken = useRecaptcha("reschedule");
  useActionFeedback(state);
  // Losing the race on submit means the list is stale: refetch it now rather than wait for the poll.
  const lostRace = state.status === "error" && state.code === "SLOT_TAKEN";
  const { refresh } = live;
  useEffect(() => {
    if (!lostRace) return;
    const t = attempted.current;
    if (t) setConfirmedTaken((c) => (c.includes(t) ? c : [...c, t]));
    void refresh();
  }, [lostRace, refresh]);

  const notice = (
    <LiveNotice
      lost={lost}
      idle={live.idle}
      armed={live.armed}
      failing={live.failing}
      onResume={live.resume}
    />
  );
  const anyFree = chips.some((c) => c.state === "free");
  const none = (
    <p className="mb-4 rounded-lg border border-dashed border-border p-6 text-base text-muted-foreground">
      No free times {chips.length > 0 ? "left " : ""}on this day. Pick another
      date above.
    </p>
  );

  if (props.mode === "details") {
    const href = selected
      ? `/book/${props.doctorId}/details?starts_at=${encodeURIComponent(selected)}`
      : "";
    return (
      <>
        {notice}
        {anyFree ? null : none}
        {chips.length > 0 ? (
          <SlotRadios chips={chips} value={selected} onChange={choose} />
        ) : null}
        <StickyCta
          hint={
            selected
              ? `You picked ${formatTime(selected)}.`
              : "Pick a time to continue."
          }
        >
          {selected ? (
            <Button asChild size="lg" className="h-12 w-full text-base">
              <Link href={href}>Continue</Link>
            </Button>
          ) : (
            <Button size="lg" className="h-12 w-full text-base" disabled>
              Continue
            </Button>
          )}
        </StickyCta>
      </>
    );
  }

  const { appointmentId } = props;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        fd.set("starts_at", selected);
        attempted.current = selected;
        fd.set("recaptcha_token", await getToken().catch(() => ""));
        startTransition(() => formAction(fd));
      }}
    >
      <input type="hidden" name="appointment_id" value={appointmentId} />
      {notice}
      {anyFree ? null : none}
      {chips.length > 0 ? (
        <SlotRadios chips={chips} value={selected} onChange={choose} />
      ) : null}
      {state.status === "error" && state.code === "SLOT_TAKEN" ? (
        <div
          role="alert"
          className="mt-6 rounded-lg border border-border bg-muted p-4"
        >
          <p className="text-base font-semibold">{state.message}</p>
          <div className="mt-3">
            <NextSlots
              slots={state.nextSlots ?? []}
              hrefFor={(iso) =>
                `/appointments/${appointmentId}/reschedule?date=${clinicDay(iso)}`
              }
            />
          </div>
        </div>
      ) : state.status === "error" ? (
        <p role="alert" className="mt-6 text-base text-destructive">
          {state.message}
        </p>
      ) : null}
      <StickyCta
        hint={
          selected ? `New time: ${formatTime(selected)}.` : "Pick a new time."
        }
      >
        <Button
          type="submit"
          size="lg"
          className="h-12 w-full text-base"
          disabled={!selected || pending}
        >
          {pending ? "Moving…" : "Move appointment"}
        </Button>
      </StickyCta>
    </form>
  );
}
