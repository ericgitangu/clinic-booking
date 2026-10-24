sequenceDiagram

  participant A as Request A
  participant B as Request B
  participant S as clinic-api
  participant D as Postgres
  A->>S: POST /appointments (doctor, 09:00)
  B->>S: POST /appointments (doctor, 09:00)
  S->>D: validate, then INSERT for A
  S->>D: validate, then INSERT for B
  Note over D: uq_appt_doctor_slot_booked<br/>B waits on A's uncommitted key
  D-->>S: A commits
  S-->>A: 201 Created
  D-->>S: B fails, 23505 unique violation
  S-->>B: 409 SLOT_TAKEN (problem+json)
