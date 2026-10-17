"use client";

import Link from "next/link";
import { startTransition, useActionState, useEffect, useState } from "react";
import { Button } from "@clinic/ui/components/ui/button";
import { bookAppointment } from "@/app/actions";
import { initialState } from "@/lib/action-state";
import { NextSlots } from "@/components/booking/next-slots";
import { StickyCta } from "@/components/booking/sticky-cta";
import { useActionFeedback } from "@/components/booking/use-action-feedback";
import { useRecaptcha } from "@/components/booking/use-recaptcha";

// Booking as the signed-in person: the patient is whoever the session belongs to, so there is
// nothing to type. The server checks the session again when this is submitted.
export function BookingForm({
  doctorId,
  startsAt,
  name,
}: {
  doctorId: string;
  startsAt: string;
  name: string;
}) {
  const [state, formAction, pending] = useActionState(
    bookAppointment,
    initialState,
  );
  const getToken = useRecaptcha("book");
  // Until the page has hydrated a submit would be a plain browser form post. The button stays off
  // until the handler is attached.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  useActionFeedback(state);

  return (
    <form
      className="space-y-6"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        fd.set("recaptcha_token", await getToken().catch(() => ""));
        startTransition(() => formAction(fd));
      }}
    >
      <input type="hidden" name="doctor_id" value={doctorId} />
      <input type="hidden" name="starts_at" value={startsAt} />

      {state.status === "error" ? (
        <div
          role="alert"
          className="rounded-lg border border-border bg-muted p-4"
        >
          <p className="text-base font-semibold">{state.message}</p>
          {state.code === "SLOT_TAKEN" ? (
            <div className="mt-3">
              <NextSlots
                slots={state.nextSlots ?? []}
                hrefFor={(iso) =>
                  `/book/${doctorId}/details?starts_at=${encodeURIComponent(iso)}`
                }
              />
              <p className="mt-3 text-sm">
                <Link
                  href={`/book/${doctorId}`}
                  className="underline underline-offset-4"
                >
                  Pick a different day
                </Link>
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      <p className="text-base">
        Booking as <span className="font-semibold">{name}</span>.
      </p>

      <StickyCta>
        <Button
          type="submit"
          size="lg"
          className="h-12 w-full text-base"
          disabled={!ready || pending}
        >
          {pending ? "Booking…" : "Confirm booking"}
        </Button>
      </StickyCta>
    </form>
  );
}
