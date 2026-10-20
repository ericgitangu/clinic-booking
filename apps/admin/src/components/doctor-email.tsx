"use client";

import { useState } from "react";
import { MailIcon } from "lucide-react";
import { Button } from "@clinic/ui/components/ui/button";
import { Input } from "@clinic/ui/components/ui/input";
import { Label } from "@clinic/ui/components/ui/label";
import { ConfirmAction } from "@/components/confirm-action";
import { setDoctorEmail } from "@/lib/actions";
import { emailProblem } from "@/lib/doctor-email-check";

/**
 * Where the arrival email for one doctor goes, on the doctor's card on the today board: the address
 * (or "not set"), a button to set or change it and one to remove it. Both are staff changes like the
 * others: the same confirmation dialog, a reason, and an audit row with the address before and
 * after. Only owner and admin are given this (the page decides; the API checks again), and the
 * address itself reaches the page only for them.
 */
export function DoctorEmail({
  doctorId,
  doctorName,
  email,
}: {
  doctorId: string;
  doctorName: string;
  email: string | null;
}) {
  const [value, setValue] = useState(email ?? "");
  const [touched, setTouched] = useState(false);
  const problem = emailProblem(value);
  const inputId = `doctor-email-${doctorId}`;
  const hintId = `${inputId}-hint`;
  const shown = touched && problem !== null;

  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
      data-testid="doctor-email"
    >
      <MailIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 break-all">
        <span className="text-muted-foreground">Arrival email: </span>
        <span data-testid="doctor-email-value">
          {email ?? "not set, so the doctor is not emailed"}
        </span>
      </span>
      <ConfirmAction
        trigger={
          <Button
            variant="outline"
            size="sm"
            className="min-h-11"
            data-testid="doctor-email-set"
            // The visible words come first in the name, so the name contains what is seen.
            aria-label={`${email ? "Change arrival email" : "Set email"} for ${doctorName}`}
            onClick={() => {
              setValue(email ?? "");
              setTouched(false);
            }}
          >
            {email ? "Change" : "Set email"}
          </Button>
        }
        title={`Arrival email for ${doctorName}`}
        description="This is where the clinic emails the doctor when a patient is marked arrived. The email names the patient by first name and last initial only."
        confirmLabel="Save email"
        extra={
          <div className="space-y-2">
            <Label htmlFor={inputId}>Doctor&apos;s email address</Label>
            <Input
              id={inputId}
              type="email"
              inputMode="email"
              autoComplete="off"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setTouched(true);
              }}
              onBlur={() => setTouched(true)}
              aria-invalid={shown}
              aria-describedby={hintId}
              data-testid="doctor-email-input"
            />
            <p
              id={hintId}
              className={
                shown
                  ? "text-sm text-destructive"
                  : "text-sm text-muted-foreground"
              }
              role={shown ? "alert" : undefined}
            >
              {shown
                ? problem
                : "One address, like name@clinic.org. The clinic's own address, not a personal one."}
            </p>
          </div>
        }
        extraReady={value.trim() !== "" && problem === null}
        run={(reason) => setDoctorEmail(doctorId, value, reason)}
      />
      {email && (
        <ConfirmAction
          trigger={
            <Button
              variant="ghost"
              size="sm"
              className="min-h-11"
              aria-label={`Remove arrival email for ${doctorName}`}
            >
              Remove
            </Button>
          }
          title={`Remove the arrival email for ${doctorName}`}
          description="After this the doctor is not emailed when a patient arrives, until an address is set again."
          confirmLabel="Remove email"
          run={(reason) => setDoctorEmail(doctorId, "", reason)}
        />
      )}
    </div>
  );
}
