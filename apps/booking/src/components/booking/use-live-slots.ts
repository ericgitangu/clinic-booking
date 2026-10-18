"use client";

import { doctorAvailabilityDoctorsDoctorIdAvailabilityGetOptions } from "@clinic/api/generated/@tanstack/react-query.gen";
import { client } from "@clinic/api/generated/client.gen";
import type { Availability } from "@clinic/api/generated";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { IDLE_MS, POLL_MS, parseRetryAfter, pollInterval } from "@/lib/polling";

// The browser reaches the API only through the same-origin proxy, never Cloud Run.
client.setConfig({ baseUrl: "/api" });

// When the proxy answers 429 it says how long to wait (Retry-After). The generated client throws
// only the body on an error, so the header is read here, as the response passes, and kept until
// the time it names. Polling and focus refetches both stay quiet until then.
let retryNotBefore = 0;
client.interceptors.response.use((response) => {
  if (response.status === 429) {
    const ms = parseRetryAfter(response.headers.get("retry-after"));
    if (ms !== null) retryNotBefore = Date.now() + ms;
  }
  return response;
});
const retryWait = () => Math.max(retryNotBefore - Date.now(), 0);

const INPUT_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "touchstart",
  "wheel",
  "scroll",
];

/**
 * Free times for one doctor and day, kept current. The server-rendered list is the first
 * answer. While the tab is visible the list is refetched every POLL_MS (TanStack Query pauses the
 * interval when the document is hidden and refetches when the tab is shown again). After IDLE_MS
 * without pointer or keyboard input polling stops until `resume` is called.
 */
export function useLiveSlots(initial: Availability) {
  const [idle, setIdle] = useState(false);
  // True once the polling is running (interval subscribed, idle timer armed). Exposed to the page
  // as a data attribute so tests wait for it instead of racing hydration.
  const [armed, setArmed] = useState(false);
  const lastInput = useRef(0);
  // Refreshes that failed in a row; reset by the first success. Read by refetchInterval.
  const failures = useRef(0);

  const base = doctorAvailabilityDoctorsDoctorIdAvailabilityGetOptions({
    path: { doctor_id: initial.doctor_id },
    query: { date: initial.date },
  });
  const query = useQuery({
    ...base,
    queryFn: async (ctx) => {
      try {
        const data = await base.queryFn!(ctx);
        failures.current = 0;
        return data;
      } catch (err) {
        failures.current += 1;
        throw err;
      }
    },
    initialData: initial,
    staleTime: POLL_MS,
    // A failed poll is not retried inside the fetch (that would double the rate, and a 429 must not
    // be retried at all); the backed-off interval is the retry.
    retry: false,
    refetchInterval: () => pollInterval(idle, failures.current, retryWait()),
    refetchOnWindowFocus: () => !idle && retryWait() === 0,
  });

  useEffect(() => {
    if (idle) return;
    lastInput.current = Date.now();
    const bump = () => {
      lastInput.current = Date.now();
    };
    // Capture, so a scroll inside any element counts (scroll events do not bubble).
    for (const e of INPUT_EVENTS)
      window.addEventListener(e, bump, { passive: true, capture: true });
    let timer: ReturnType<typeof setTimeout>;
    const arm = (ms: number) => {
      timer = setTimeout(() => {
        const left = IDLE_MS - (Date.now() - lastInput.current);
        if (left <= 0) setIdle(true);
        else arm(left);
      }, ms);
    };
    arm(IDLE_MS);
    setArmed(true);
    return () => {
      clearTimeout(timer);
      for (const e of INPUT_EVENTS)
        window.removeEventListener(e, bump, { capture: true });
    };
  }, [idle]);

  const { refetch } = query;
  const resume = useCallback(() => {
    setIdle(false);
    void refetch();
  }, [refetch]);

  return {
    slots: query.data.slots,
    // Every taken time of this doctor and day, if the response lists them (a field the contract does
    // not have yet; absent today).
    taken: (query.data as { taken?: string[] }).taken,
    idle,
    armed,
    // The last refresh failed: the list on screen may be out of date.
    failing: query.isError,
    resume,
    refresh: refetch,
  };
}
