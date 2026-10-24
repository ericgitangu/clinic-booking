erDiagram
  clinics ||--o{ doctors : employs
  doctors ||--o{ working_hours : works
  doctors ||--o{ appointments : "is booked in"
  patients ||--o{ appointments : holds
  appointments ||--o{ appointment_events : "events, outbox"
  appointments ||--o{ appointment_attendance : "staff mark"
  appointments ||--o| doctor_notification : "arrival email"
  appointments ||--o{ staff_action_audit : "staff audit"
  patients ||--o| patient_accounts : "Google account"
  clinics {
    uuid id PK
    text name
    text timezone "IANA zone"
  }
  doctors {
    uuid id PK
    uuid clinic_id FK
    text full_name
    boolean is_active
    text email "nullable, staff set"
  }
  working_hours {
    uuid doctor_id FK
    smallint weekday "ISO 1..7"
    time start_time ":00 or :30"
    time end_time ":00 or :30"
  }
  patients {
    uuid id PK
    text full_name
    text phone "unique"
    boolean synthetic
  }
  appointments {
    uuid id PK
    uuid doctor_id FK
    uuid patient_id FK
    timestamptz starts_at "30 min grid"
    timestamptz ends_at
    text status "booked, cancelled"
    text cancellation_reason
    text idempotency_key
  }
  appointment_events {
    bigint id PK
    uuid appointment_id FK
    text event_type
    date local_date
    xid8 txid "outbox cursor"
  }
  appointment_attendance {
    bigint id PK
    uuid appointment_id FK
    text kind "arrived, no_show"
    text marked_by
  }
  doctor_notification {
    uuid id PK
    uuid appointment_id FK
    text kind "patient_arrived"
    text status "pending..skipped"
    text reason
  }
  staff_action_audit {
    uuid id PK
    text actor_email
    text action "incl. doctor_email"
    uuid appointment_id FK
    text reason
  }
  patient_accounts {
    text google_sub PK
    uuid patient_id FK
  }
