// Package events maps stream rows to the wire shapes of event contract v1.
//
// Two sources share one ordered stream and one cursor (/decisions#polling-then-push, migration 0014):
//
//   - appointment_events: lifecycle events (booked, rescheduled, cancelled) and the staff
//     annotations (vetoed, unlocked, arrived, no_show). Viewer shape =
//     contracts/events/admin-event.v1.schema.json, the same minimised message the push service
//     carries; staff shape (owner, admin) = staff-event.v1.schema.json, which adds the appointment,
//     the patient's name, a cancellation reason and, for a staff change, who made it and why.
//   - staff_action_audit: staff actions that change no appointment (a reminder sent now, "running
//     late", invitations created, revoked and accepted). Viewer shape = admin-action.v1.schema.json
//     (what happened, the doctor and visit time for the two patient notifications, nothing that
//     names a person); staff shape = staff-action.v1.schema.json (who, why, the patient, the
//     invited address).
//
// Which shape a stream gets is decided once, from the role in the database, and a viewer's query
// never selects the personal columns at all (package store).
package events

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/cursor"
)

// Sources of a row.
const (
	SourceEvent  = "event"
	SourceAction = "action"
)

// Row is one stream row: an appointment_events row or a staff_action_audit row, with the joined
// columns the staff shapes need.
type Row struct {
	Txid uint64
	ID   int64
	// Source is SourceEvent or SourceAction; "" is read as SourceEvent.
	Source string
	// EventType is appointment_events.event_type, or staff_action_audit.action for an action row.
	EventType string

	DoctorID      string
	FromStartsAt  *time.Time
	ToStartsAt    *time.Time
	LocalDate     time.Time
	FromLocalDate *time.Time
	OccurredAt    time.Time

	// Action rows only: the visit a reminder or "running late" is about, and the delay.
	StartsAt     *time.Time
	DelayMinutes *int

	// Synthetic marks the release smoke's own patient: its events are not shown to staff.
	Synthetic bool

	// Staff-only columns; zero for a viewer's query.
	AppointmentID      string
	PatientName        string
	CancellationReason *string
	ActorEmail         *string
	ActorRole          *string
	Reason             *string
	InviteEmail        *string
	InviteRole         *string
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

// Staff is contracts/events/staff-event.v1.schema.json: Viewer plus the personal fields.
type Staff struct {
	Viewer
	AppointmentID      string  `json:"appointment_id"`
	PatientName        string  `json:"patient_name"`
	CancellationReason *string `json:"cancellation_reason"`
	ActorEmail         *string `json:"actor_email"`
	ActorRole          *string `json:"actor_role"`
	StaffReason        *string `json:"staff_reason"`
}

// ViewerAction is contracts/events/admin-action.v1.schema.json.
type ViewerAction struct {
	Kind         string  `json:"kind"`
	DoctorID     *string `json:"doctor_id"`
	StartsAt     *string `json:"starts_at"`
	DelayMinutes *int    `json:"delay_minutes"`
	Seq          string  `json:"seq"`
}

// StaffAction is contracts/events/staff-action.v1.schema.json: ViewerAction plus who, why, the
// patient and the invited address.
type StaffAction struct {
	ViewerAction
	AppointmentID *string `json:"appointment_id"`
	PatientName   *string `json:"patient_name"`
	ActorEmail    string  `json:"actor_email"`
	ActorRole     string  `json:"actor_role"`
	Reason        string  `json:"reason"`
	InviteEmail   *string `json:"invite_email"`
	InviteRole    *string `json:"invite_role"`
}

var known = map[string]bool{
	"booked": true, "rescheduled": true, "cancelled": true,
	"vetoed": true, "unlocked": true, "arrived": true, "no_show": true,
}

// actionKinds maps a staff_action_audit action to the SSE event name and the shape's kind.
var actionKinds = map[string]string{
	"reminder_now":  "reminder_now",
	"running_late":  "running_late",
	"invite_create": "invite_created",
	"invite_revoke": "invite_revoked",
	"invite_accept": "invite_accepted",
}

// StreamedActions are the staff_action_audit actions the stream carries on their own. The other
// actions (book, veto, attendance...) are carried by the lifecycle event of the same transaction.
func StreamedActions() []string {
	return []string{"reminder_now", "running_late", "invite_create", "invite_revoke", "invite_accept"}
}

// Known reports whether this version understands the appointment event type.
func Known(eventType string) bool { return known[eventType] }

// KnownAction reports whether this version streams the staff action.
func KnownAction(action string) bool { _, ok := actionKinds[action]; return ok }

// Encode returns the SSE event name and the JSON data for a row. staff selects the shape.
func Encode(r Row, staff bool) (name string, data []byte, err error) {
	if r.Source == SourceAction {
		return encodeAction(r, staff)
	}
	if r.Source != "" && r.Source != SourceEvent {
		return "", nil, fmt.Errorf("unknown source %q at %s", r.Source, r.Cursor())
	}
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
	// Who and why only when the audit row of the same transaction says so (a staff change).
	if r.ActorEmail != nil && r.ActorRole != nil {
		s.ActorEmail, s.ActorRole, s.StaffReason = r.ActorEmail, r.ActorRole, r.Reason
	}
	data, err = json.Marshal(s)
	return r.EventType, data, err
}

func encodeAction(r Row, staff bool) (string, []byte, error) {
	kind, ok := actionKinds[r.EventType]
	if !ok {
		return "", nil, fmt.Errorf("unknown staff action %q at %s", r.EventType, r.Cursor())
	}
	v := ViewerAction{Kind: kind, StartsAt: ts(r.StartsAt), DelayMinutes: r.DelayMinutes, Seq: r.Cursor().String()}
	if r.DoctorID != "" {
		d := r.DoctorID
		v.DoctorID = &d
	}
	if !staff {
		data, err := json.Marshal(v)
		return kind, data, err
	}
	if r.ActorEmail == nil || r.ActorRole == nil || r.Reason == nil {
		return "", nil, fmt.Errorf("staff action at %s has no actor or reason", r.Cursor())
	}
	s := StaffAction{
		ViewerAction: v, AppointmentID: nonEmpty(r.AppointmentID), PatientName: nonEmpty(r.PatientName),
		ActorEmail: *r.ActorEmail, ActorRole: *r.ActorRole, Reason: *r.Reason,
		InviteEmail: r.InviteEmail, InviteRole: r.InviteRole,
	}
	data, err := json.Marshal(s)
	return kind, data, err
}

func nonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
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
