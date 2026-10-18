"use client";

import { useEventStream } from "@clinic/api/realtime";
import { TokenError, type StreamStatus } from "@clinic/api/realtime";
import { patientTokenRealtimeTokenPatientPost } from "@clinic/api/generated";
import type { Availability } from "@clinic/api/generated";
import { zSlotEvent } from "@clinic/api/generated/zod.gen";
import { doctorAvailabilityDoctorsDoctorIdAvailabilityGetOptions } from "@clinic/api/generated/@tanstack/react-query.gen";
import { client } from "@clinic/api/generated/client.gen";
import {
  replaceEqualDeep,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { acceptPolled, applyEvent, withTaken } from "@/lib/live-availability";
import {
  IDLE_MS,
  LIVE_POLL_MS,
  POLL_MS,
  parseRetryAfter,
  pollInterval,
} from "@/lib/polling";

// The browser reaches the API only through the same-origin proxy, never Cloud Run.
client.setConfig({ baseUrl: "/api" });

// When the proxy answers 429 it says how long to wait (Retry-After). The generated client throws
// only the body on an error, so the header is read here, as the response passes, and kept until
// the time it names. Polling and focus refetches both stay quiet until then.
let retryNotBefore = 0;
client.interceptors.response.use((response) => {
  // Only the availability polls: the token endpoint has its own limiter and its own Retry-After.
  if (response.status === 429 && response.url.includes("/availability")) {
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

/** What the page shows next to data-polling: is push healthy? */
export type StreamState = "live" | "polling" | "refused";
const shown = (s: StreamStatus): StreamState =>
  s === "live" ? "live" : s === "refused" ? "refused" : "polling";

/**
 * One doctor's free times for one day, kept current. TanStack Query holds the single copy.
 *
 * Push: a subscribe-only stream for this doctor and day (packages/api/realtime). While it is live
 * the safety-net poll slows to LIVE_POLL_MS; if it is off, refused or has dropped, polling runs at
 * POLL_MS with backoff, Retry-After and the idle stop. The server-rendered list is the first answer.
 * Three rules keep the grid from going backwards (lib/live-availability.ts): a poll older than the
 * data on screen is dropped; an event is applied only if newer than the last one and the response
 * on screen; our own 409 or booking patches the cache at once and then refetches once.
 */
export function useLiveAvailability(initial: Availability) {
  const qc = useQueryClient();
  const [idle, setIdle] = useState(false);
  // True once polling is running (interval subscribed, idle timer armed). Exposed to the page as a
  // data attribute so tests wait for it instead of racing hydration.
  const [armed, setArmed] = useState(false);
  const [stream, setStream] = useState<StreamState>("polling");
  // Times confirmed taken by someone else: a pushed slot_taken or our own 409. Only these are
  // called "Just taken".
  const [justTaken, setJustTaken] = useState<string[]>([]);
  const lastInput = useRef(0);
  const lastMint = useRef(0);
  const idleRef = useRef(false);
  const lastSeq = useRef<string | null>(null);
  const streamRef = useRef<StreamState>("polling");
  // Refreshes that failed in a row; reset by the first success. Read by refetchInterval.
  const failures = useRef(0);

  const base = doctorAvailabilityDoctorsDoctorIdAvailabilityGetOptions({
    path: { doctor_id: initial.doctor_id },
    query: { date: initial.date },
  });
  const key = base.queryKey;
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
    // RULE 1, and referential stability: an unchanged response keeps the same object, so nothing
    // that reads it renders again.
    structuralSharing: (old, next) =>
      replaceEqualDeep(
        old,
        acceptPolled(old as Availability | undefined, next as Availability),
      ),
    initialData: initial,
    staleTime: POLL_MS,
    // A failed poll is not retried inside the fetch (that would double the rate, and a 429 must not
    // be retried at all); the backed-off interval is the retry.
    retry: false,
    refetchInterval: () =>
      stream === "live"
        ? LIVE_POLL_MS
        : pollInterval(idle, failures.current, retryWait()),
    refetchOnWindowFocus: () => !idle && retryWait() === 0,
  });
  const { refetch } = query;
  const refetchOnce = useCallback(
    () => void refetch({ cancelRefetch: false }),
    [refetch],
  );

  const patch = useCallback(
    (startsAt: string) => {
      qc.setQueryData<Availability>(key, (d) =>
        d ? withTaken(d, startsAt) : d,
      );
      setJustTaken((j) => (j.includes(startsAt) ? j : [...j, startsAt]));
    },
    [qc, key],
  );

  const { poke } = useEventStream({
    enabled: armed && !idle,
    channelKey: `${initial.doctor_id}|${initial.date}`,
    schema: zSlotEvent,
    getToken: async (signal) => {
      lastMint.current = Date.now();
      const r = await patientTokenRealtimeTokenPatientPost({
        client,
        body: { doctor_id: initial.doctor_id, date: initial.date },
        signal,
        throwOnError: false,
      }).catch(() => null);
      if (!r || !r.data) {
        const status = r?.response?.status;
        if (status === 429)
          throw new TokenError(
            "rate_limited",
            parseRetryAfter(r?.response?.headers.get("retry-after")) ?? 0,
          );
        if (status === 503) throw new TokenError("unavailable");
        throw new TokenError("failed");
      }
      return { token: r.data.token, streamUrl: r.data.stream_url };
    },
    onStatus: (s) => {
      streamRef.current = shown(s);
      setStream(shown(s));
    },
    // The push service documents no signal for a failed resume, so every connect is followed by one
    // refetch.
    onConnected: refetchOnce,
    onEvent: (ev) => {
      const cur = qc.getQueryData<Availability>(key);
      if (!cur) return;
      const r = applyEvent(cur, lastSeq.current, ev);
      lastSeq.current = r.lastSeq;
      if (r.effect === "taken") {
        qc.setQueryData<Availability>(key, r.data);
        setJustTaken((j) =>
          j.includes(ev.starts_at) ? j : [...j, ev.starts_at],
        );
      } else if (r.effect === "freed") {
        refetchOnce(); // whether the time can be offered again is the server's call
      }
    },
    // Hidden, idle, or no input since the last token: do not mint another.
    shouldReconnect: () =>
      document.visibilityState === "visible" &&
      !idleRef.current &&
      lastInput.current > lastMint.current,
  });

  useEffect(() => {
    idleRef.current = idle;
    if (idle) return;
    lastInput.current = Date.now();
    const bump = () => {
      lastInput.current = Date.now();
      // Input may be what lets a dropped stream reconnect (never while it is live).
      if (streamRef.current !== "live") poke();
    };
    const visible = () => {
      if (document.visibilityState === "visible") poke();
    };
    document.addEventListener("visibilitychange", visible);
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
      document.removeEventListener("visibilitychange", visible);
      for (const e of INPUT_EVENTS)
        window.removeEventListener(e, bump, { capture: true });
    };
  }, [idle, poke]);

  const resume = useCallback(() => {
    setIdle(false);
    void refetch();
  }, [refetch]);

  return {
    slots: query.data.slots,
    // Every taken time of this doctor and day, as the API lists them.
    taken: query.data.taken,
    justTaken,
    idle,
    armed,
    stream,
    // The last refresh failed: the list on screen may be out of date.
    failing: query.isError,
    resume,
    refresh: refetch,
    /** RULE 3: the API said 409 for this time. Patch now, then refetch once. */
    markTaken: useCallback(
      (startsAt: string) => {
        patch(startsAt);
        refetchOnce();
      },
      [patch, refetchOnce],
    ),
  };
}
