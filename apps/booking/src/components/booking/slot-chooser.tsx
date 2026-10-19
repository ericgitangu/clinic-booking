"use client";

import {
  startTransition,
  useCallback,
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
import { SlotLinks } from "@/components/booking/slot-links";
import { SlotRadios } from "@/components/booking/slot-radios";
import { StickyCta } from "@/components/booking/sticky-cta";
import { useActionFeedback } from "@/components/booking/use-action-feedback";
import { useLiveAvailability } from "@/components/booking/use-live-availability";
import { useRecaptcha } from "@/components/booking/use-recaptcha";
import { useOwnBooked } from "@/lib/own-bookings";
import { buildChips, type Chip, type OwnBooking } from "@/lib/slot-chips";

// `availability` is the server-rendered answer for one doctor and day; the chooser keeps it
// current. `own` is what the signed-in patient already holds (empty when signed out).
type Props = {
  own: OwnBooking[];
  availability: Availability;
  /** Set by the page from lib/test-run.ts; production leaves it off. */
  trackRenders?: boolean;
} & (
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
  // The API lists the time as booked, or said so with a 409, or a slot_taken event arrived.
  if (now === "just-taken" || now === "booked")
    return `${t} was just taken. Pick another time.`;
  return `${t} is no longer available. Pick another time.`;
}

// The two status lines are always on the page, and only their text changes, so a screen reader
// announces a change instead of missing a node that appeared together with its words.
function LiveNotice({
  lost,
  idle,
  armed,
  stream,
  failing,
  onResume,
}: {
  lost: string;
  idle: boolean;
  armed: boolean;
  stream: string;
  failing: boolean;
  onResume: () => void;
}) {
  return (
    <>
      <span
        hidden
        data-polling={armed ? "armed" : "pending"}
        data-stream={stream}
      />
      <p
        data-testid="live-state"
        className="mb-1 flex min-h-5 items-center gap-2 text-sm text-muted-foreground"
      >
        <span
          aria-hidden
          className="live-dot"
          data-on={stream === "live" && !idle ? "live" : "off"}
        />
        {idle
          ? "Updates paused"
          : stream === "live"
            ? "Live: times update as they change"
            : "Checking for changes every few seconds"}
      </p>
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
  const live = useLiveAvailability(availability);
  const own = useOwnBooked(props.own);

  // Every free time this grid has shown, so one that disappears stays in its place (as "Booked"
  // when the response lists it as taken, "Just taken" when confirmed, otherwise "No longer
  // available") instead of vanishing and moving the others. Updated while rendering, only when there is
  // something new to add (the documented pattern for state derived from props).
  const [seen, setSeen] = useState<string[]>(() =>
    availability.slots.map((s) => s.starts_at),
  );
  const unseen = live.slots.filter((s) => !seen.includes(s.starts_at));
  if (unseen.length > 0) setSeen([...seen, ...unseen.map((s) => s.starts_at)]);

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
        confirmedTaken: live.justTaken,
      }),
    [doctorId, day, live.slots, live.taken, own, seen, live.justTaken],
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
  // Stable, so the memoised grid is not re-rendered by every unrelated render of this component.
  const choose = useCallback((v: string) => {
    setLost("");
    setSelected(v);
  }, []);

  const [state, formAction, pending] = useActionState(
    rescheduleAppointment,
    initialState,
  );
  const getToken = useRecaptcha("reschedule");
  useActionFeedback(state);
  // Losing the race on submit means the list is stale: refetch it now rather than wait for the poll.
  const lostRace = state.status === "error" && state.code === "SLOT_TAKEN";
  const { markTaken } = live;
  useEffect(() => {
    // RULE 3: the API's 409 is the confirmation. Patch the grid at once, then refetch once.
    if (lostRace && attempted.current) markTaken(attempted.current);
  }, [lostRace, markTaken]);

  const notice = (
    <LiveNotice
      lost={lost}
      idle={live.idle}
      armed={live.armed}
      stream={live.stream}
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
    // No selection step here: a free time is a link to its details page.
    return (
      <>
        {notice}
        {anyFree ? null : none}
        {chips.length > 0 ? (
          <SlotLinks
            chips={chips}
            doctorId={props.doctorId}
            trackRenders={props.trackRenders}
          />
        ) : null}
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
        <SlotRadios
          chips={chips}
          value={selected}
          onChange={choose}
          trackRenders={props.trackRenders}
        />
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
