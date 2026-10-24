flowchart LR
  START(( )) -->|"POST /appointments, 201"| B["booked"]
  B -->|"reschedule, 200, same id"| B
  B -->|"cancel with reason, 200"| C["cancelled
terminal; the slot is free again"]
  C -->|"cancel or reschedule:
refused with 409"| C
