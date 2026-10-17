package gateway_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/config"
)

// closeAfter waits for the final event and the end of the stream, returning when the server
// closed it and the final event seen.
func closeAfter(t *testing.T, s *sse, within time.Duration) (final frame, closedAt time.Time) {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		f, ok := s.next(t, time.Until(deadline))
		if !ok {
			return final, time.Now()
		}
		if f.Event != "" {
			final = f
		}
	}
}

// Server-side lifetime: a ticket with life=2 s ends the stream at about 2 s even though the
// client stays connected and the server ceiling is far away.
func TestStreamClosesAtTicketLifetime(t *testing.T) {
	h := start(t, func(c *config.Config) {
		c.AuthRequired = true
		c.MaxConnection = 60 * time.Second
		c.Idle = 60 * time.Second
	})
	begin := time.Now()
	s := h.open(q("ticket", h.ticket(2, nil)), nil)
	final, closed := closeAfter(t, s, 6*time.Second)
	took := closed.Sub(begin)
	if final.Event != "reconnect" || !strings.Contains(final.Data, `"lifetime"`) {
		t.Fatalf("final frame = %+v", final)
	}
	if took < 1900*time.Millisecond || took > 3500*time.Millisecond {
		t.Fatalf("closed after %v, want about 2s", took)
	}
	waitFor(t, 2*time.Second, "pool to close after lifetime close", func() bool {
		st := h.app.Store.Stats()
		return !st.PoolOpen && st.Leases == 0 && h.app.Gateway.Active() == 0
	})
}

// The server ceiling closes a stream whose ticket would allow longer.
func TestStreamClosesAtServerCeiling(t *testing.T) {
	h := start(t, func(c *config.Config) {
		c.AuthRequired = true
		c.MaxConnection = 2 * time.Second
		c.Idle = 2 * time.Second
	})
	begin := time.Now()
	s := h.open(q("ticket", h.ticket(700, nil)), nil)
	final, closed := closeAfter(t, s, 6*time.Second)
	if final.Event == "" || closed.Sub(begin) > 3500*time.Millisecond {
		t.Fatalf("final %+v after %v", final, closed.Sub(begin))
	}
}

// Idle close: with no appointment events the server ends the stream after IDLE_TIMEOUT. Heartbeat
// comments flow meanwhile but do not keep it open.
func TestStreamClosesWhenIdleDespiteHeartbeats(t *testing.T) {
	h := start(t, func(c *config.Config) {
		c.Idle = 1500 * time.Millisecond
		c.HeartbeatInterval = 300 * time.Millisecond
		c.MaxConnection = 30 * time.Second
	})
	begin := time.Now()
	s := h.open(q(), nil)
	var heartbeats int
	var final frame
	for {
		f, ok := s.next(t, 6*time.Second)
		if !ok {
			break
		}
		if f.Comment == "hb" {
			heartbeats++
		}
		if f.Event == "idle" {
			final = f
		}
	}
	took := time.Since(begin)
	if final.Event != "idle" || !strings.Contains(final.Data, `"idle"`) {
		t.Fatalf("final = %+v", final)
	}
	if took < 1400*time.Millisecond || took > 3*time.Second {
		t.Fatalf("closed after %v, want about 1.5s", took)
	}
	if heartbeats < 3 {
		t.Fatalf("saw %d heartbeat comments, want >= 3 in 1.5s at 300ms", heartbeats)
	}
	waitFor(t, 2*time.Second, "pool closed after idle close", func() bool { return !h.app.Store.Stats().PoolOpen })
}

// An event resets the idle clock: a stream that gets a booking at ~1.2 s of a 2 s idle window
// outlives the original deadline and closes about 2 s after the event.
func TestEventResetsIdleClock(t *testing.T) {
	h := start(t, func(c *config.Config) {
		c.Idle = 2 * time.Second
		c.MaxConnection = 30 * time.Second
	})
	api := h.env.NewAPI(t)
	doctor := api.Doctor()

	begin := time.Now()
	s := h.open(q(), nil)
	if f, _ := s.nextEvent(t, 3*time.Second); f.Event != "hello" {
		t.Fatalf("got %+v", f)
	}
	time.Sleep(1200 * time.Millisecond)
	api.Book(doctor)
	ev, _ := s.nextEvent(t, 3*time.Second)
	if ev.Event != "appointment.booked" {
		t.Fatalf("got %+v", ev)
	}
	final, closed := closeAfter(t, s, 6*time.Second)
	if final.Event != "idle" {
		t.Fatalf("final = %+v", final)
	}
	if got := closed.Sub(begin); got < 3*time.Second {
		t.Fatalf("closed at %v; the event at ~1.2s should have pushed idle close past 3.2s", got)
	}
	if since := closed.Sub(ev.At); since < 1800*time.Millisecond || since > 3*time.Second {
		t.Fatalf("closed %v after the event, want about 2s", since)
	}
}

// With no viewers the gateway does nothing: no pool, no queries. While one watches the poller
// runs; when the watcher goes the pool closes and the query counter stops moving.
func TestNoSubscribersMeansNoQueriesAndNoConnections(t *testing.T) {
	h := start(t, nil)
	time.Sleep(500 * time.Millisecond) // five poll intervals with nobody watching
	if st := h.app.Store.Stats(); st.PoolOpen || st.Queries != 0 {
		t.Fatalf("idle gateway touched the database: %+v", st)
	}
	h.get("/health")
	if st := h.app.Store.Stats(); st.PoolOpen || st.Queries != 0 {
		t.Fatalf("/health touched the database: %+v", st)
	}

	s := h.open(q(), nil)
	if f, _ := s.nextEvent(t, 3*time.Second); f.Event != "hello" {
		t.Fatalf("got %+v", f)
	}
	time.Sleep(500 * time.Millisecond)
	st := h.app.Store.Stats()
	if !st.PoolOpen || st.Leases != 1 || h.app.Gateway.Active() != 1 || st.Queries < 4 {
		t.Fatalf("with one viewer: %+v active=%d", st, h.app.Gateway.Active())
	}

	s.close() // browser tab closed: the request context is cancelled
	waitFor(t, 3*time.Second, "subscriber count and pool to return to zero", func() bool {
		st := h.app.Store.Stats()
		return !st.PoolOpen && st.Leases == 0 && h.app.Gateway.Active() == 0
	})
	before := h.app.Store.Stats().Queries
	time.Sleep(500 * time.Millisecond)
	if after := h.app.Store.Stats().Queries; after != before {
		t.Fatalf("poller kept querying with no subscribers: %d -> %d", before, after)
	}
}

// Graceful shutdown: open streams are told to reconnect and finish, Serve returns cleanly well
// inside the grace period, and the listener stops accepting.
func TestGracefulShutdown(t *testing.T) {
	h := start(t, nil)
	s := h.open(q(), nil)
	if f, _ := s.nextEvent(t, 3*time.Second); f.Event != "hello" {
		t.Fatalf("got %+v", f)
	}
	begin := time.Now()
	if err := h.shutdown(); err != nil {
		t.Fatalf("Serve returned %v", err)
	}
	if d := time.Since(begin); d > 2*time.Second {
		t.Fatalf("shutdown took %v with one open stream", d)
	}
	final, _ := closeAfter(t, s, 2*time.Second)
	if final.Event != "reconnect" || !strings.Contains(final.Data, `"shutdown"`) {
		t.Fatalf("final = %+v", final)
	}
	if st := h.app.Store.Stats(); st.PoolOpen || st.Leases != 0 {
		t.Fatalf("pool survived shutdown: %+v", st)
	}
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, h.base+"/health", nil)
	if resp, err := http.DefaultClient.Do(req); err == nil {
		_ = resp.Body.Close()
		t.Fatal("listener still accepting after shutdown")
	}
}
