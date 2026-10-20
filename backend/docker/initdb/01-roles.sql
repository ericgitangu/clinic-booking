-- Local and CI only. Creates the runtime role before migration 0001 runs.
-- In prod, https://clinic.ericgitangu.com/decisions#neon creates clinic_app. This file is never run against Neon.
CREATE ROLE clinic_app LOGIN PASSWORD 'clinic_app_local' NOSUPERUSER NOCREATEDB NOCREATEROLE;
