"use client";

import Link from "next/link";
import { startTransition, useActionState } from "react";
import { Button } from "@clinic/ui/components/ui/button";
import { Input } from "@clinic/ui/components/ui/input";
import { Label } from "@clinic/ui/components/ui/label";
import { bookAppointment } from "@/app/actions";
import { initialState } from "@/lib/action-state";
import { NextSlots } from "@/components/booking/next-slots";
import { StickyCta } from "@/components/booking/sticky-cta";
import { useActionFeedback } from "@/components/booking/use-action-feedback";
import { useRecaptcha } from "@/components/booking/use-recaptcha";

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-base">
        {label}
      </Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-base text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function BookingForm({
  doctorId,
  startsAt,
  rememberedName,
}: {
  doctorId: string;
  startsAt: string;
  rememberedName: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    bookAppointment,
    initialState,
  );
  const getToken = useRecaptcha("book");
  useActionFeedback(state);
  const fe = state.status === "error" ? (state.fieldErrors ?? {}) : {};

  return (
    <form
      noValidate
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

      {rememberedName ? (
        <>
          <input type="hidden" name="as_remembered" value="1" />
          <p className="text-base">
            Booking as <span className="font-semibold">{rememberedName}</span>.
          </p>
        </>
      ) : (
        <>
          <Field id="full_name" label="Full name" error={fe.full_name}>
            <Input
              id="full_name"
              name="full_name"
              autoComplete="name"
              required
              minLength={2}
              maxLength={200}
              aria-invalid={Boolean(fe.full_name)}
              aria-describedby={fe.full_name ? "full_name-error" : undefined}
              className="h-12"
            />
          </Field>
          <Field
            id="phone"
            label="Phone (optional)"
            hint="International format, like +254712345678."
            error={fe.phone}
          >
            <Input
              id="phone"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              aria-invalid={Boolean(fe.phone)}
              aria-describedby={fe.phone ? "phone-error" : "phone-hint"}
              className="h-12"
            />
          </Field>
          <Field id="email" label="Email (optional)" error={fe.email}>
            <Input
              id="email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              aria-invalid={Boolean(fe.email)}
              aria-describedby={fe.email ? "email-error" : undefined}
              className="h-12"
            />
          </Field>
        </>
      )}

      <StickyCta>
        <Button
          type="submit"
          size="lg"
          className="h-12 w-full text-base"
          disabled={pending}
        >
          {pending ? "Booking…" : "Confirm booking"}
        </Button>
      </StickyCta>
    </form>
  );
}
