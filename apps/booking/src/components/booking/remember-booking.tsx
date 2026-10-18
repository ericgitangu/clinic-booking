"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { rememberBooked } from "@/lib/own-bookings";

// On the confirmation page: tells the grid, which may be restored from history, that this time is
// now the patient's own, so going back shows it inactive without a reload.
export function RememberBooking({
  doctorId,
  startsAt,
}: {
  doctorId: string;
  startsAt: string;
}) {
  const qc = useQueryClient();
  useEffect(() => {
    rememberBooked(qc, { starts_at: startsAt, doctor_id: doctorId });
  }, [qc, doctorId, startsAt]);
  return null;
}
