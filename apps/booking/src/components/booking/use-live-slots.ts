"use client";

import { doctorAvailabilityDoctorsDoctorIdAvailabilityGetOptions } from "@clinic/api/generated/@tanstack/react-query.gen";
import { client } from "@clinic/api/generated/client.gen";
import type { Availability } from "@clinic/api/generated";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { IDLE_MS, POLL_MS, pollInterval } from "@/lib/polling";

// The browser reaches the API only through the same-origin proxy (ADR-0010), never Cloud Run.
client.setConfig({ baseUrl: "/api" });

const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "touchstart"];

/**
 * Free times for one doctor and day, kept current (ADR-0009). The server-rendered list is the first
 * answer. While the tab is visible the list is refetched every POLL_MS (TanStack Query pauses the
 * interval when the document is hidden and refetches when the tab is shown again). After IDLE_MS
 * without pointer or keyboard input polling stops until `resume` is called.
 */
export function useLiveSlots(initial: Availability) {
  const [idle, setIdle] = useState(false);
  const lastInput = useRef(0);

  const query = useQuery({
    ...doctorAvailabilityDoctorsDoctorIdAvailabilityGetOptions({
      path: { doctor_id: initial.doctor_id },
      query: { date: initial.date },
    }),
    initialData: initial,
    staleTime: POLL_MS,
    refetchInterval: pollInterval(idle),
    refetchOnWindowFocus: !idle,
  });

  useEffect(() => {
    if (idle) return;
    lastInput.current = Date.now();
    const bump = () => {
      lastInput.current = Date.now();
    };
    for (const e of INPUT_EVENTS)
      window.addEventListener(e, bump, { passive: true });
    let timer: ReturnType<typeof setTimeout>;
    const arm = (ms: number) => {
      timer = setTimeout(() => {
        const left = IDLE_MS - (Date.now() - lastInput.current);
        if (left <= 0) setIdle(true);
        else arm(left);
      }, ms);
    };
    arm(IDLE_MS);
    return () => {
      clearTimeout(timer);
      for (const e of INPUT_EVENTS) window.removeEventListener(e, bump);
    };
  }, [idle]);

  const { refetch } = query;
  const resume = useCallback(() => {
    setIdle(false);
    void refetch();
  }, [refetch]);

  return { slots: query.data.slots, idle, resume, refresh: refetch };
}
