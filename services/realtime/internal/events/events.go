// Package events maps appointment_events rows to the two wire shapes of event contract v1.
//
// Viewer shape = contracts/events/admin-event.v1.schema.json, the same minimised message the
// push service carries: event type, doctor, dates, times and the cursor, and nothing that names a
// person or an appointment. Staff shape (owner and admin) = contracts/events/staff-event.v1.schema.json:
// the viewer fields plus the appointment id (for the deep link), the patient's name and, for a
// cancellation, the reason. Which shape a stream gets is decided once, from the role in the
// database, and a viewer's query never selects the personal columns at all.
package events

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/cursor"
)

// Row is one appointment_events row with the joined columns the staff shape needs.
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

	// Synthetic marks the release smoke's own patient: its events are not shown to staff.
	Synthetic bool

	// Staff-only columns; zero for a viewer's query.
	AppointmentID      string
	PatientName        string
	CancellationReason *string
}

// Cursor is the row's position, used as the SSE id and the viewer-visible seq.
func (r Row) Cursor() cursor.Cursor { return cursor.Cursor{Txid: r.Txid, ID: r.ID} }

// Viewer is contracts/events/admin-event.v1.schema.json.
type Viewer struct {
	EventType     string  `json:"event_type"`
	DoctorID      string  `json:"doctor_id"`
	LocalDate     string  `json:"local_date"`
	FromLocalDate *string `json:"from_local_date"`
	FromStartsAt  *string `json:"from_starts_at"`
	ToStartsAt    *string `json:"to_starts_at"`
	Seq           string  `json:"seq"`
}

// Staff is contracts/events/staff-event.v1.schema.json: Viewer plus three fields.
type Staff struct {
	Viewer
	AppointmentID      string  `json:"appointment_id"`
	PatientName        string  `json:"patient_name"`
	CancellationReason *string `json:"cancellation_reason"`
}

var known = map[string]bool{"booked": true, "rescheduled": true, "cancelled": true}

// Known reports whether this version understands the event type.
func Known(eventType string) bool { return known[eventType] }

// Encode returns the SSE event name and the JSON data for a row. staff selects the shape.
func Encode(r Row, staff bool) (name string, data []byte, err error) {
	if !Known(r.EventType) {
		return "", nil, fmt.Errorf("unknown event_type %q at %s", r.EventType, r.Cursor())
	}
	v := Viewer{
		EventType:     r.EventType,
		DoctorID:      r.DoctorID,
		LocalDate:     r.LocalDate.Format(time.DateOnly),
		FromLocalDate: date(r.FromLocalDate),
		FromStartsAt:  ts(r.FromStartsAt),
		ToStartsAt:    ts(r.ToStartsAt),
		Seq:           r.Cursor().String(),
	}
	if !staff {
		data, err = json.Marshal(v)
		return r.EventType, data, err
	}
	s := Staff{Viewer: v, AppointmentID: r.AppointmentID, PatientName: r.PatientName}
	if r.EventType == "cancelled" {
		s.CancellationReason = r.CancellationReason
	}
	data, err = json.Marshal(s)
	return r.EventType, data, err
}

// ts renders a UTC instant the way the API does (microseconds, Z).
func ts(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format("2006-01-02T15:04:05.000000Z")
	return &s
}

func date(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.Format(time.DateOnly)
	return &s
}
