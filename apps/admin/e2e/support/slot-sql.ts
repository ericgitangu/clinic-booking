// The SQL behind the half-hour moves in clock.ts, kept apart from the docker call so its shape can be
// unit tested without a stack.
import { CLINIC_TZ } from "../../src/lib/clinic-time";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ids are interpolated into SQL (psql -c has no bind parameters), so only a uuid gets through. */
export function assertUuid(id: string): void {
  if (!UUID.test(id)) throw new Error(`appointment id is not a uuid: ${id}`);
}

/**
 * Moves one booked visit to the next half hour that is 20 to 50 minutes away, on a doctor with no
 * booked visit at that start. The demo seed fills the clinic's days, so the visit's own doctor can
 * already hold that start and the partial unique index uq_appt_doctor_slot_booked would refuse a
 * plain move; the doctor is therefore searched, not assumed. Doctors who work that half hour come
 * first, then the end of the alphabet (the doctor most specs book first keeps their slots). The
 * statement updates nothing when every doctor is busy at that start.
 */
export function nextHalfHourMoveSql(id: string): string {
  assertUuid(id);
  return `
    WITH slot AS (
      SELECT date_trunc('hour', now() + interval '50 minutes')
        + CASE WHEN extract(minute FROM now() + interval '50 minutes') >= 30
               THEN interval '30 minutes' ELSE interval '0' END AS s),
    cand AS (
      SELECT d.id AS doctor_id, slot.s AS s
      FROM doctors d, slot
      WHERE d.is_active
        AND NOT EXISTS (
          SELECT 1 FROM appointments o
          WHERE o.doctor_id = d.id AND o.status = 'booked' AND o.id <> '${id}'
            AND o.starts_at = slot.s)
      ORDER BY EXISTS (
          SELECT 1 FROM working_hours w
          WHERE w.doctor_id = d.id
            AND w.weekday = extract(isodow FROM slot.s AT TIME ZONE '${CLINIC_TZ}')
            AND (slot.s AT TIME ZONE '${CLINIC_TZ}')::time >= w.start_time
            AND (slot.s AT TIME ZONE '${CLINIC_TZ}')::time + interval '30 minutes' <= w.end_time) DESC,
        d.full_name DESC
      LIMIT 1)
    UPDATE appointments a
       SET starts_at = cand.s, ends_at = cand.s + interval '30 minutes', doctor_id = cand.doctor_id
      FROM cand
     WHERE a.id = '${id}' AND a.status = 'booked'`;
}

/** What to say when the move changed nothing: what was searched and the two reasons it can come up empty. */
export function noFreeNextHalfHourMessage(id: string, psql: string): string {
  return (
    `could not move appointment ${id} to the next half hour (20 to 50 minutes away). ` +
    `Searched: every active doctor, for a start with no booked visit on it. ` +
    `It comes up empty when every doctor already has a booked visit at that start, ` +
    `or when the appointment is not booked (cancelled, completed or missing). ` +
    `psql said: ${psql.trim()}`
  );
}
