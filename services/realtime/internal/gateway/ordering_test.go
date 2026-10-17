package gateway_test

import (
	"context"
	"testing"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/cursor"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/testenv"
)

const insertEvent = `INSERT INTO appointment_events
  (appointment_id, doctor_id, event_type, to_starts_at, local_date)
  VALUES ($1, $2, 'booked', now() + interval '2 days', current_date + 2) RETURNING id`

// docs/adr/0009 / docs/adr/0018: identity ids are assigned at write time, not commit time. Transaction A
// writes first (lower id, lower txid) and commits last. A naive `id > last` reader that has seen
// B's row skips A forever; the horizon cursor withholds B until A has finished and then delivers
// both, in order, exactly once.
func TestOutOfOrderCommitIsNeitherSkippedNorDuplicated(t *testing.T) {
	h := start(t, nil)
	env := h.env
	api := env.NewAPI(t)
	booking := api.Book(api.Doctor()) // a real appointment for the event rows to reference

	s := h.open(q(), nil)
	if f, _ := s.nextEvent(t, 3*time.Second); f.Event != "hello" {
		t.Fatalf("got %+v", f)
	}
	ctx := context.Background()
	a := testenv.Connect(t, env.OwnerDSN)
	b := testenv.Connect(t, env.OwnerDSN)
	reader := testenv.Connect(t, env.RealtimeDSN)

	var lastSeen int64
	if err := reader.QueryRow(ctx, `SELECT coalesce(max(id), 0) FROM appointment_events`).Scan(&lastSeen); err != nil {
		t.Fatal(err)
	}

	txA, err := a.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var idA, idB int64
	if err := txA.QueryRow(ctx, insertEvent, booking.ID, booking.DoctorID).Scan(&idA); err != nil {
		t.Fatal(err)
	}
	txB, err := b.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := txB.QueryRow(ctx, insertEvent, booking.ID, booking.DoctorID).Scan(&idB); err != nil {
		t.Fatal(err)
	}
	if idA >= idB {
		t.Fatalf("setup: expected A's id below B's, got %d and %d", idA, idB)
	}
	if err := txB.Commit(ctx); err != nil { // B commits first
		t.Fatal(err)
	}

	// Control: the naive reader sees B but not A, and would now advance its cursor to idB.
	var naiveMax int64
	if err := reader.QueryRow(ctx, `SELECT coalesce(max(id), 0) FROM appointment_events WHERE id > $1`, lastSeen).Scan(&naiveMax); err != nil {
		t.Fatal(err)
	}
	if naiveMax != idB {
		t.Fatalf("control: naive reader should see B (%d) while A is open, saw %d", idB, naiveMax)
	}

	// The gateway withholds B because A (a lower xid) is still running.
	for i := 0; i < 15; i++ { // 1.5 s of polling at 100 ms
		select {
		case f := <-s.frames:
			t.Fatalf("gateway delivered %+v while an older transaction was open", f)
		case <-time.After(100 * time.Millisecond):
		}
	}

	if err := txA.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	// Control, continued: the naive reader positioned at idB never sees A.
	var skipped int
	if err := reader.QueryRow(ctx, `SELECT count(*) FROM appointment_events WHERE id > $1 AND id = $2`, naiveMax, idA).Scan(&skipped); err != nil {
		t.Fatal(err)
	}
	if skipped != 0 {
		t.Fatalf("control: naive reader unexpectedly still sees A")
	}

	first, _ := s.nextEvent(t, 5*time.Second)
	second, _ := s.nextEvent(t, 5*time.Second)
	if first.Event != "appointment.booked" || second.Event != "appointment.booked" {
		t.Fatalf("events = %+v, %+v", first, second)
	}
	c1, err1 := cursor.Parse(first.ID)
	c2, err2 := cursor.Parse(second.ID)
	if err1 != nil || err2 != nil || !c1.Less(c2) {
		t.Fatalf("ids %q then %q must be strictly increasing", first.ID, second.ID)
	}
	if c1.ID != idA || c2.ID != idB {
		t.Fatalf("delivered ids %d, %d; want A=%d then B=%d", c1.ID, c2.ID, idA, idB)
	}
	// Exactly once: nothing else follows.
	select {
	case f := <-s.frames:
		t.Fatalf("duplicate or extra frame %+v", f)
	case <-time.After(600 * time.Millisecond):
	}
}

// More rows than one poll batch arrive complete and in order, with the cursor advancing across
// batches (the loop in session.run must keep polling until a short batch).
func TestBacklogLargerThanOneBatchIsDeliveredInOrder(t *testing.T) {
	h := start(t, nil)
	env := h.env
	api := env.NewAPI(t)
	booking := api.Book(api.Doctor())

	// Position just before the backlog.
	pre := h.open(q(), nil)
	hello, _ := pre.nextEvent(t, 3*time.Second)
	start := hello.ID
	pre.close()
	waitFor(t, 3*time.Second, "slot free", func() bool { return h.app.Gateway.Active() == 0 })

	const n = 450
	ctx := context.Background()
	conn := testenv.Connect(t, env.OwnerDSN)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for range n {
		if _, err := tx.Exec(ctx, insertEvent, booking.ID, booking.DoctorID); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	s := h.open(q("cursor", start), nil)
	var prev cursor.Cursor
	got := 0
	for got < n {
		f, ok := s.nextEvent(t, 10*time.Second)
		if !ok {
			t.Fatalf("stream ended after %d of %d events", got, n)
		}
		if f.Event != "appointment.booked" {
			continue // hello
		}
		c, err := cursor.Parse(f.ID)
		if err != nil || (got > 0 && !prev.Less(c)) {
			t.Fatalf("event %d id %q not after %v (%v)", got, f.ID, prev, err)
		}
		prev = c
		got++
	}
	select {
	case f := <-s.frames:
		if f.Event != "" {
			t.Fatalf("extra event after the backlog: %+v", f)
		}
	case <-time.After(500 * time.Millisecond):
	}
}
