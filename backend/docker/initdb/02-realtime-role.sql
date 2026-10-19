-- Local and CI only. Creates the gateway's read-only login; migration 0014 grants its privileges.
-- In prod, docs/runbooks/neon.md creates clinic_realtime. This file is never run against Neon.
CREATE ROLE clinic_realtime LOGIN PASSWORD 'clinic_realtime_local' NOSUPERUSER NOCREATEDB NOCREATEROLE;
