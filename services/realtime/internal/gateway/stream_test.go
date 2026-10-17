package gateway_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/config"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/cursor"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/events"
)

func compileSchema(t *testing.T) *jsonschema.Schema {
	t.Helper()
	raw, err := os.ReadFile("../../testdata/appointment-event.v1.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	c := jsonschema.NewCompiler()
	c.AssertFormat()
	if err := c.AddResource("schema.json", doc); err != nil {
		t.Fatal(err)
	}
	s, err := c.Compile("schema.json")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// validate checks a data line against the v1 schema and that no identifying key is present.
func validate(t *testing.T, s *jsonschema.Schema, data string) events.Payload {
	t.Helper()
	var generic any
	if err := json.Unmarshal([]byte(data), &generic); err != nil {
		t.Fatalf("data is not JSON: %v: %s", err, data)
	}
	if err := s.Validate(generic); err != nil {
		t.Fatalf("event violates the v1 schema: %v\n%s", err, data)
	}
	for _, banned := range []string{"appointment_id", "patient", "name", "phone", "email", "reason", "txid"} {
		if strings.Contains(data, banned) {
			t.Fatalf("event leaks %q: %s", banned, data)
		}
	}
	var p events.Payload
	if err := json.Unmarshal([]byte(data), &p); err != nil {
		t.Fatal(err)
	}
	return p
}

// A booking, a reschedule and a cancellation made through the real API all arrive on a stream
// opened beforehand, in order, with payloads that match the schema.
func TestStreamReceivesEventsFromRealBookings(t *testing.T) {
	h := start(t, nil)
	schema := compileSchema(t)
	api := h.env.NewAPI(t)
	doctor := api.Doctor()

	s := h.open(q(), nil)
	hello, ok := s.nextEvent(t, 5*time.Second)
	if !ok || hello.Event != "hello" {
		t.Fatalf("first frame = %+v", hello)
	}
	if _, err := cursor.Parse(hello.ID); err != nil {
		t.Fatalf("hello id %q is not a cursor: %v", hello.ID, err)
	}

	booking := api.Book(doctor)
	ev, ok := s.nextEvent(t, 5*time.Second)
	if !ok || ev.Event != "appointment.booked" {
		t.Fatalf("want appointment.booked, got %+v", ev)
	}
	p := validate(t, schema, ev.Data)
	if p.DoctorID != doctor || p.ToStartsAt == nil || *p.ToStartsAt != booking.StartsAt.UTC().Format(time.RFC3339Nano) {
		t.Fatalf("booked payload does not describe the booking: %+v (slot %v)", p, booking.StartsAt)
	}
	if p.FromStartsAt != nil || p.FromLocalDate != nil {
		t.Fatalf("booked event carries from_* fields: %+v", p)
	}
	bookedID, _ := cursor.Parse(ev.ID)

	// Same-day reschedule: from_local_date stays null (set only when the local day changes).
	same := api.Reschedule(booking, false)
	ev, ok = s.nextEvent(t, 5*time.Second)
	if !ok || ev.Event != "appointment.rescheduled" {
		t.Fatalf("want appointment.rescheduled, got %+v", ev)
	}
	p = validate(t, schema, ev.Data)
	if p.FromStartsAt == nil || *p.FromStartsAt != booking.StartsAt.UTC().Format(time.RFC3339Nano) ||
		p.ToStartsAt == nil || *p.ToStartsAt != same.UTC().Format(time.RFC3339Nano) || p.FromLocalDate != nil {
		t.Fatalf("same-day rescheduled payload wrong: %+v", p)
	}
	reschedID, _ := cursor.Parse(ev.ID)
	if !bookedID.Less(reschedID) {
		t.Fatalf("ids out of order: %v then %v", bookedID, reschedID)
	}

	// Cross-day reschedule: from_local_date carries the day it left, so a dashboard can update both.
	booking.StartsAt = same
	cross := api.Reschedule(booking, true)
	ev, ok = s.nextEvent(t, 5*time.Second)
	if !ok || ev.Event != "appointment.rescheduled" {
		t.Fatalf("want appointment.rescheduled, got %+v", ev)
	}
	p = validate(t, schema, ev.Data)
	if p.FromLocalDate == nil || *p.FromLocalDate != same.UTC().Format(time.DateOnly) ||
		p.LocalDate != cross.UTC().Format(time.DateOnly) {
		t.Fatalf("cross-day rescheduled payload wrong: %+v", p)
	}

	api.Cancel(booking)
	ev, ok = s.nextEvent(t, 5*time.Second)
	if !ok || ev.Event != "appointment.cancelled" {
		t.Fatalf("want appointment.cancelled, got %+v", ev)
	}
	p = validate(t, schema, ev.Data)
	if p.FromStartsAt == nil || p.ToStartsAt != nil {
		t.Fatalf("cancelled payload wrong: %+v", p)
	}
}

// Resuming from a cursor delivers exactly the events after it: none missed, none repeated.
func TestResumeFromCursorIsExact(t *testing.T) {
	h := start(t, func(c *config.Config) { c.MaxStreamsPerInstance = 2 })
	api := h.env.NewAPI(t)
	doctor := api.Doctor()

	first := h.open(q(), nil)
	if f, _ := first.nextEvent(t, 5*time.Second); f.Event != "hello" {
		t.Fatalf("got %+v", f)
	}
	b1 := api.Book(doctor)
	api.Book(doctor)
	api.Book(doctor)
	var ids []string
	for range 3 {
		f, ok := first.nextEvent(t, 5*time.Second)
		if !ok || f.Event != "appointment.booked" {
			t.Fatalf("got %+v", f)
		}
		ids = append(ids, f.ID)
	}
	first.close()

	// Resume after the first: exactly the second and third, in order.
	second := h.open(q("cursor", ids[0]), nil)
	for i := 1; i < 3; i++ {
		f, ok := second.nextEvent(t, 5*time.Second)
		if f.Event == "hello" {
			f, ok = second.nextEvent(t, 5*time.Second)
		}
		if !ok || f.ID != ids[i] {
			t.Fatalf("resume item %d = %+v, want id %s", i, f, ids[i])
		}
	}
	// Nothing is repeated: the next thing is the event for a new booking.
	api.Cancel(b1)
	f, ok := second.nextEvent(t, 5*time.Second)
	if !ok || f.Event != "appointment.cancelled" {
		t.Fatalf("after catch-up got %+v", f)
	}
	second.close()

	// Last-Event-ID is honoured when no cursor parameter is given.
	third := h.open(q(), map[string][]string{"Last-Event-ID": {ids[1]}})
	f, _ = third.nextEvent(t, 5*time.Second)
	if f.Event == "hello" {
		f, _ = third.nextEvent(t, 5*time.Second)
	}
	if f.ID != ids[2] {
		t.Fatalf("Last-Event-ID resume = %+v, want %s", f, ids[2])
	}
}

func TestInvalidCursorIs400Problem(t *testing.T) {
	h := start(t, nil)
	for _, bad := range []string{"abc", "1", "1.x", "-1.1"} {
		s := h.open(q("cursor", bad), nil)
		if s.resp.StatusCode != 400 || s.resp.Header.Get("Content-Type") != "application/problem+json" {
			t.Fatalf("cursor %q: %d %s", bad, s.resp.StatusCode, s.resp.Header.Get("Content-Type"))
		}
		s.close()
	}
}

func TestSSEHeadersAreProxySafe(t *testing.T) {
	h := start(t, nil)
	s := h.open(q(), nil)
	hdr := s.resp.Header
	if hdr.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("content-type = %q", hdr.Get("Content-Type"))
	}
	cc := hdr.Get("Cache-Control")
	if !strings.Contains(cc, "no-cache") || !strings.Contains(cc, "no-transform") {
		t.Fatalf("cache-control = %q", cc)
	}
	// First byte arrives promptly (the hello frame), without waiting for a poll or heartbeat.
	start := time.Now()
	if _, ok := s.nextEvent(t, 3*time.Second); !ok {
		t.Fatal("no hello")
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("first frame took %v", d)
	}
}
