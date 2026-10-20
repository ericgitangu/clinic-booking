// Package gateway serves GET /stream (Server-Sent Events) and GET /health for the admin live feed.
//
// Who may connect. Cloud Run only admits the admin app's service account (IAM), and the request
// must carry the signed staff assertion the admin app attaches to every call (see package
// assertion). The role in the assertion is then checked against the database, exactly like the
// API's require_role: the person must hold that very role in staff_access (or be a configured
// owner) right now, and the database role, not the claim, decides the shape of the stream. The
// role is re-read while the stream is open, so a revoke ends it within ROLE_RECHECK.
//
// Cost model (the service must stay at $0 on the shared billing account): Cloud Run bills an
// instance while a request is open, so the server closes every stream itself, never trusting the
// client: at MAX_CONNECTION, after IDLE_TIMEOUT without a delivered event, when the role
// changes, and on shutdown. /health does no I/O, so a probe never wakes the database. Nothing
// here schedules work: with no stream there is no goroutine, no query and no connection.
package gateway

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/assertion"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/config"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/cursor"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/events"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/store"
)

const (
	pollBatch = 200
	// maxBatchesPerTick caps one poll's catch-up: a resume from an old cursor replays at most
	// pollBatch*maxBatchesPerTick rows per PollInterval, and drain, lifetime and the client are
	// checked between batches, so a long replay can neither hold a shutdown nor outlive the cap.
	maxBatchesPerTick = 5
	writeTimeout      = 10 * time.Second
)

// appointmentID is a canonical lower-case UUID, the only form the appointment filter accepts.
var appointmentID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Close reasons, also the `reason` field of the final SSE event.
const (
	ReasonLifetime  = "lifetime"
	ReasonIdle      = "idle"
	ReasonShutdown  = "shutdown"
	ReasonDatabase  = "database"
	ReasonAccess    = "access_changed"
	ReasonClient    = "client"
	ReasonUnencoded = "unsupported_event"
	// ReasonProbe ends the release smoke's stream right after its catch-up: the smoke reads what
	// is behind its cursor and leaves. Cloud Run does not tell the instance when a client goes
	// away (no stream in the production logs has ever closed with reason "client"), so a stream
	// the smoke merely abandons holds an instance until the idle close, 240 s later.
	ReasonProbe = "probe"
)

// Gateway is the HTTP handler and its admission state.
type Gateway struct {
	cfg   config.Config
	store *store.Store
	log   *slog.Logger
	drain context.Context

	active atomic.Int64

	mu       sync.Mutex
	byPerson map[string]int
}

// New builds the gateway. drain is cancelled on shutdown; open streams then send a final
// `reconnect` event and return, so the HTTP server can finish within its grace period.
func New(drain context.Context, cfg config.Config, st *store.Store, log *slog.Logger) *Gateway {
	return &Gateway{cfg: cfg, store: st, log: log, drain: drain, byPerson: map[string]int{}}
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

// admit reserves a slot or says why not. The returned func releases it.
//
// Both caps are per instance: byPerson lives in this process, so with two instances one person
// can hold a stream on each, which is the whole service. The admin app opens one stream per
// browser (see /decisions#go), so that now takes two browsers, or a stream
// Cloud Run never reported closed. The global cap is recorded as a known limit on /decisions#go.
func (g *Gateway) admit(person string) (release func(), status int, code string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.Active() >= g.cfg.MaxStreamsPerInstance {
		return nil, http.StatusTooManyRequests, "RATE_LIMITED"
	}
	if g.byPerson[person] >= g.cfg.MaxStreamsPerPerson {
		return nil, http.StatusTooManyRequests, "RATE_LIMITED"
	}
	g.byPerson[person]++
	g.active.Add(1)
	return func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		if g.byPerson[person]--; g.byPerson[person] <= 0 {
			delete(g.byPerson, person)
		}
		g.active.Add(-1)
	}, 0, ""
}

// roleOf is the role the person holds right now: configured owner, else staff_access.
func (g *Gateway) roleOf(ctx context.Context, lease *store.Lease, email string) (string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if g.cfg.OwnerEmails[email] {
		return "owner", nil
	}
	return lease.Role(ctx, email)
}

func (g *Gateway) stream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		g.methodNotAllowed(w, r, "GET")
		return
	}

	// 1. The assertion, bound to this exact request. Nothing touches the database before it passes.
	principal, smoke, err := g.principal(r)
	if err != nil {
		g.log.Info("assertion refused", slog.String("reason", err.Error()))
		g.writeProblem(w, r, http.StatusUnauthorized, "UNAUTHENTICATED", "Authentication required",
			"A valid staff assertion is required.", nil)
		return
	}
	if !smoke {
		switch principal.Role {
		case "owner", "admin", "viewer":
		default:
			g.log.Info("assertion refused", slog.String("reason", "role not allowed for this endpoint"))
			g.writeProblem(w, r, http.StatusForbidden, "FORBIDDEN", "Forbidden", "This role cannot read the live feed.", nil)
			return
		}
	}

	var from *cursor.Cursor
	raw := r.URL.Query().Get("cursor")
	if raw == "" {
		raw = r.Header.Get("Last-Event-ID")
	}
	if raw != "" {
		c, err := cursor.Parse(raw)
		if err != nil {
			g.writeProblem(w, r, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Invalid cursor",
				"cursor must look like <txid>.<id>.", nil)
			return
		}
		from = &c
	}

	// The per-appointment filter (the admin app's appointment page). Same assertion: the signed
	// path includes the query string, so the filter cannot be changed on the way.
	appointment := ""
	if vals, ok := r.URL.Query()["appointment"]; ok {
		if len(vals) != 1 || !appointmentID.MatchString(vals[0]) {
			g.writeProblem(w, r, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Invalid appointment",
				"appointment must be one lower-case UUID.", nil)
			return
		}
		appointment = vals[0]
	}

	// 2. Admission, then the database: the role must be the one the database says.
	release, status, code := g.admit(strings.ToLower(principal.Email))
	if release == nil {
		g.log.Info("stream refused", slog.String("reason", "no free slot"), slog.Int("active", g.Active()))
		g.writeProblem(w, r, status, code, "Live feed busy",
			"The live feed is serving another viewer. The dashboard keeps updating by polling.",
			map[string]string{"Retry-After": "30"})
		return
	}
	defer release()

	lease, err := g.store.Acquire(r.Context())
	if err != nil {
		g.log.Error("database unavailable", slog.String("error", err.Error()))
		g.dbUnavailable(w, r)
		return
	}
	defer lease.Release()

	current := "smoke"
	if !smoke {
		current, err = g.roleOf(r.Context(), lease, principal.Email)
		if err != nil {
			g.log.Error("role lookup failed", slog.String("error", err.Error()))
			g.dbUnavailable(w, r)
			return
		}
		if current == "" || current != principal.Role {
			g.log.Info("assertion refused", slog.String("reason", "role is not the one currently held"))
			g.writeProblem(w, r, http.StatusForbidden, "FORBIDDEN", "Forbidden", "You no longer hold this role.", nil)
			return
		}
	}

	var pos cursor.Cursor
	if from != nil {
		pos = *from
	} else if pos, err = lease.Horizon(r.Context()); err != nil {
		g.log.Error("horizon failed", slog.String("error", err.Error()))
		g.dbUnavailable(w, r)
		return
	}

	// A resumed stream is sent a backlog. Which rows are backlog is decided per row, against the
	// database's own clock read now: a row whose occurred_at is before this moment was written
	// before the stream opened. occurred_at is not the commit time, and the two tables set it
	// differently: appointment_events uses now(), the START of its transaction;
	// staff_action_audit uses clock_timestamp(), the moment of each INSERT. Both are at or before
	// the commit, so a row written before this moment and committed after it is counted as
	// backlog (its event is not toasted; it still shows in the feed). That is a named limit, and it
	// fails in the quiet direction. A transaction can straddle the moment only where it writes
	// SEVERAL audit rows that are streamed in their own right, each stamped by its own
	// clock_timestamp(): "running late" (one row per patient told) and creating an invitation (a
	// revoke row for each invitation it supersedes, then the create row). Rows inserted before the
	// moment are backlog and the ones after are not. An appointment event and the audit row beside
	// it do not straddle: the audit row of an attendance, veto or booking is not a frame of its own,
	// it only names who did it on the event.
	var opened time.Time
	if from != nil {
		if opened, err = lease.Now(r.Context()); err != nil {
			g.log.Error("now failed", slog.String("error", err.Error()))
			g.dbUnavailable(w, r)
			return
		}
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-store, no-transform")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	g.log.Info("stream opened", slog.String("role", current), slog.Bool("filtered", appointment != ""),
		slog.Bool("resumed", from != nil))

	begin := time.Now()
	s := &session{g: g, w: w, rc: http.NewResponseController(w), pos: pos, resumed: from != nil, opened: opened, role: current,
		staff: current == "owner" || current == "admin", email: principal.Email, smoke: smoke,
		appointment: appointment, lifeEnd: begin.Add(g.cfg.MaxConnection)}
	reason := s.run(r.Context(), lease)
	g.log.Info("stream closed",
		slog.String("reason", reason),
		slog.String("role", current),
		slog.Float64("connected_seconds", time.Since(begin).Seconds()),
		slog.Int("events_sent", s.sent))
}

// principal verifies the assertion with the staff key and, if that key did not sign it and a
// smoke key is configured, with the smoke key. The smoke key only ever opens the smoke identity.
func (g *Gateway) principal(r *http.Request) (p assertion.Principal, smoke bool, err error) {
	header := r.Header.Get(assertion.Header)
	p, err = assertion.Verify(header, g.cfg.SigningKey, r.Method, r.RequestURI, nil, time.Now())
	if err == nil || len(g.cfg.SmokeKey) == 0 || !strings.Contains(err.Error(), "bad signature") {
		return p, false, err
	}
	p, err = assertion.Verify(header, g.cfg.SmokeKey, r.Method, r.RequestURI, nil, time.Now())
	if err != nil {
		return assertion.Principal{}, false, err
	}
	if p.Role != "smoke" || p.Sub != assertion.SmokeSub {
		return assertion.Principal{}, false, fmt.Errorf("%w: not the smoke caller", assertion.ErrInvalid)
	}
	return p, true, nil
}

func (g *Gateway) dbUnavailable(w http.ResponseWriter, r *http.Request) {
	g.writeProblem(w, r, http.StatusServiceUnavailable, "DB_UNAVAILABLE", "Database unavailable",
		"The live feed cannot reach the database.", map[string]string{"Retry-After": "5"})
}

type session struct {
	g   *Gateway
	w   http.ResponseWriter
	rc  *http.ResponseController
	pos cursor.Cursor
	// resumed is true for a stream that started from a cursor the client brought; opened is the
	// database's time when it did. Every event frame of a resumed stream whose row was written
	// before opened carries the "replay" field. A fresh stream starts at the horizon and has no
	// backlog.
	resumed bool
	opened  time.Time
	role    string
	staff   bool
	email   string
	smoke   bool
	sent    int
	// appointment, when not "", limits the stream to one appointment.
	appointment string
	lifeEnd     time.Time
}

// frame writes one SSE frame and flushes. A failed write means the client is gone.
func (s *session) frame(id, event, data string) error { return s.frameTagged(id, event, data, false) }

// frameTagged is frame with, when replay is true, a "replay: true" field line between the event
// name and the data. SSE clients ignore field names they do not know, so a client that does not
// read it sees the same frame as before; the admin app's parser reads it and trusts it alone to
// tell the backlog a resumed stream is sent (rows written before the stream opened, by the
// database's clock) from what happens after.
func (s *session) frameTagged(id, event, data string, replay bool) error {
	var b strings.Builder
	if id != "" {
		b.WriteString("id: " + id + "\n")
	}
	if event != "" {
		b.WriteString("event: " + event + "\n")
	}
	if replay {
		b.WriteString("replay: true\n")
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
func (s *session) run(ctx context.Context, lease *store.Lease) string {
	g := s.g
	// "replay_tag": this gateway tags the backlog of a resumed stream (see frameTagged); a client
	// that finds the flag missing is talking to an older gateway and must not trust the absence of
	// a tag as "live".
	hello := fmt.Sprintf(`{"cursor":%q,"replay_tag":true,"role":%q,"lifetime_seconds":%d,"idle_seconds":%d}`,
		s.pos, s.role, int(g.cfg.MaxConnection.Seconds()), int(g.cfg.Idle.Seconds()))
	if err := s.frame(s.pos.String(), "hello", hello); err != nil {
		return ReasonClient
	}

	lifeT := time.NewTimer(g.cfg.MaxConnection)
	defer lifeT.Stop()
	idleT := time.NewTimer(g.cfg.Idle)
	defer idleT.Stop()
	hbT := time.NewTicker(g.cfg.HeartbeatInterval)
	defer hbT.Stop()
	pollT := time.NewTicker(g.cfg.PollInterval)
	defer pollT.Stop()
	roleT := time.NewTicker(g.cfg.RoleRecheck)
	defer roleT.Stop()

	// poll delivers what is safely behind the horizon, batch after batch, at most
	// maxBatchesPerTick batches per call; the rest follows on the next tick.
	poll := func() (string, bool) {
		for batch := 0; batch < maxBatchesPerTick; batch++ {
			if batch > 0 {
				// Between batches of a catch-up: stop for the client, a shutdown or the lifetime.
				select {
				case <-ctx.Done():
					return ReasonClient, true
				case <-g.drain.Done():
					return s.finish(ReasonShutdown), true
				default:
				}
				if !time.Now().Before(s.lifeEnd) {
					return s.finish(ReasonLifetime), true
				}
			}
			rows, err := lease.Poll(ctx, s.pos, pollBatch, s.staff, s.appointment)
			if err != nil {
				if ctx.Err() != nil {
					return ReasonClient, true
				}
				g.log.Error("poll failed", slog.String("error", err.Error()))
				return s.finish(ReasonDatabase), true
			}
			delivered := false
			for _, row := range rows {
				s.pos = row.Cursor() // advance first: a skipped row must not be re-read
				// Staff never see the release smoke's synthetic patient; the smoke sees nothing else.
				if row.Synthetic != s.smoke {
					continue
				}
				name, data, err := events.Encode(row, s.staff)
				if err != nil {
					// A type this version does not know: say so loudly, keep the feed moving.
					g.log.Error("event not encodable, skipped", slog.String("error", err.Error()))
					continue
				}
				if err := s.frameTagged(row.Cursor().String(), name, string(data), s.resumed && row.OccurredAt.Before(s.opened)); err != nil {
					return ReasonClient, true
				}
				s.sent++
				delivered = true
			}
			if delivered {
				resetTimer(idleT, g.cfg.Idle)
			}
			if len(rows) < pollBatch {
				return "", false
			}
		}
		return "", false
	}
	if reason, done := poll(); done {
		return reason
	}
	if s.smoke {
		return s.finish(ReasonProbe)
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
		case <-roleT.C:
			if s.smoke {
				continue
			}
			current, err := g.roleOf(ctx, lease, s.email)
			switch {
			case err != nil && ctx.Err() != nil:
				return ReasonClient
			case err != nil:
				g.log.Error("role recheck failed", slog.String("error", err.Error()))
				return s.finish(ReasonDatabase)
			case current != s.role:
				return s.finish(ReasonAccess)
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
