package gateway_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/config"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/cursor"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/events"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/testenv"
)

const contracts = "../../../../contracts/events/"

func compile(t *testing.T, file string) *jsonschema.Schema {
	t.Helper()
	raw, err := os.ReadFile(contracts + file) // #nosec G304 -- fixed contract file names in this repository
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

func valid(t *testing.T, s *jsonschema.Schema, data string) {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(data), &v); err != nil {
		t.Fatalf("data is not JSON: %v: %s", err, data)
	}
	if err := s.Validate(v); err != nil {
		t.Fatalf("violates the contract: %v\n%s", err, data)
	}
}

// An owner sees bookings made through the real API, as the staff shape: the patient's name, the
// appointment to link to and, for a cancellation, the reason.
func TestOwnerStreamReceivesStaffShapeFromRealBookings(t *testing.T) {
	h := start(t, nil)
	schema := compile(t, "staff-event.v1.schema.json")
	api := h.env.NewAPI(t)
	doctor := api.Doctor()

	s := h.hello(asOwner, q())
	booking := api.Book(doctor)
	ev, ok := s.nextEvent(t, 5*time.Second)
	if !ok || ev.Event != "booked" {
		t.Fatalf("want booked, got %+v", ev)
	}
	valid(t, schema, ev.Data)
	var got events.Staff
	if err := json.Unmarshal([]byte(ev.Data), &got); err != nil {
		t.Fatal(err)
	}
	if got.DoctorID != doctor || got.AppointmentID != booking.ID || got.PatientName != booking.PatientName ||
		got.ToStartsAt == nil || *got.ToStartsAt != booking.StartsAt.UTC().Format("2006-01-02T15:04:05.000000Z") ||
		got.FromStartsAt != nil || got.CancellationReason != nil {
		t.Fatalf("booked payload does not describe the booking: %+v (slot %v)", got, booking.StartsAt)
	}
	if got.Seq != ev.ID {
		t.Fatalf("seq %q must equal the SSE id %q", got.Seq, ev.ID)
	}
	bookedID, _ := cursor.Parse(ev.ID)

	same := api.Reschedule(booking, false)
	ev, _ = s.nextEvent(t, 5*time.Second)
	if ev.Event != "rescheduled" {
		t.Fatalf("want rescheduled, got %+v", ev)
	}
	valid(t, schema, ev.Data)
	_ = json.Unmarshal([]byte(ev.Data), &got)
	if got.FromLocalDate != nil || got.ToStartsAt == nil || *got.ToStartsAt != same.UTC().Format("2006-01-02T15:04:05.000000Z") {
		t.Fatalf("same-day rescheduled payload wrong: %+v", got)
	}
	if id, _ := cursor.Parse(ev.ID); !bookedID.Less(id) {
		t.Fatalf("ids out of order: %v then %v", bookedID, id)
	}

	booking.StartsAt = same
	cross := api.Reschedule(booking, true)
	ev, _ = s.nextEvent(t, 5*time.Second)
	valid(t, schema, ev.Data)
	got = events.Staff{}
	_ = json.Unmarshal([]byte(ev.Data), &got)
	if got.FromLocalDate == nil || *got.FromLocalDate != same.UTC().Format(time.DateOnly) ||
		got.LocalDate != cross.UTC().Format(time.DateOnly) {
		t.Fatalf("cross-day rescheduled payload wrong: %+v", got)
	}

	api.Cancel(booking, "Family emergency")
	ev, _ = s.nextEvent(t, 5*time.Second)
	if ev.Event != "cancelled" {
		t.Fatalf("want cancelled, got %+v", ev)
	}
	valid(t, schema, ev.Data)
	got = events.Staff{}
	_ = json.Unmarshal([]byte(ev.Data), &got)
	if got.CancellationReason == nil || *got.CancellationReason != "Family emergency" || got.ToStartsAt != nil {
		t.Fatalf("cancelled payload wrong: %+v", got)
	}
}

// A viewer gets the minimised shape: it validates against the shared admin-event contract (the
// one the push relay is pinned to), and the bytes carry no name, reason or appointment id.
func TestViewerStreamGetsThePIIMinimisedShape(t *testing.T) {
	h := start(t, nil)
	schema := compile(t, "admin-event.v1.schema.json")
	api := h.env.NewAPI(t)
	doctor := api.Doctor()

	s := h.hello(asView, q())
	patient, name := api.Patient()
	booking := api.BookFor(doctor, patient, name)
	api.Cancel(booking, "A very private reason")

	var seen []string
	for _, want := range []string{"booked", "cancelled"} {
		ev, ok := s.nextEvent(t, 5*time.Second)
		if !ok || ev.Event != want {
			t.Fatalf("want %s, got %+v", want, ev)
		}
		valid(t, schema, ev.Data)
		seen = append(seen, ev.Data, ev.ID, ev.Event)
	}
	all := strings.Join(seen, "\n")
	for _, banned := range []string{name, "Realtime Test", "private reason", booking.ID, patient, "patient", "appointment_id", "reason"} {
		if strings.Contains(all, banned) {
			t.Fatalf("a viewer's stream leaked %q:\n%s", banned, all)
		}
	}
}

// The release smoke's synthetic patient never shows on the live feed, for any role.
func TestSyntheticPatientEventsAreHidden(t *testing.T) {
	h := start(t, nil)
	api := h.env.NewAPI(t)
	doctor := api.Doctor()
	s := h.hello(asOwner, q())

	patient, name := api.Patient()
	testenv.MarkSynthetic(t, h.env, patient)
	api.BookFor(doctor, patient, name)
	real := api.Book(doctor)

	ev, ok := s.nextEvent(t, 5*time.Second)
	if !ok || ev.Event != "booked" || !strings.Contains(ev.Data, real.ID) {
		t.Fatalf("expected only the real patient's booking, got %+v", ev)
	}
}

// Resume: from a cursor (and from Last-Event-ID) the stream delivers exactly the later events.
func TestResumeFromCursorIsExact(t *testing.T) {
	h := start(t, func(c *config.Config) { c.MaxStreamsPerInstance = 3; c.MaxStreamsPerPerson = 3 })
	api := h.env.NewAPI(t)
	doctor := api.Doctor()

	first := h.hello(asOwner, q())
	b1 := api.Book(doctor)
	api.Book(doctor)
	api.Book(doctor)
	var ids []string
	for range 3 {
		f, ok := first.nextEvent(t, 5*time.Second)
		if !ok || f.Event != "booked" {
			t.Fatalf("got %+v", f)
		}
		ids = append(ids, f.ID)
	}
	first.close()

	second := h.open(asOwner, q("cursor", ids[0]))
	for i := 1; i < 3; i++ {
		f, _ := second.nextEvent(t, 5*time.Second)
		if f.Event == "hello" {
			f, _ = second.nextEvent(t, 5*time.Second)
		}
		if f.ID != ids[i] {
			t.Fatalf("resume item %d = %+v, want id %s", i, f, ids[i])
		}
	}
	api.Cancel(b1, "no longer needed")
	if f, _ := second.nextEvent(t, 5*time.Second); f.Event != "cancelled" {
		t.Fatalf("after catch-up got %+v", f)
	}
	second.close()

	target := "/stream"
	hdr := header(asOwner, target, nil)
	hdr.Set("Last-Event-ID", ids[1])
	third := h.openRaw(target, hdr)
	f, _ := third.nextEvent(t, 5*time.Second)
	if f.Event == "hello" {
		f, _ = third.nextEvent(t, 5*time.Second)
	}
	if f.ID != ids[2] {
		t.Fatalf("Last-Event-ID resume = %+v, want %s", f, ids[2])
	}
}

func TestInvalidCursorIs422Problem(t *testing.T) {
	h := start(t, nil)
	for _, bad := range []string{"abc", "1", "1.x", "-1.1", "01.2"} {
		s := h.open(asOwner, q("cursor", bad))
		if s.resp.StatusCode != http.StatusUnprocessableEntity || s.resp.Header.Get("Content-Type") != "application/problem+json" {
			t.Fatalf("cursor %q: %d %s", bad, s.resp.StatusCode, s.resp.Header.Get("Content-Type"))
		}
		s.close()
	}
}

func TestSSEHeadersAreProxySafeAndFirstFrameIsPrompt(t *testing.T) {
	h := start(t, nil)
	begin := time.Now()
	s := h.open(asOwner, q())
	hdr := s.resp.Header
	if hdr.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("content-type = %q", hdr.Get("Content-Type"))
	}
	if cc := hdr.Get("Cache-Control"); !strings.Contains(cc, "no-cache") || !strings.Contains(cc, "no-transform") {
		t.Fatalf("cache-control = %q", cc)
	}
	f, ok := s.nextEvent(t, 3*time.Second)
	if !ok || f.Event != "hello" || time.Since(begin) > 2*time.Second {
		t.Fatalf("hello %+v after %v", f, time.Since(begin))
	}
	var hello struct {
		Role     string `json:"role"`
		Lifetime int    `json:"lifetime_seconds"`
		Idle     int    `json:"idle_seconds"`
	}
	if err := json.Unmarshal([]byte(f.Data), &hello); err != nil || hello.Role != "owner" || hello.Lifetime != 30 || hello.Idle != 30 {
		t.Fatalf("hello = %+v (%v)", hello, err)
	}
	if !strings.Contains(f.Data, `"replay_tag":true`) {
		t.Fatalf("hello %s does not say this gateway tags its backlog", f.Data)
	}

}

// The tag is per ROW, against the database's clock: a row of a resumed stream is replay iff it was
// written before the stream opened, however many batches the backlog takes and however the polls
// fall. A fresh stream tags nothing.
func resumedBacklogThenLive(t *testing.T, backlog int) {
	t.Helper()
	h := start(t, func(c *config.Config) {
		c.MaxStreamsPerInstance = 3
		c.MaxStreamsPerPerson = 3
		c.PollInterval = 100 * time.Millisecond
	})
	api := h.env.NewAPI(t)
	doctor := api.Doctor()
	booking := api.Book(doctor)

	// Where "now" is: a fresh stream starts there.
	h.grant(asOwner)
	fresh := h.open(asOwner, q())
	hello, _ := fresh.nextEvent(t, 5*time.Second)
	if hello.Event != "hello" || hello.Replay {
		t.Fatalf("hello %+v: the hello frame is never replay", hello)
	}
	fresh.close()

	// The order of events is fixed by an open transaction, not by a race: it holds the horizon, so
	// nothing is delivered until it ends. The backlog is written and committed first, the stream
	// opens (and the first poll finds nothing), the live booking is made after the stream opened,
	// and only then is the horizon let go: backlog and live row come out together, backlog first.
	ctx := context.Background()
	holder := testenv.Connect(t, h.env.OwnerDSN)
	tx, err := holder.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT pg_current_xact_id()`); err != nil {
		t.Fatal(err)
	}
	owner := testenv.Connect(t, h.env.OwnerDSN)
	if _, err := owner.Exec(ctx, `INSERT INTO appointment_events
	  (appointment_id, doctor_id, event_type, to_starts_at, local_date)
	  SELECT $1::uuid, $2::uuid, 'booked', now() + interval '2 days', current_date + 2
	  FROM generate_series(1, $3::int)`, booking.ID, booking.DoctorID, backlog); err != nil {
		t.Fatal(err)
	}

	second := h.open(asOwner, q("cursor", hello.ID))
	if f, _ := second.nextEvent(t, 5*time.Second); f.Event != "hello" || f.Replay {
		t.Fatalf("resumed hello = %+v", f)
	}
	live := api.Book(doctor) // written after the stream opened
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	tagged := 0
	for {
		f, ok := second.nextEvent(t, 15*time.Second)
		if !ok {
			t.Fatalf("the stream ended after %d backlog frames, before the live booking", tagged)
		}
		if f.Event != "booked" {
			continue
		}
		if strings.Contains(f.Data, live.ID) {
			if f.Replay {
				t.Fatalf("the live booking arrived tagged as replay after %d backlog frames", tagged)
			}
			break
		}
		if !f.Replay {
			t.Fatalf("backlog frame %d (%s) was not tagged", tagged+1, f.ID)
		}
		tagged++
	}
	if tagged < backlog {
		t.Fatalf("saw %d tagged backlog frames, want at least the %d inserted", tagged, backlog)
	}
}

func TestBacklogOfSeveralBatchesIsTaggedAndALiveRowDuringCatchUpIsNot(t *testing.T) {
	resumedBacklogThenLive(t, 1300) // 7 batches of 200, across more than one tick
}

func TestBacklogThatIsAnExactMultipleOfTheBatchIsTaggedToo(t *testing.T) {
	resumedBacklogThenLive(t, 400)
}

// A row written (and committed) before the stream opened but withheld at first, because another
// transaction that started earlier was still open and held the horizon back, arrives on a later
// poll. It is backlog, so it is tagged, though the stream was no longer "catching up".
func TestARowWithheldByAnOpenTransactionIsStillTaggedWhenItArrivesLate(t *testing.T) {
	h := start(t, func(c *config.Config) {
		c.MaxStreamsPerInstance = 3
		c.MaxStreamsPerPerson = 3
		c.PollInterval = 100 * time.Millisecond
	})
	api := h.env.NewAPI(t)
	doctor := api.Doctor()
	api.Book(doctor)

	h.grant(asOwner)
	fresh := h.open(asOwner, q())
	hello, _ := fresh.nextEvent(t, 5*time.Second)
	fresh.close()

	ctx := context.Background()
	holder := testenv.Connect(t, h.env.OwnerDSN)
	tx, err := holder.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT pg_current_xact_id()`); err != nil { // takes a txid and holds the horizon
		t.Fatal(err)
	}
	held := api.Book(doctor) // commits now, with a txid after the holder's

	second := h.open(asOwner, q("cursor", hello.ID))
	if f, _ := second.nextEvent(t, 5*time.Second); f.Event != "hello" {
		t.Fatalf("hello = %+v", f)
	}
	select {
	case f := <-second.frames:
		if f.Event == "booked" {
			t.Fatalf("the row came through while an earlier transaction was open: %+v", f)
		}
	case <-time.After(500 * time.Millisecond):
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	for {
		f, ok := second.nextEvent(t, 5*time.Second)
		if !ok {
			t.Fatal("the stream ended before the withheld row arrived")
		}
		if f.Event == "booked" && strings.Contains(f.Data, held.ID) {
			if !f.Replay {
				t.Fatalf("the late row %+v was not tagged: it was committed before the stream opened", f)
			}
			return
		}
	}
}

// A fresh stream starts at the horizon and tags nothing it sends.
func TestAFreshStreamTagsNothing(t *testing.T) {
	h := start(t, func(c *config.Config) { c.PollInterval = 100 * time.Millisecond })
	api := h.env.NewAPI(t)
	s := h.hello(asOwner, q())
	api.Book(api.Doctor())
	f, _ := s.nextEvent(t, 5*time.Second)
	if f.Event != "booked" || f.Replay {
		t.Fatalf("a fresh stream's event = %+v, want it untagged", f)
	}
}

// With the production poll interval (1 s) a booking made through the real API reaches an open
// stream within 2 s of the API's response: the bound the dashboard promises.
func TestBookingAppearsWithinTwoSeconds(t *testing.T) {
	h := start(t, func(c *config.Config) { c.PollInterval = time.Second })
	api := h.env.NewAPI(t)
	s := h.hello(asOwner, q())
	for range 3 { // three samples: the poll phase differs each time
		booked := time.Now()
		api.Book(api.Doctor())
		ev, ok := s.nextEvent(t, 5*time.Second)
		if !ok || ev.Event != "booked" {
			t.Fatalf("got %+v", ev)
		}
		if d := ev.At.Sub(booked); d > 2*time.Second {
			t.Fatalf("the booking took %v to appear", d)
		}
	}
}
