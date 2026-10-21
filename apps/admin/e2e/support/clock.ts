// Moves a booked appointment to a half hour relative to now, straight in the database (starts must
// sit on a half hour). Nothing public can book a visit that has already begun or one starting in
// the next hour, and the desk-attendance window (15 minutes before to 2 hours after the start) can
// only be reached that way. The database is the compose one the run started. Two visits of one doctor cannot share a start, so each caller picks its
// own half hour.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { CLINIC_TZ } from "../../src/lib/clinic-time";
import { nextHalfHourMoveSql, noFreeNextHalfHourMessage } from "./slot-sql";

// Reach the stack under test the way whoever started it did. A run that set COMPOSE_PROJECT_NAME
// (scripts/e2e_admin.sh does) is followed by name; CI starts the stack with a plain `docker compose
// up` from the repository root, so there the compose file's own default project applies and no name
// is passed. Playwright runs from apps/admin, hence the path to the compose file.
const COMPOSE_FILE = path.resolve(process.cwd(), "../../docker-compose.yml");
const COMPOSE_ARGS = [
  "compose",
  ...(process.env.COMPOSE_PROJECT_NAME
    ? ["-p", process.env.COMPOSE_PROJECT_NAME]
    : []),
  "-f",
  COMPOSE_FILE,
];

// The slot a visit is moved to is found, not assumed: the first half hour (and doctor) with no booked
// visit already there, so specs never collide on the one-booked-visit-per-doctor-slot rule whatever
// ran before. The search starts at the half hour the caller prefers and works through the others;
// a caller that needs the desk-attendance window (a visit begun within the last two hours) only
// gets half hours inside it. Doctors are tried from the end of the alphabet, so the doctor most
// specs book first keeps its slots.
function runPast(
  id: string,
  prefer: number,
  window: boolean,
  anyStatus: boolean,
): void {
  // Three back at most keeps the visit inside the two-hour desk window. Searching only two back left
  // too few free doctor and half-hour pairs once earlier specs had taken theirs; specs that check the
  // marks ask for two back or less themselves, so the window does not close while they look.
  const hi = window ? 3 : 8;
  const base = `(date_trunc('hour', now())
        + CASE WHEN extract(minute FROM now()) >= 30 THEN interval '30 minutes' ELSE interval '0' END)`;
  const sql = `
    WITH cand AS (
      SELECT d.id AS doctor_id, ${base} - k * interval '30 minutes' AS s
      FROM doctors d, generate_series(0, ${hi}) k
      WHERE NOT EXISTS (
        SELECT 1 FROM appointments o
        WHERE o.doctor_id = d.id AND o.status = 'booked' AND o.id <> '${id}'
          AND o.starts_at = ${base} - k * interval '30 minutes')
      ORDER BY (k <> ${prefer}), k, d.full_name DESC
      LIMIT 1)
    UPDATE appointments a
       SET starts_at = cand.s, ends_at = cand.s + interval '30 minutes', doctor_id = cand.doctor_id
      FROM cand
     WHERE a.id = '${id}'${anyStatus ? "" : " AND a.status = 'booked'"}`;
  execute(sql, id);
}

function execute(
  sql: string,
  id: string,
  failure: (psql: string) => string = (out) =>
    `no free half hour to move ${id} to (psql said: ${out.trim()})`,
): void {
  const out = execFileSync(
    "docker",
    [
      ...COMPOSE_ARGS,
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "clinic",
      "-d",
      "clinic",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { stdio: "pipe" },
  ).toString();
  if (!/UPDATE 1/.test(out)) {
    throw new Error(failure(out));
  }
}

/**
 * Moves a booked visit to a half hour that began in the last few hours, on the first free doctor and
 * slot. `back` (0 to 8) is the preferred number of half hours before the latest one; a value of 3 or
 * less keeps the visit inside the desk window (begun within two hours), and the search then stays
 * inside it.
 */
export function moveToPastHalfHour(
  id: string,
  back = 0,
  anyStatus = false,
): void {
  if (!Number.isInteger(back) || back < 0 || back > 8) {
    throw new Error("back must be 0 to 8");
  }
  runPast(id, back, back <= 3, anyStatus);
}

/**
 * The next half hour that is at least 20 minutes away: inside the last hour before the visit. The
 * doctor is found, not assumed: the first one with no booked visit at that start (see slot-sql.ts).
 */
export function moveToNextHalfHour(id: string): void {
  execute(nextHalfHourMoveSql(id), id, (out) =>
    noFreeNextHalfHourMessage(id, out),
  );
}

/**
 * A visit moved to a past half hour can land on yesterday's clinic date shortly after local
 * midnight, and "today's" board would not show it. moveToPastHalfHour may take any free half hour
 * up to 3 back (or up to 8 when it is asked for more than 3), so the window is that deepest slot,
 * not a fixed hour. Specs that need the visit on the board skip then, and say so, rather than flake.
 */
export function pastHalfHourCanFallOnYesterday(
  back = 0,
  now = new Date(),
): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: CLINIC_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const at = (t: string) => Number(parts.find((x) => x.type === t)?.value);
  const sinceMidnight = at("hour") * 60 + at("minute");
  const halfHourStart = sinceMidnight - (sinceMidnight % 30);
  const deepest = back <= 3 ? 3 : 8;
  return halfHourStart - deepest * 30 < 0;
}

/** The next-half-hour move can roll into tomorrow in the last hour of the clinic day. */
export function inLastHourOfClinicDay(now = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: CLINIC_TZ,
      hour: "2-digit",
      hour12: false,
    }).format(now),
  );
  return hour >= 23;
}
