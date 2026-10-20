"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-10-16

DDL is hand-written and expand-only. Partial indexes, CHECKs and grants go
through raw SQL; autogenerate is not used.
"""

from __future__ import annotations

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
            RAISE EXCEPTION 'role clinic_app missing: see https://clinic.ericgitangu.com/architecture#neon';
          END IF;
        END $$;
    """)

    op.execute("""
        CREATE TABLE clinics (
          id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
          timezone    text NOT NULL,
          created_at  timestamptz NOT NULL DEFAULT now()
        );
    """)

    op.execute("""
        CREATE TABLE doctors (
          id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          clinic_id   uuid NOT NULL REFERENCES clinics(id),
          full_name   text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 120),
          specialty   text NOT NULL,
          is_active   boolean NOT NULL DEFAULT true,
          created_at  timestamptz NOT NULL DEFAULT now()
        );
    """)
    op.execute("CREATE INDEX ix_doctors_clinic_active ON doctors (clinic_id) WHERE is_active;")

    op.execute("""
        CREATE TABLE working_hours (
          id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          doctor_id   uuid NOT NULL REFERENCES doctors(id),
          weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
          start_time  time NOT NULL,
          end_time    time NOT NULL,
          CONSTRAINT ck_wh_order CHECK (start_time < end_time),
          CONSTRAINT ck_wh_align CHECK (
                extract(minute FROM start_time) IN (0,30) AND extract(second FROM start_time) = 0
            AND extract(minute FROM end_time)   IN (0,30) AND extract(second FROM end_time)   = 0),
          CONSTRAINT uq_wh_doctor_day_start UNIQUE (doctor_id, weekday, start_time)
        );
    """)

    op.execute(r"""
        CREATE TABLE patients (
          id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          full_name   text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 200),
          phone       text NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
          email       text NULL,
          created_at  timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT uq_patients_phone UNIQUE (phone)
        );
    """)

    op.execute("""
        CREATE TABLE appointments (
          id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          doctor_id            uuid NOT NULL REFERENCES doctors(id),
          patient_id           uuid NOT NULL REFERENCES patients(id),
          starts_at            timestamptz NOT NULL,
          ends_at              timestamptz NOT NULL,
          status               text NOT NULL DEFAULT 'booked',
          cancellation_reason  text NULL,
          cancelled_at         timestamptz NULL,
          created_at           timestamptz NOT NULL DEFAULT now(),
          updated_at           timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT ck_appt_status    CHECK (status IN ('booked','cancelled')),
          CONSTRAINT ck_appt_duration  CHECK (ends_at = starts_at + interval '30 minutes'),
          CONSTRAINT ck_appt_alignment CHECK ((extract(epoch FROM starts_at))::numeric % 1800 = 0),
          CONSTRAINT ck_appt_cancel_consistency CHECK (
               (status = 'booked'    AND cancelled_at IS NULL     AND cancellation_reason IS NULL)
            OR (status = 'cancelled' AND cancelled_at IS NOT NULL
                AND length(btrim(cancellation_reason)) BETWEEN 3 AND 500))
        );
    """)
    op.execute(
        "CREATE UNIQUE INDEX uq_appt_doctor_slot_booked "
        "ON appointments (doctor_id, starts_at) WHERE status = 'booked';"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_appt_patient_slot_booked "
        "ON appointments (patient_id, starts_at) WHERE status = 'booked';"
    )

    op.execute("""
        CREATE TABLE appointment_events (
          id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          appointment_id  uuid NOT NULL REFERENCES appointments(id),
          doctor_id       uuid NOT NULL REFERENCES doctors(id),
          event_type      text NOT NULL CHECK (event_type IN ('booked','cancelled','rescheduled')),
          from_starts_at  timestamptz NULL,
          to_starts_at    timestamptz NULL,
          local_date      date NOT NULL,
          from_local_date date NULL,
          occurred_at     timestamptz NOT NULL DEFAULT now()
        );
    """)
    op.execute("CREATE INDEX ix_events_doctor_id ON appointment_events (doctor_id, id);")

    op.execute("GRANT USAGE ON SCHEMA public TO clinic_app;")
    op.execute("GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO clinic_app;")
    op.execute("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO clinic_app;")
    op.execute(
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public "
        "GRANT SELECT, INSERT, UPDATE ON TABLES TO clinic_app;"
    )
    op.execute(
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO clinic_app;"
    )
    # The blanket grant above also covered alembic_version; the runtime role must not be able
    # to rewrite the migration head.
    op.execute("""
        DO $$ BEGIN
          IF to_regclass('public.alembic_version') IS NOT NULL THEN
            REVOKE INSERT, UPDATE ON public.alembic_version FROM clinic_app;
          END IF;
        END $$;
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS appointment_events;")
    op.execute("DROP TABLE IF EXISTS appointments;")
    op.execute("DROP TABLE IF EXISTS patients;")
    op.execute("DROP TABLE IF EXISTS working_hours;")
    op.execute("DROP TABLE IF EXISTS doctors;")
    op.execute("DROP TABLE IF EXISTS clinics;")
