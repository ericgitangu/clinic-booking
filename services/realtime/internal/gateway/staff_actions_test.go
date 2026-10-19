package gateway_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/config"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/testenv"
)

// Staff actions on the live feed. Owners and admins get who did it and why; viewers get the same
// event with no person, no reason and no address. Wherever the API can be driven deterministically
// the action goes through the real staff routes (veto, unlock, staff book and cancel, reminder,
// invitations). Attendance and "running late" only exist inside a time window around a visit
// today, which a test run cannot rely on, so those rows are written as the database owner exactly
// as the API writes them (one transaction: the event and its audit row).

var apiAdmin = testenv.Staffer{Email: "api-admin@gateway-tests.org", Role: "admin"}

// untilWithin bounds each wait for an event: the gateway polls every 100 ms in these tests.
const untilWithin = 5 * time.Second

// twoStreams allows an owner stream and a viewer stream side by side.
func twoStreams(c *config.Config) { c.MaxStreamsPerInstance = 2 }

// until reads frames until one named kind satisfies match, failing after untilWithin.
func (s *sse) until(t *testing.T, kind string, match func(map[string]any) bool) (frame, map[string]any) {
	t.Helper()
	deadline := time.Now().Add(untilWithin)
	for {
		f, ok := s.nextEvent(t, time.Until(deadline))
		if !ok {
			t.Fatalf("stream ended while waiting for %s", kind)
		}
		if f.Event != kind {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(f.Data), &m); err != nil {
			t.Fatalf("%s data is not JSON: %v", kind, err)
		}
		if match == nil || match(m) {
			return f, m
		}
	}
}

func forAppointment(id string) func(map[string]any) bool {
	return func(m map[string]any) bool { return m["appointment_id"] == id }
}

// noneOf fails if the frame's data contains any of the values.
func noneOf(t *testing.T, f frame, values ...string) {
	t.Helper()
	for _, v := range values {
		if v != "" && strings.Contains(f.Data, v) {
			t.Fatalf("viewer %s frame contains %q: %s", f.Event, v, f.Data)
		}
	}
}

func str(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

// A staff veto of a patient's reschedule: the owner sees the move back and the veto, each with
// the admin who did it and the reason; a viewer watching that one appointment sees both events
// in the minimised shape.
func TestVetoAndUnlockCarryWhoAndWhyForStaffOnly(t *testing.T) {
	h := start(t, twoStreams)
	staffSchema := compile(t, "staff-event.v1.schema.json")
	viewerSchema := compile(t, "admin-event.v1.schema.json")
	api := h.env.NewAPI(t)
	testenv.GrantStaff(t, h.env, apiAdmin.Email, "admin")
	booking := api.Book(api.Doctor())
	api.Reschedule(booking, false)

	owner := h.hello(asOwner, q())
	viewer := h.hello(asView, q("appointment", booking.ID))

	const vetoReason = "Doctor asked to keep the original time"
	api.Staff(apiAdmin, http.MethodPost, "/internal/admin/appointments/"+booking.ID+"/veto",
		map[string]any{"reason": vetoReason}, http.StatusOK, nil)

	f, m := owner.until(t, "vetoed", forAppointment(booking.ID))
	valid(t, staffSchema, f.Data)
	if str(m, "actor_email") != apiAdmin.Email || str(m, "actor_role") != "admin" ||
		str(m, "staff_reason") != vetoReason || str(m, "patient_name") != booking.PatientName {
		t.Fatalf("vetoed staff shape = %s", f.Data)
	}
	vf, _ := viewer.until(t, "vetoed", nil)
	valid(t, viewerSchema, vf.Data)
	noneOf(t, vf, booking.PatientName, booking.ID, apiAdmin.Email, vetoReason)

	const unlockReason = "Patient may move it again"
	api.Staff(apiAdmin, http.MethodPost, "/internal/admin/appointments/"+booking.ID+"/unlock",
		map[string]any{"reason": unlockReason}, http.StatusOK, nil)
	f, m = owner.until(t, "unlocked", forAppointment(booking.ID))
	valid(t, staffSchema, f.Data)
	if str(m, "actor_email") != apiAdmin.Email || str(m, "staff_reason") != unlockReason {
		t.Fatalf("unlocked staff shape = %s", f.Data)
	}
	vf, _ = viewer.until(t, "unlocked", nil)
	valid(t, viewerSchema, vf.Data)
	noneOf(t, vf, booking.PatientName, apiAdmin.Email, unlockReason)
}

// A booking and a cancellation made by staff name the staff member; a patient's own change does
// not (actor fields are null).
func TestStaffBookAndCancelNameTheActor(t *testing.T) {
	h := start(t, nil)
	schema := compile(t, "staff-event.v1.schema.json")
	api := h.env.NewAPI(t)
	testenv.GrantStaff(t, h.env, apiAdmin.Email, "admin")
	doctor := api.Doctor()
	patient, name := api.Patient()
	slot := api.FreeSlot(doctor)

	owner := h.hello(asOwner, q())
	var made struct {
		ID string `json:"id"`
	}
	api.Staff(apiAdmin, http.MethodPost, "/internal/admin/appointments", map[string]any{
		"doctor_id": doctor, "patient_id": patient, "starts_at": slot.Format(time.RFC3339),
		"reason": "Booked at the desk",
	}, http.StatusCreated, &made)
	f, m := owner.until(t, "booked", forAppointment(made.ID))
	valid(t, schema, f.Data)
	if str(m, "actor_email") != apiAdmin.Email || str(m, "staff_reason") != "Booked at the desk" ||
		str(m, "patient_name") != name {
		t.Fatalf("staff booking = %s", f.Data)
	}

	api.Staff(apiAdmin, http.MethodPatch, "/internal/admin/appointments/"+made.ID+"/cancel",
		map[string]any{"reason": "Patient called to cancel"}, http.StatusOK, nil)
	f, m = owner.until(t, "cancelled", forAppointment(made.ID))
	valid(t, schema, f.Data)
	if str(m, "actor_email") != apiAdmin.Email || str(m, "staff_reason") != "Patient called to cancel" ||
		str(m, "cancellation_reason") == "" {
		t.Fatalf("staff cancel = %s", f.Data)
	}

	// The patient's own booking carries no actor.
	b := api.Book(doctor)
	_, m = owner.until(t, "booked", forAppointment(b.ID))
	if m["actor_email"] != nil || m["actor_role"] != nil || m["staff_reason"] != nil {
		t.Fatalf("a patient's booking names an actor: %v", m)
	}
}

// A booking, a reschedule and a cancellation made by staff through the real API reach a viewer as
// the same events (matched by seq against the owner's stream) with no patient name, no staff
// address and no reason anywhere in the frame.
func TestStaffBookRescheduleCancelReachViewersWithoutPeople(t *testing.T) {
	h := start(t, twoStreams)
	viewerSchema := compile(t, "admin-event.v1.schema.json")
	api := h.env.NewAPI(t)
	testenv.GrantStaff(t, h.env, apiAdmin.Email, "admin")
	doctor := api.Doctor()
	patient, name := api.Patient()
	slot := api.FreeSlot(doctor)

	owner := h.hello(asOwner, q())
	viewer := h.hello(asView, q())
	sameSeq := func(seq string) func(map[string]any) bool {
		return func(m map[string]any) bool { return m["seq"] == seq }
	}
	check := func(kind, id, reason string) {
		t.Helper()
		_, om := owner.until(t, kind, forAppointment(id))
		if str(om, "actor_email") != apiAdmin.Email || str(om, "staff_reason") != reason {
			t.Fatalf("owner %s = %v", kind, om)
		}
		vf, _ := viewer.until(t, kind, sameSeq(str(om, "seq")))
		valid(t, viewerSchema, vf.Data)
		noneOf(t, vf, name, apiAdmin.Email, reason, id)
	}

	var made struct {
		ID string `json:"id"`
	}
	const bookReason = "Booked by phone at the desk"
	api.Staff(apiAdmin, http.MethodPost, "/internal/admin/appointments", map[string]any{
		"doctor_id": doctor, "patient_id": patient, "starts_at": slot.Format(time.RFC3339),
		"reason": bookReason,
	}, http.StatusCreated, &made)
	check("booked", made.ID, bookReason)

	to := api.FreeSlot(doctor)
	const moveReason = "Patient asked for a later day"
	api.Staff(apiAdmin, http.MethodPatch, "/internal/admin/appointments/"+made.ID+"/reschedule",
		map[string]any{"starts_at": to.Format(time.RFC3339), "reason": moveReason}, http.StatusOK, nil)
	check("rescheduled", made.ID, moveReason)

	const cancelReason = "Patient is travelling that week"
	api.Staff(apiAdmin, http.MethodPatch, "/internal/admin/appointments/"+made.ID+"/cancel",
		map[string]any{"reason": cancelReason}, http.StatusOK, nil)
	check("cancelled", made.ID, cancelReason)
}

// Attendance marks, written as the API writes them: the event and its audit row in one
// transaction (the API refuses a mark outside the window around today's visit).
func TestAttendanceMarksStreamWithTheProjection(t *testing.T) {
	h := start(t, twoStreams)
	staffSchema := compile(t, "staff-event.v1.schema.json")
	viewerSchema := compile(t, "admin-event.v1.schema.json")
	api := h.env.NewAPI(t)
	booking := api.Book(api.Doctor())

	owner := h.hello(asOwner, q())
	viewer := h.hello(asView, q("appointment", booking.ID))

	for _, c := range []struct{ kind, reason string }{
		{"arrived", "Marked arrived at the desk"},
		{"no_show", "Corrected: the patient left before the visit"},
	} {
		testenv.Exec(t, h.env, `
			WITH a AS (SELECT id, doctor_id, starts_at FROM appointments WHERE id = $1::uuid),
			     e AS (INSERT INTO appointment_events
			             (appointment_id, doctor_id, event_type, to_starts_at, local_date, actor)
			           SELECT id, doctor_id, $2, starts_at, (starts_at AT TIME ZONE 'Africa/Nairobi')::date, 'staff'
			           FROM a RETURNING 1)
			INSERT INTO staff_action_audit (actor_email, actor_role, action, appointment_id, reason, after)
			SELECT $3, 'admin', $2, id, $4, jsonb_build_object('attendance', $2::text) FROM a`,
			booking.ID, c.kind, apiAdmin.Email, c.reason)

		f, m := owner.until(t, c.kind, forAppointment(booking.ID))
		valid(t, staffSchema, f.Data)
		if str(m, "actor_email") != apiAdmin.Email || str(m, "staff_reason") != c.reason {
			t.Fatalf("%s staff shape = %s", c.kind, f.Data)
		}
		vf, _ := viewer.until(t, c.kind, nil)
		valid(t, viewerSchema, vf.Data)
		noneOf(t, vf, booking.PatientName, booking.ID, apiAdmin.Email, c.reason)
	}
}

// A reminder sent now (through the API) and "running late" (one audit row per patient, written
// as the API writes it): staff see the patient and the reason, a viewer the doctor and the time.
func TestReminderAndRunningLateStreamFromTheAuditTrail(t *testing.T) {
	h := start(t, twoStreams)
	staffSchema := compile(t, "staff-action.v1.schema.json")
	viewerSchema := compile(t, "admin-action.v1.schema.json")
	api := h.env.NewAPI(t)
	testenv.GrantStaff(t, h.env, apiAdmin.Email, "admin")
	booking := api.Book(api.Doctor())
	wantStart := booking.StartsAt.UTC().Format("2006-01-02T15:04:05.000000Z")

	owner := h.hello(asOwner, q())
	viewer := h.hello(asView, q("appointment", booking.ID))

	api.Staff(apiAdmin, http.MethodPost, "/internal/admin/appointments/"+booking.ID+"/remind",
		map[string]any{"reason": "Patient asked for the details again"}, http.StatusOK, nil)
	f, m := owner.until(t, "reminder_now", forAppointment(booking.ID))
	valid(t, staffSchema, f.Data)
	if str(m, "patient_name") != booking.PatientName || str(m, "actor_email") != apiAdmin.Email ||
		str(m, "reason") != "Patient asked for the details again" || str(m, "starts_at") != wantStart ||
		str(m, "doctor_id") != booking.DoctorID {
		t.Fatalf("reminder staff shape = %s", f.Data)
	}
	vf, vm := viewer.until(t, "reminder_now", nil)
	valid(t, viewerSchema, vf.Data)
	noneOf(t, vf, booking.PatientName, booking.ID, apiAdmin.Email, "details again")
	if str(vm, "doctor_id") != booking.DoctorID || str(vm, "starts_at") != wantStart {
		t.Fatalf("reminder viewer shape = %s", vf.Data)
	}

	testenv.Exec(t, h.env, `
		INSERT INTO staff_action_audit (actor_email, actor_role, action, appointment_id, reason, after)
		VALUES ($1, 'admin', 'running_late', $2::uuid, 'Doctor running about 25 minutes late',
		        '{"outcome": "demo, not sent", "delay_minutes": 25}'::jsonb)`,
		apiAdmin.Email, booking.ID)
	f, m = owner.until(t, "running_late", forAppointment(booking.ID))
	valid(t, staffSchema, f.Data)
	if m["delay_minutes"] != float64(25) || str(m, "patient_name") != booking.PatientName {
		t.Fatalf("running_late staff shape = %s", f.Data)
	}
	vf, vm = viewer.until(t, "running_late", nil)
	valid(t, viewerSchema, vf.Data)
	noneOf(t, vf, booking.PatientName, apiAdmin.Email, "25 minutes late")
	if vm["delay_minutes"] != float64(25) {
		t.Fatalf("running_late viewer shape = %s", vf.Data)
	}
}

// Invitations created, revoked and accepted through the API: the owner sees the invited address
// and role; a viewer sees that it happened and nothing else.
func TestInvitationsStreamTheAddressToStaffOnly(t *testing.T) {
	h := start(t, twoStreams)
	staffSchema := compile(t, "staff-action.v1.schema.json")
	viewerSchema := compile(t, "admin-action.v1.schema.json")
	api := h.env.NewAPI(t)
	testenv.GrantStaff(t, h.env, apiAdmin.Email, "admin")
	invitee := fmt.Sprintf("invitee-%d@gateway-tests.org", time.Now().UnixNano())
	t.Cleanup(func() {
		testenv.Exec(t, h.env, `UPDATE staff_access SET revoked_at = now() WHERE email = $1`, invitee)
	})

	owner := h.hello(asOwner, q())
	viewer := h.hello(asView, q())
	forInvitee := func(m map[string]any) bool { return m["invite_email"] == invitee }

	var first struct {
		ID string `json:"id"`
	}
	api.Staff(apiAdmin, http.MethodPost, "/internal/admin/invites",
		map[string]any{"email": invitee, "role": "viewer"}, http.StatusCreated, &first)
	f, m := owner.until(t, "invite_created", forInvitee)
	valid(t, staffSchema, f.Data)
	if str(m, "invite_role") != "viewer" || str(m, "actor_email") != apiAdmin.Email || m["appointment_id"] != nil {
		t.Fatalf("invite_created staff shape = %s", f.Data)
	}
	vf, _ := viewer.until(t, "invite_created", nil)
	valid(t, viewerSchema, vf.Data)
	noneOf(t, vf, invitee, apiAdmin.Email)

	api.Staff(apiAdmin, http.MethodDelete, "/internal/admin/invites/"+first.ID, nil, http.StatusOK, nil)
	f, _ = owner.until(t, "invite_revoked", forInvitee)
	valid(t, staffSchema, f.Data)
	vf, _ = viewer.until(t, "invite_revoked", nil)
	valid(t, viewerSchema, vf.Data)
	noneOf(t, vf, invitee, apiAdmin.Email)

	var second struct {
		Token string `json:"token"`
	}
	api.Staff(apiAdmin, http.MethodPost, "/internal/admin/invites",
		map[string]any{"email": invitee, "role": "viewer"}, http.StatusCreated, &second)
	owner.until(t, "invite_created", forInvitee)
	api.Staff(testenv.Staffer{Email: invitee, Role: "viewer"}, http.MethodPost, "/internal/admin/invites/accept",
		map[string]any{"token": second.Token}, http.StatusOK, nil)
	f, m = owner.until(t, "invite_accepted", forInvitee)
	valid(t, staffSchema, f.Data)
	if str(m, "actor_email") != invitee || str(m, "actor_role") != "viewer" {
		t.Fatalf("invite_accepted staff shape = %s", f.Data)
	}
	vf, _ = viewer.until(t, "invite_accepted", nil)
	valid(t, viewerSchema, vf.Data)
	noneOf(t, vf, invitee, apiAdmin.Email)
}

// The appointment filter: only that appointment's events, a strict UUID, and the same assertion
// (the signed path includes the filter, so it cannot be swapped on the way).
func TestAppointmentFilterIsStrictAndSigned(t *testing.T) {
	h := start(t, nil)
	api := h.env.NewAPI(t)
	doctor := api.Doctor()
	mine := api.Book(doctor)

	h.grant(asView)
	for _, w := range []who{asOwner, asView} {
		for _, bad := range []string{"not-a-uuid", strings.ToUpper(mine.ID), mine.ID + "0", "",
			"{" + mine.ID + "}", strings.ReplaceAll(mine.ID, "-", "")} {
			target := "/stream?appointment=" + url.QueryEscape(bad)
			s := h.openRaw(target, header(w, target, nil))
			if s.resp.StatusCode != http.StatusUnprocessableEntity {
				t.Fatalf("%s appointment=%q: status %d, want 422", w.role, bad, s.resp.StatusCode)
			}
			s.close()
		}
	}
	// Two filters in one request are refused too, not resolved to either.
	two := "/stream?appointment=" + mine.ID + "&appointment=" + mine.ID
	if s := h.openRaw(two, header(asView, two, nil)); s.resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("two filters: status %d, want 422", s.resp.StatusCode)
	}
	// Signed for one appointment, sent for another: refused before anything is read.
	signed := "/stream?appointment=" + mine.ID
	other := "/stream?appointment=00000000-0000-4000-8000-000000000000"
	s := h.openRaw(other, header(asOwner, signed, nil))
	if s.resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("swapped filter: status %d, want 401", s.resp.StatusCode)
	}
	s.close()

	st := h.hello(asOwner, q("appointment", mine.ID))
	elsewhere := api.Book(doctor)
	api.Cancel(mine, "Filter test")
	deadline := time.Now().Add(5 * time.Second)
	for {
		f, ok := st.nextEvent(t, time.Until(deadline))
		if !ok {
			t.Fatal("stream ended before the cancellation")
		}
		if strings.Contains(f.Data, elsewhere.ID) {
			t.Fatalf("filtered stream delivered another appointment: %s", f.Data)
		}
		if f.Event == "cancelled" {
			if !strings.Contains(f.Data, mine.ID) {
				t.Fatalf("cancellation of another appointment: %s", f.Data)
			}
			return
		}
	}
}
