-- Re-apply the gateway role's privileges (docs/runbooks/neon.md). Same statements as migration
-- 0014_realtime_reader_role; a test keeps the two identical. Run as the database owner.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM clinic_realtime;
GRANT USAGE ON SCHEMA public TO clinic_realtime;
GRANT SELECT (id, txid, appointment_id, doctor_id, event_type, from_starts_at, to_starts_at,
              local_date, from_local_date, occurred_at)
  ON appointment_events TO clinic_realtime;
GRANT SELECT (id, patient_id, status, cancellation_reason) ON appointments TO clinic_realtime;
GRANT SELECT (id, full_name, synthetic) ON patients TO clinic_realtime;
GRANT SELECT (email, role, revoked_at) ON staff_access TO clinic_realtime;
ALTER ROLE clinic_realtime SET idle_in_transaction_session_timeout = '30s';
