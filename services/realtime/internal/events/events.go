// Package events maps appointment_events rows to the versioned wire payload. The payload is
// aggregate and non-PII by construction: it has no field for an appointment id, a patient or a
// reason, and the database role cannot read them either (docs/adr/0009, docs/adr/0015).
package events

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/cursor"
)

// SchemaVersion is the payload version. A breaking change is version 2 under a new event name.
const SchemaVersion = 1

// Row is one appointment_events row, limited to the columns clinic_realtime may read.
type Row struct {
	Txid          uint64
	ID            int64
	DoctorID      string
	EventType     string
	FromStartsAt  *time.Time
	ToStartsAt    *time.Time
	LocalDate     time.Time
	FromLocalDate *time.Time
	OccurredAt    time.Time
}

// Cursor is the row's position, used as the SSE id.
func (r Row) Cursor() cursor.Cursor { return cursor.Cursor{Txid: r.Txid, ID: r.ID} }

// Payload is contracts/events/appointment-event.v1.schema.json.
type Payload struct {
	SchemaVersion int     `json:"schema_version"`
	Type          string  `json:"type"`
	DoctorID      string  `json:"doctor_id"`
	FromStartsAt  *string `json:"from_starts_at"`
	ToStartsAt    *string `json:"to_starts_at"`
	LocalDate     string  `json:"local_date"`
	FromLocalDate *string `json:"from_local_date"`
	OccurredAt    string  `json:"occurred_at"`
}

var names = map[string]string{
	"booked":      "appointment.booked",
	"cancelled":   "appointment.cancelled",
	"rescheduled": "appointment.rescheduled",
}

// Encode returns the SSE event name and the JSON data line for a row. An event type the
// database CHECK allows but this version does not know is an error, never a silent skip, so a
// new type cannot be dropped from the feed unnoticed.
func Encode(r Row) (name string, data []byte, err error) {
	name, ok := names[r.EventType]
	if !ok {
		return "", nil, fmt.Errorf("unknown event_type %q at %s", r.EventType, r.Cursor())
	}
	p := Payload{
		SchemaVersion: SchemaVersion,
		Type:          name,
		DoctorID:      r.DoctorID,
		FromStartsAt:  ts(r.FromStartsAt),
		ToStartsAt:    ts(r.ToStartsAt),
		LocalDate:     r.LocalDate.Format(time.DateOnly),
		FromLocalDate: date(r.FromLocalDate),
		OccurredAt:    r.OccurredAt.UTC().Format(time.RFC3339Nano),
	}
	data, err = json.Marshal(p)
	return name, data, err
}

func ts(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format(time.RFC3339Nano)
	return &s
}

func date(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.Format(time.DateOnly)
	return &s
}
