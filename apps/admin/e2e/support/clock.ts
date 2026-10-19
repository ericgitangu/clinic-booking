// Moves a booked appointment to a half hour relative to now, straight in the database (starts must
// sit on a half hour). Nothing public can book a visit that has already begun or one starting in
// the next hour, and the desk-attendance window (15 minutes before to 2 hours after the start) can
// only be reached that way. The database is the compose one the run started. Two visits of one doctor cannot share a start, so each caller picks its
// own half hour.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { CLINIC_TZ } from "../../src/lib/clinic-time";

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

function run(
  id: string,
  start: string,
  anyStatus = false,
  lastDoctor = false,
): void {
  execFileSync(
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
      `UPDATE appointments SET starts_at = ${start}, ends_at = ${start} + interval '30 minutes'${
        lastDoctor
          ? ", doctor_id = (SELECT id FROM doctors ORDER BY full_name DESC LIMIT 1)"
          : ""
      }
         WHERE id = '${id}'${anyStatus ? "" : " AND status = 'booked'"}`,
    ],
    { stdio: "pipe" },
  );
}

/** The half hour that began at most 30 minutes ago, minus `back` further half hours (0 to 8). */
export function moveToPastHalfHour(
  id: string,
  back = 0,
  anyStatus = false,
  /** Also hand the visit to the last doctor, whom no other spec books, to avoid sharing a slot. */
  lastDoctor = false,
): void {
  if (!Number.isInteger(back) || back < 0 || back > 8) {
    throw new Error("back must be 0 to 8");
  }
  run(
    id,
    `(date_trunc('hour', now())
        + CASE WHEN extract(minute FROM now()) >= 30 THEN interval '30 minutes' ELSE interval '0' END
        - interval '${back * 30} minutes')`,
    anyStatus,
    lastDoctor,
  );
}

/** The next half hour that is at least 20 minutes away: inside the last hour before the visit. */
export function moveToNextHalfHour(id: string): void {
  run(
    id,
    `(date_trunc('hour', now() + interval '50 minutes')
        + CASE WHEN extract(minute FROM now() + interval '50 minutes') >= 30
               THEN interval '30 minutes' ELSE interval '0' END)`,
  );
}

/**
 * A visit moved to a past half hour can fall on yesterday's clinic date in the first hour after
 * local midnight, where "today's" board would not show it. Specs that need it on the board skip
 * then, and say so, rather than flake.
 */
export function inFirstHourOfClinicDay(now = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: CLINIC_TZ,
      hour: "2-digit",
      hour12: false,
    }).format(now),
  );
  return hour === 0;
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
