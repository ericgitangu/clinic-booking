# Runbook: the demo seed

`python -m app.scripts.seed_demo [--today YYYY-MM-DD]` fills the clinic with invented patients and
four weeks of bookings so the admin dashboard can be reviewed. It is run by hand, once, after the
core seed (`python -m app.scripts.seed`), with the same `DATABASE_URL` the core seed uses. It is not
part of the release migrate job and never runs on a deploy.

## What it writes

- 100 patients with `demo = true`: about 40 hand-written people and 58 more built from the same
  community tables. Names are paired by community and gender (Kikuyu, Luo, Luhya, Kalenjin, Kamba,
  Kisii, Meru, Mijikenda, Somali, Maasai and Asian-Kenyan), across children, teens, adults and
  seniors. They are AI-generated and fictional; no real people.
- Emails end in `@example.com` (reserved for documentation), so no message can reach anyone. Phones
  are `+254700000001` to `+254700000100`, clearly fictional.
- Appointments for all five seeded doctors from 14 days before `--today` to 14 days after, inside
  working hours on the 30-minute grid. Utilisation is 45 to 75 percent per doctor, about 10 percent
  of appointments are cancelled with plain-language reasons, and about 9 percent of booked visits
  were moved (with their `rescheduled` event).
- Past visits are marked at the desk the way the app does it: an attendance row (mostly arrived, about 5 percent no-show), a staff audit row and an `arrived` / `no_show` event, all by the fictional label `reception@example.com` (not in `staff_access`, so it opens nothing). A patient's own events carry `actor = 'patient'`.
- `appointment_events` (booked, rescheduled, cancelled) with backdated `occurred_at`, all at least an
  hour old, so the realtime relay (which ignores events older than ten minutes) pushes nothing.

The schema has no locality column and none was added. The Nairobi areas (Westlands, Kilimani,
Kileleshwa, South B, South C, Embakasi, Kasarani, Ruaka, Karen, Eastleigh, Rongai, Kitengela, Thika
Road) only decide which cancellation reasons suit a person.

## Idempotent

Ids are `uuid5` of stable keys and every choice is a hash of them, so a second run with the same
`--today` inserts nothing. Without `--today` the date is the current Nairobi date (yesterday before
07:00 there). A later date adds the new days; it never changes or deletes a row. A slot already held
by a real booking is skipped, never displaced.

## Demo is not synthetic

`patients.demo` marks these people as invented; they appear in every admin view. `patients.synthetic`
is the release smoke's flag and is left out of every admin view. They are separate on purpose.

## Run

```bash
cd backend
DATABASE_URL=... uv run python -m app.scripts.seed        # core data, already in production
DATABASE_URL=... uv run python -m app.scripts.seed_demo   # prints the counts it inserted
```

To take them away again (nothing does this automatically):
`DELETE FROM appointment_events WHERE appointment_id IN (SELECT a.id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE p.demo)`, then the same for `appointments` and `patients`, as the owner role in one transaction.
