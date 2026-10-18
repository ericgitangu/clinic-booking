-- One-off, audited removal of the release smoke's old test rows from the patient database.
--
-- Run it through scripts/ops/purge_synthetic.sh (it supplies :apply and the owner connection).
--
--   :apply = 0  (default) counts only: after the temporary selection tables are built the
--               transaction is set READ ONLY, and it always ends in ROLLBACK.
--   :apply = 1  deletes in ONE transaction, prints before and after counts, and aborts (the
--               transaction rolls back, nothing is kept) if any count is not what it should be.
--
-- Selected patients: full_name LIKE 'verify-claims %' or LIKE 'Release Gate Check%', and linked to
-- no patient account (a real signed-in person is never selected, whatever they typed as a name).
-- Deleted, children first: the events of their appointments, their appointments, then the
-- patients. Dependent tables checked in the schema (every foreign key to patients or
-- appointments): appointments.patient_id, appointment_events.appointment_id and
-- patient_accounts.patient_id; the last is empty for a selected patient by construction.
--
-- Needs the OWNER role: the runtime role has no DELETE. It marks and updates nothing else, and it
-- does not touch rows that merely have patients.synthetic = true but a different name (it reports
-- how many there are).
\set ON_ERROR_STOP on
\pset footer off

BEGIN;

CREATE TEMP TABLE _victim_patients ON COMMIT DROP AS
SELECT p.id
FROM patients p
WHERE (p.full_name LIKE 'verify-claims %' OR p.full_name LIKE 'Release Gate Check%')
  AND NOT EXISTS (SELECT 1 FROM patient_accounts pa WHERE pa.patient_id = p.id);

CREATE TEMP TABLE _victim_appointments ON COMMIT DROP AS
SELECT a.id FROM appointments a WHERE a.patient_id IN (SELECT id FROM _victim_patients);

CREATE TEMP TABLE _counts ON COMMIT DROP AS
SELECT 'before'::text AS phase,
       (SELECT count(*) FROM patients)            AS patients,
       (SELECT count(*) FROM appointments)        AS appointments,
       (SELECT count(*) FROM appointment_events)  AS events,
       (SELECT count(*) FROM patient_accounts)    AS accounts;

-- A dry run cannot write to any real table from here on (only the temporary tables above exist).
\if :apply
\else
SET TRANSACTION READ ONLY;
\endif

\echo
\echo == selected for removal ==
SELECT
  (SELECT count(*) FROM _victim_patients)                                  AS patients,
  (SELECT count(*) FROM patients p JOIN _victim_patients v USING (id)
     WHERE p.full_name LIKE 'verify-claims %')                             AS verify_claims_patients,
  (SELECT count(*) FROM patients p JOIN _victim_patients v USING (id)
     WHERE p.full_name LIKE 'Release Gate Check%')                         AS release_gate_patients,
  (SELECT count(*) FROM _victim_appointments)                              AS appointments,
  (SELECT count(*) FROM appointment_events e
     WHERE e.appointment_id IN (SELECT id FROM _victim_appointments))      AS events;

\echo == by appointment status ==
SELECT a.status, count(*) AS appointments
FROM appointments a WHERE a.id IN (SELECT id FROM _victim_appointments)
GROUP BY a.status ORDER BY a.status;

\echo == left alone (reported, never deleted) ==
SELECT
  (SELECT count(*) FROM patients p
     WHERE (p.full_name LIKE 'verify-claims %' OR p.full_name LIKE 'Release Gate Check%')
       AND EXISTS (SELECT 1 FROM patient_accounts pa WHERE pa.patient_id = p.id)) AS name_match_with_account,
  (SELECT count(*) FROM patients p
     WHERE (to_jsonb(p) ->> 'synthetic')::boolean IS TRUE  -- column may not exist yet (pre-0008)
       AND NOT (p.full_name LIKE 'verify-claims %' OR p.full_name LIKE 'Release Gate Check%')) AS synthetic_other_name;

\echo == whole table counts, before ==
SELECT patients, appointments, events, accounts FROM _counts WHERE phase = 'before';

\if :apply
-- Delete children first, check every row count against the selection, then re-count.
DO $purge$
DECLARE
  want_p bigint := (SELECT count(*) FROM _victim_patients);
  want_a bigint := (SELECT count(*) FROM _victim_appointments);
  want_e bigint := (SELECT count(*) FROM appointment_events e
                    WHERE e.appointment_id IN (SELECT id FROM _victim_appointments));
  got bigint;
  b _counts%ROWTYPE;
BEGIN
  SELECT * INTO b FROM _counts WHERE phase = 'before';

  DELETE FROM appointment_events WHERE appointment_id IN (SELECT id FROM _victim_appointments);
  GET DIAGNOSTICS got = ROW_COUNT;
  IF got <> want_e THEN RAISE EXCEPTION 'events deleted % <> selected %', got, want_e; END IF;

  DELETE FROM appointments WHERE id IN (SELECT id FROM _victim_appointments);
  GET DIAGNOSTICS got = ROW_COUNT;
  IF got <> want_a THEN RAISE EXCEPTION 'appointments deleted % <> selected %', got, want_a; END IF;

  DELETE FROM patients WHERE id IN (SELECT id FROM _victim_patients);
  GET DIAGNOSTICS got = ROW_COUNT;
  IF got <> want_p THEN RAISE EXCEPTION 'patients deleted % <> selected %', got, want_p; END IF;

  INSERT INTO _counts
  SELECT 'after',
         (SELECT count(*) FROM patients), (SELECT count(*) FROM appointments),
         (SELECT count(*) FROM appointment_events), (SELECT count(*) FROM patient_accounts);

  IF (SELECT patients FROM _counts WHERE phase = 'after') <> b.patients - want_p
     OR (SELECT appointments FROM _counts WHERE phase = 'after') <> b.appointments - want_a
     OR (SELECT events FROM _counts WHERE phase = 'after') <> b.events - want_e
     OR (SELECT accounts FROM _counts WHERE phase = 'after') <> b.accounts THEN
    RAISE EXCEPTION 'after counts do not equal before minus selected';
  END IF;
  IF EXISTS (SELECT 1 FROM patients p JOIN _victim_patients v USING (id)) THEN
    RAISE EXCEPTION 'a selected patient is still present';
  END IF;
END
$purge$;

\echo == whole table counts, after ==
SELECT patients, appointments, events, accounts FROM _counts WHERE phase = 'after';
COMMIT;
\echo APPLIED: committed in one transaction.
\else
ROLLBACK;
\echo DRY RUN: nothing was changed (read-only transaction). Re-run with --apply to delete.
\endif
