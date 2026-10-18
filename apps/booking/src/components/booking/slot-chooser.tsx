"use client";

import Link from "next/link";
import { startTransition, useActionState, useEffect, useState } from "react";
import type { Availability } from "@clinic/api/generated";
import { Button } from "@clinic/ui/components/ui/button";
import { rescheduleAppointment } from "@/app/actions";
import { initialState } from "@/lib/action-state";
import { clinicDay, formatTime } from "@/lib/clinic-time";
import { NextSlots } from "@/components/booking/next-slots";
import { StickyCta } from "@/components/booking/sticky-cta";
import { useActionFeedback } from "@/components/booking/use-action-feedback";
import { useLiveSlots } from "@/components/booking/use-live-slots";
import { useRecaptcha } from "@/components/booking/use-recaptcha";
import { pickWasTaken } from "@/lib/polling";

// `availability` is the server-rendered answer for one doctor and day; the chooser keeps it current.
type Props =
  | { mode: "details"; doctorId: string; availability: Availability }
  | { mode: "reschedule"; appointmentId: string; availability: Availability };

function SlotRadios({
  slots,
  value,
  onChange,
}: {
  slots: { starts_at: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <fieldset>
      <legend className="sr-only">Free times</legend>
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
        {slots.map((s) => (
          <li key={s.starts_at}>
            <label className="block">
              <input
                type="radio"
                name="slot"
                value={s.starts_at}
                checked={value === s.starts_at}
                onChange={() => onChange(s.starts_at)}
                className="peer sr-only"
              />
              <span className="slot-chip-label flex min-h-12 cursor-pointer items-center justify-center rounded-lg border border-border bg-card text-base font-semibold hover:bg-accent peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-checked:hover:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring">
                {formatTime(s.starts_at)}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

// Says why the list changed under the person, and offers the way back when polling has stopped.
function LiveNotice({
  taken,
  idle,
  armed,
  failing,
  onResume,
}: {
  taken: string;
  idle: boolean;
  armed: boolean;
  failing: boolean;
  onResume: () => void;
}) {
  return (
    <>
      <span hidden data-polling={armed ? "armed" : "pending"} />
      {failing ? (
        <p aria-live="polite" className="mb-4 text-sm text-muted-foreground">
          Couldn&apos;t refresh the times just now. Trying again shortly.
        </p>
      ) : null}
      {taken ? (
        <p
          role="status"
          className="mb-4 rounded-lg border border-border bg-muted p-4 text-base font-semibold"
        >
          {formatTime(taken)} was just taken. Pick another time.
        </p>
      ) : null}
      {idle ? (
        <button
          type="button"
          onClick={onResume}
          className="mb-4 rounded-full border border-border bg-muted px-4 py-2 text-base underline underline-offset-4"
        >
          Paused, click to refresh
        </button>
      ) : null}
    </>
  );
}

export function SlotChooser(props: Props) {
  const [selected, setSelected] = useState("");
  const [taken, setTaken] = useState("");
  const { slots, idle, armed, failing, resume, refresh } = useLiveSlots(
    props.availability,
  );
  // A time the person had picked that is gone from the latest list: say so and clear the pick.
  useEffect(() => {
    if (pickWasTaken(selected, slots)) {
      setTaken(selected);
      setSelected("");
    } else if (selected) {
      setTaken("");
    }
  }, [selected, slots]);
  const [state, formAction, pending] = useActionState(
    rescheduleAppointment,
    initialState,
  );
  const getToken = useRecaptcha("reschedule");
  useActionFeedback(state);
  // Losing the race on submit means the list is stale: refetch it now rather than wait for the poll.
  const lostRace = state.status === "error" && state.code === "SLOT_TAKEN";
  useEffect(() => {
    if (lostRace) void refresh();
  }, [lostRace, refresh]);

  const notice = (
    <LiveNotice
      taken={taken}
      idle={idle}
      armed={armed}
      failing={failing}
      onResume={resume}
    />
  );

  if (slots.length === 0) {
    return (
      <>
        {notice}
        <p className="rounded-lg border border-dashed border-border p-6 text-base text-muted-foreground">
          No free times on this day. Pick another date above.
        </p>
      </>
    );
  }

  if (props.mode === "details") {
    const href = selected
      ? `/book/${props.doctorId}/details?starts_at=${encodeURIComponent(selected)}`
      : "";
    return (
      <>
        {notice}
        <SlotRadios slots={slots} value={selected} onChange={setSelected} />
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
        fd.set("recaptcha_token", await getToken().catch(() => ""));
        startTransition(() => formAction(fd));
      }}
    >
      <input type="hidden" name="appointment_id" value={appointmentId} />
      {notice}
      <SlotRadios slots={slots} value={selected} onChange={setSelected} />
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
