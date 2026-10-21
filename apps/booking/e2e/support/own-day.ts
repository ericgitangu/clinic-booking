// A calendar day (clinic-local) that one scenario owns for as long as it runs, for the scenarios
// whose outcome depends on everything booked on a date: a reminder run claims every appointment on
// its date. The day comes from a small pool no other spec books on (the Monday to Friday of the
// calendar week that scenario number 9 of `pick` names), is held by a Postgres advisory lock on a
// connection the scenario keeps open (so parallel workers, repeated runs and a second run against
// the same database never share a day), and must have no booked appointment on it when taken.
// `release` cancels whatever the scenario left booked on the day, through the real API as the
// person who booked it, and lets the day go, so the same days serve any number of runs.
import { callApi } from "@clinic/api/call";
import { cancelMineInternalMeAppointmentsAppointmentIdCancelPatch } from "@clinic/api/generated";
import { addDays, API } from "./../api";
import { ANCHOR_DAY } from "./anchor";
import { withDb } from "./db";
import { Client as PgClient } from "pg";

// The pool: Monday to Friday of the week `pick(9)` uses (its Tuesday to Friday are the same dates).
function poolDays(): string[] {
  const tuesday = addDays(ANCHOR_DAY, 7 * 9);
  return [-1, 0, 1, 2, 3].map((i) => addDays(tuesday, i));
}

const lockKey = (day: string) => Number(day.replaceAll("-", "")); // 20261214: one bigint per day

const BOOKED_ON_DAY = `
  SELECT a.id, pa.google_sub, pa.email
  FROM appointments a JOIN patient_accounts pa ON pa.patient_id = a.patient_id
  WHERE a.status = 'booked'
    AND a.starts_at >= (CAST($1 AS date)::timestamp AT TIME ZONE 'Africa/Nairobi')
    AND a.starts_at <  (CAST($1 AS date)::timestamp + interval '1 day') AT TIME ZONE 'Africa/Nairobi'`;

export interface OwnedDay {
  day: string;
  release: () => Promise<void>;
}

export async function ownDay(waitMs = 90_000): Promise<OwnedDay> {
  const url =
    process.env.E2E_DB_URL ??
    `postgresql://clinic:clinic@127.0.0.1:${process.env.DB_HOST_PORT ?? "5432"}/clinic`;
  const holder = new PgClient({ connectionString: url });
  await holder.connect();
  const until = Date.now() + waitMs;
  try {
    for (;;) {
      for (const day of poolDays()) {
        const got = await holder.query(
          "SELECT pg_try_advisory_lock($1) AS ok",
          [lockKey(day)],
        );
        if (!got.rows[0].ok) continue;
        const booked = await holder.query(BOOKED_ON_DAY, [day]);
        if (booked.rows.length === 0) {
          return {
            day,
            release: async () => {
              try {
                await cancelAll(day);
              } finally {
                await holder.end(); // closing the connection releases the lock
              }
            },
          };
        }
        await holder.query("SELECT pg_advisory_unlock($1)", [lockKey(day)]);
      }
      if (Date.now() > until) throw new Error("no free day in the pool");
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (e) {
    await holder.end();
    throw e;
  }
}

async function cancelAll(day: string): Promise<void> {
  process.env.API_URL = API;
  const rows = await withDb(
    async (db) => (await db.query(BOOKED_ON_DAY, [day])).rows,
  );
  for (const r of rows) {
    await callApi(
      "cancelMine",
      (client) =>
        cancelMineInternalMeAppointmentsAppointmentIdCancelPatch({
          client,
          path: { appointment_id: r.id },
          body: { reason: "end of test" },
        }),
      {
        caller: {
          sub: r.google_sub,
          email: r.email,
          role: "patient",
          emailVerified: true,
        },
      },
    );
  }
}
