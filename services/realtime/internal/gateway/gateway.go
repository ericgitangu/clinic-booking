// Package gateway serves GET /stream (Server-Sent Events) and GET /health.
//
// Cost model (the service must stay at $0 on the shared billing account): Cloud Run bills an
// instance while a request is open, so every stream is closed by the server, never by trust in
// the client:
//
//   - at the ticket's life claim (capped by MAX_CONNECTION), whichever is shorter;
//   - after IDLE_TIMEOUT without a delivered appointment event;
//   - on shutdown.
//
// /health does no I/O, so a probe never wakes the database. Nothing here schedules work: with
// no stream there is no goroutine, no query and no connection.
package gateway

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/config"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/cursor"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/events"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/store"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/ticket"
)

const (
	pollBatch    = 200
	writeTimeout = 10 * time.Second
)

// Close reasons, also the `reason` field of the final SSE event.
const (
	ReasonLifetime  = "lifetime"
	ReasonIdle      = "idle"
	ReasonShutdown  = "shutdown"
	ReasonDatabase  = "database"
	ReasonUnsupport = "unsupported_event"
	ReasonClient    = "client"
)

// Gateway is the HTTP handler and its admission state.
type Gateway struct {
	cfg   config.Config
	store *store.Store
	log   *slog.Logger
	drain context.Context

	active atomic.Int64

	mu    sync.Mutex
	perIP map[string]int
}

// New builds the gateway. drain is cancelled on shutdown; open streams then send a final
// `reconnect` event and return, so the HTTP server can finish within its grace period.
func New(drain context.Context, cfg config.Config, st *store.Store, log *slog.Logger) *Gateway {
	return &Gateway{cfg: cfg, store: st, log: log, drain: drain, perIP: map[string]int{}}
}

// Active is the number of open streams.
func (g *Gateway) Active() int { return int(g.active.Load()) }

// Handler routes the two endpoints.
func (g *Gateway) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", g.health)
	mux.HandleFunc("/stream", g.stream)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		g.writeProblem(w, r, http.StatusNotFound, "NOT_FOUND", "Not found", "No such resource.", nil)
	})
	return mux
}

func (g *Gateway) health(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		g.methodNotAllowed(w, r, "GET, HEAD")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

func (g *Gateway) methodNotAllowed(w http.ResponseWriter, r *http.Request, allow string) {
	g.writeProblem(w, r, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Method not allowed",
		"Use "+allow+".", map[string]string{"Allow": allow})
}

// clientIP trusts X-Client-IP because Cloud Run admits only the front door, which sets it
// (docs/adr/0023). Without it (local runs) the socket address is used.
func clientIP(r *http.Request) string {
	if v := strings.TrimSpace(r.Header.Get("X-Client-IP")); v != "" {
		return v
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// admit reserves a slot or says why not. The returned func releases it.
func (g *Gateway) admit(ip string) (release func(), status int, code string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.Active() >= g.cfg.MaxStreamsPerInstance {
		return nil, http.StatusServiceUnavailable, "STREAM_CAPACITY"
	}
	if g.perIP[ip] >= g.cfg.MaxStreamsPerIP {
		return nil, http.StatusTooManyRequests, "TOO_MANY_STREAMS"
	}
	g.perIP[ip]++
	g.active.Add(1)
	return func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		if g.perIP[ip]--; g.perIP[ip] <= 0 {
			delete(g.perIP, ip)
		}
		g.active.Add(-1)
	}, 0, ""
}

func (g *Gateway) stream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		g.methodNotAllowed(w, r, "GET")
		return
	}
	q := r.URL.Query()

	life := g.cfg.MaxConnection
	if g.cfg.AuthRequired {
		claims, err := ticket.Verify(g.cfg.TicketKey, g.cfg.Audience, time.Now(), q.Get("ticket"))
		switch {
		case errors.Is(err, ticket.ErrMissing):
			g.writeProblem(w, r, http.StatusUnauthorized, "STREAM_TICKET_REQUIRED", "Stream ticket required",
				"Request a ticket from POST /admin/stream-ticket and pass it as ?ticket=.", nil)
			return
		case err != nil:
			// The reason is logged, never returned: the caller learns only that it failed.
			g.log.Info("ticket rejected", slog.String("reason", err.Error()))
			g.writeProblem(w, r, http.StatusUnauthorized, "STREAM_TICKET_INVALID", "Stream ticket invalid",
				"The ticket is invalid or expired. Request a new one.", nil)
			return
		}
		life = min(life, claims.Lifetime())
	}

	var from *cursor.Cursor
	raw := q.Get("cursor")
	if raw == "" {
		raw = r.Header.Get("Last-Event-ID")
	}
	if raw != "" {
		c, err := cursor.Parse(raw)
		if err != nil {
			g.writeProblem(w, r, http.StatusBadRequest, "VALIDATION_ERROR", "Invalid cursor",
				"cursor must look like <txid>.<id>.", nil)
			return
		}
		from = &c
	}

	rc := http.NewResponseController(w)
	release, status, code := g.admit(clientIP(r))
	if release == nil {
		title := "Live feed busy"
		if status == http.StatusTooManyRequests {
			title = "Too many streams from this address"
		}
		g.writeProblem(w, r, status, code, title, "Try again shortly.", map[string]string{"Retry-After": "5"})
		return
	}
	defer release()

	lease, err := g.store.Acquire(r.Context())
	if err != nil {
		g.log.Error("database unavailable", slog.String("error", err.Error()))
		g.writeProblem(w, r, http.StatusServiceUnavailable, "DB_UNAVAILABLE", "Database unavailable",
			"The live feed cannot reach the database.", map[string]string{"Retry-After": "5"})
		return
	}
	defer lease.Release()

	var pos cursor.Cursor
	if from != nil {
		pos = *from
	} else {
		if pos, err = lease.Horizon(r.Context()); err != nil {
			g.log.Error("horizon failed", slog.String("error", err.Error()))
			g.writeProblem(w, r, http.StatusServiceUnavailable, "DB_UNAVAILABLE", "Database unavailable",
				"The live feed cannot reach the database.", map[string]string{"Retry-After": "5"})
			return
		}
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-store, no-transform")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	s := &session{g: g, w: w, rc: rc, pos: pos}
	start := time.Now()
	reason := s.run(r.Context(), lease, life)
	g.log.Info("stream closed",
		slog.String("reason", reason),
		slog.Float64("connected_seconds", time.Since(start).Seconds()),
		slog.Int("events_sent", s.sent))
}

type session struct {
	g    *Gateway
	w    http.ResponseWriter
	rc   *http.ResponseController
	pos  cursor.Cursor
	sent int
}

// frame writes one SSE frame and flushes. A failed write means the client is gone.
func (s *session) frame(id, event, data string) error {
	var b strings.Builder
	if id != "" {
		b.WriteString("id: " + id + "\n")
	}
	if event != "" {
		b.WriteString("event: " + event + "\n")
	}
	if data != "" {
		b.WriteString("data: " + data + "\n")
	}
	b.WriteString("\n")
	return s.write(b.String())
}

func (s *session) comment(text string) error { return s.write(": " + text + "\n\n") }

func (s *session) write(frame string) error {
	_ = s.rc.SetWriteDeadline(time.Now().Add(writeTimeout))
	if _, err := s.w.Write([]byte(frame)); err != nil {
		return err
	}
	return s.rc.Flush()
}

func (s *session) finish(reason string) string {
	// Best effort: the client may already be gone.
	_ = s.frame("", closeEvent(reason), fmt.Sprintf(`{"reason":%q}`, reason))
	return reason
}

func closeEvent(reason string) string {
	if reason == ReasonIdle {
		return "idle"
	}
	return "reconnect"
}

// run is the stream loop. It returns the close reason.
func (s *session) run(ctx context.Context, lease *store.Lease, life time.Duration) string {
	g := s.g
	hello := fmt.Sprintf(`{"cursor":%q,"lifetime_seconds":%d,"idle_seconds":%d}`,
		s.pos, int(life.Seconds()), int(g.cfg.Idle.Seconds()))
	if err := s.frame(s.pos.String(), "hello", hello); err != nil {
		return ReasonClient
	}

	lifeT := time.NewTimer(life)
	defer lifeT.Stop()
	idleT := time.NewTimer(g.cfg.Idle)
	defer idleT.Stop()
	hbT := time.NewTicker(g.cfg.HeartbeatInterval)
	defer hbT.Stop()
	pollT := time.NewTicker(g.cfg.PollInterval)
	defer pollT.Stop()

	// Poll once at once so a resume delivers its backlog without waiting a full interval.
	poll := func() (string, bool) {
		for {
			rows, err := lease.Poll(ctx, s.pos, pollBatch)
			if err != nil {
				if ctx.Err() != nil {
					return ReasonClient, true
				}
				g.log.Error("poll failed", slog.String("error", err.Error()))
				return s.finish(ReasonDatabase), true
			}
			for _, row := range rows {
				name, data, err := events.Encode(row)
				if err != nil {
					g.log.Error("event not encodable", slog.String("error", err.Error()))
					return s.finish(ReasonUnsupport), true
				}
				if err := s.frame(row.Cursor().String(), name, string(data)); err != nil {
					return ReasonClient, true
				}
				s.pos = row.Cursor()
				s.sent++
			}
			if len(rows) > 0 {
				resetTimer(idleT, g.cfg.Idle)
			}
			if len(rows) < pollBatch {
				return "", false
			}
		}
	}
	if reason, done := poll(); done {
		return reason
	}

	for {
		select {
		case <-ctx.Done():
			return ReasonClient
		case <-g.drain.Done():
			return s.finish(ReasonShutdown)
		case <-lifeT.C:
			return s.finish(ReasonLifetime)
		case <-idleT.C:
			return s.finish(ReasonIdle)
		case <-hbT.C:
			if err := s.comment("hb"); err != nil {
				return ReasonClient
			}
		case <-pollT.C:
			if reason, done := poll(); done {
				return reason
			}
		}
	}
}

func resetTimer(t *time.Timer, d time.Duration) {
	if !t.Stop() {
		select {
		case <-t.C:
		default:
		}
	}
	t.Reset(d)
}
