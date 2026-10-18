"use client";

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  addOwn,
  removeOwn,
  sameInstant,
  type OwnBooking,
} from "@/lib/slot-chips";

// The patient's own bookings made or cancelled in this browser session, kept in the query cache.
// The server sends the list when a page is built, but a page restored by Back is the old build; the
// cache is what keeps the grid right across navigation without a reload. Reading is the union of
// both; a reload starts from the server's list alone.
const KEY = ["own-bookings-session"] as const;
type Session = { added: OwnBooking[]; removed: string[] };
const EMPTY: Session = { added: [], removed: [] };

const read = (qc: QueryClient) => qc.getQueryData<Session>(KEY) ?? EMPTY;

export function rememberBooked(qc: QueryClient, b: OwnBooking) {
  const s = read(qc);
  qc.setQueryData<Session>(KEY, {
    added: addOwn(s.added, b),
    removed: s.removed.filter((r) => !sameInstant(r, b.starts_at)),
  });
}

export function forgetBooked(qc: QueryClient, startsAt: string) {
  const s = read(qc);
  qc.setQueryData<Session>(KEY, {
    added: removeOwn(s.added, startsAt),
    removed: [...s.removed, startsAt],
  });
}

/** The server's list plus what this session added, minus what it cancelled. */
export function mergeOwn(
  server: readonly OwnBooking[],
  s: Session,
): OwnBooking[] {
  let out = [...server];
  for (const a of s.added) out = addOwn(out, a);
  for (const r of s.removed) out = removeOwn(out, r);
  return out;
}

export function useOwnBooked(server: readonly OwnBooking[]): OwnBooking[] {
  // Subscribes to the cache entry; never fetches (there is nothing to fetch).
  const { data } = useQuery({
    queryKey: KEY,
    queryFn: () => EMPTY,
    enabled: false,
    initialData: EMPTY,
    staleTime: Infinity,
  });
  return useMemo(() => mergeOwn(server, data), [server, data]);
}
