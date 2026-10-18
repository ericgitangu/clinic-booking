import "server-only";
import * as api from "@/lib/api";
import type { OwnBooking } from "@/lib/slot-chips";
import { callerFor, getIdentity } from "@/lib/session";

// The signed-in patient's booked, not yet finished appointments, as the grid and the confirm step
// need them. Someone who is not signed in, has never booked, or whose list cannot be read gets an
// empty list: the grid then simply shows no "yours" chips and the API's own checks still apply.
export async function ownBooked(): Promise<OwnBooking[]> {
  const who = await getIdentity();
  if (!who) return [];
  const res = await api.myAppointments(callerFor(who));
  if (!res.ok) return [];
  const now = Date.now();
  return res.data.items
    .filter((a) => a.status === "booked" && Date.parse(a.ends_at) > now)
    .map((a) => ({
      starts_at: a.starts_at,
      doctor_id: a.doctor_id,
      doctor_name: a.doctor.full_name,
    }));
}
