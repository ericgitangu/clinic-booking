package gateway_test

import (
	"bufio"
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/app"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/assertion"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/config"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/testenv"
)

var testKey = []byte("test-signing-key-0123456789abcdefABCDEF")

const ownerEmail = "owner@gateway-tests.org"

// harness is a real gateway (the same app.App as production) on a loopback port, connected to
// the real database as the clinic_realtime role.
type harness struct {
	t      *testing.T
	env    testenv.Env
	app    *app.App
	base   string
	cancel context.CancelFunc
	done   chan error
}

func baseConfig(env testenv.Env) config.Config {
	return config.Config{
		Port:                  "0",
		DatabaseURL:           env.RealtimeDSN,
		SigningKey:            testKey,
		OwnerEmails:           map[string]bool{ownerEmail: true},
		MaxStreamsPerInstance: 1,
		MaxStreamsPerPerson:   1,
		PollInterval:          100 * time.Millisecond,
		HeartbeatInterval:     25 * time.Second,
		MaxConnection:         30 * time.Second,
		Idle:                  30 * time.Second,
		RoleRecheck:           30 * time.Second,
		DBMaxConns:            2,
		ShutdownTimeout:       5 * time.Second,
		ProblemsBaseURL:       "http://api.test",
	}
}

func start(t *testing.T, mutate func(*config.Config)) *harness {
	t.Helper()
	env := testenv.Load(t)
	cfg := baseConfig(env)
	if mutate != nil {
		mutate(&cfg)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	lc := net.ListenConfig{}
	ln, err := lc.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := &harness{t: t, env: env, app: app.New(cfg, log), base: "http://" + ln.Addr().String(), done: make(chan error, 1)}
	var ctx context.Context
	ctx, h.cancel = context.WithCancel(context.Background())
	go func() { h.done <- h.app.Serve(ctx, ln) }()
	t.Cleanup(func() { _ = h.shutdown() })
	return h
}

// shutdown triggers graceful shutdown and returns the error Serve reported.
func (h *harness) shutdown() error {
	h.cancel()
	select {
	case err := <-h.done:
		h.done <- err // idempotent for the cleanup call
		return err
	case <-time.After(15 * time.Second):
		h.t.Fatal("Serve did not return after shutdown")
		return nil
	}
}

// who is a signed-in person as the admin app would describe them.
type who struct{ email, role string }

var (
	asOwner = who{ownerEmail, "owner"}
	asAdmin = who{"admin@gateway-tests.org", "admin"}
	asView  = who{"viewer@gateway-tests.org", "viewer"}
)

// grant makes the database agree with who (owners are configuration, not a row).
func (h *harness) grant(w who) {
	h.t.Helper()
	if w.role != "owner" {
		testenv.GrantStaff(h.t, h.env, w.email, w.role)
	}
}

// header signs an assertion for exactly this request target.
func header(w who, target string, mutate func(map[string]any)) http.Header {
	now := time.Now().Unix()
	claims := map[string]any{
		"aud": assertion.Audience, "sub": "sub-" + w.email, "email": w.email, "role": w.role,
		"iat": now, "exp": now + 60, "m": "GET", "p": target, "bh": assertion.BodyHash(nil), "ev": true,
	}
	if mutate != nil {
		mutate(claims)
	}
	v, err := assertion.Sign(claims, testKey)
	if err != nil {
		panic(err)
	}
	return http.Header{assertion.Header: {v}}
}

// frame is one parsed SSE frame.
type frame struct {
	ID, Event, Data, Comment string
	At                       time.Time
}

// sse is an open stream plus its parsed frames.
type sse struct {
	resp   *http.Response
	cancel context.CancelFunc
	frames chan frame
}

// open issues GET /stream?query as who, signing for exactly that target.
func (h *harness) open(w who, query url.Values) *sse {
	h.t.Helper()
	target := "/stream"
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	return h.openRaw(target, header(w, target, nil))
}

// openRaw issues GET target with exactly these headers (for the negative auth tests).
func (h *harness) openRaw(target string, hdr http.Header) *sse {
	h.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.base+target, nil)
	if err != nil {
		cancel()
		h.t.Fatal(err)
	}
	for k, v := range hdr {
		req.Header[k] = v
	}
	resp, err := (&http.Client{}).Do(req) //nolint:bodyclose // closed by sse.close, registered with t.Cleanup below
	if err != nil {
		cancel()
		h.t.Fatalf("GET %s: %v", target, err)
	}
	s := &sse{resp: resp, cancel: cancel, frames: make(chan frame, 256)}
	h.t.Cleanup(s.close)
	if resp.StatusCode == http.StatusOK {
		go s.read()
	}
	return s
}

func (s *sse) close() {
	s.cancel()
	_ = s.resp.Body.Close()
}

func (s *sse) read() {
	defer close(s.frames)
	sc := bufio.NewScanner(s.resp.Body)
	var f frame
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			if f != (frame{}) {
				f.At = time.Now()
				s.frames <- f
			}
			f = frame{}
		case strings.HasPrefix(line, ":"):
			f.Comment = strings.TrimSpace(line[1:])
		case strings.HasPrefix(line, "id: "):
			f.ID = line[4:]
		case strings.HasPrefix(line, "event: "):
			f.Event = line[7:]
		case strings.HasPrefix(line, "data: "):
			f.Data = line[6:]
		}
	}
}

// next waits for the next frame; ok is false if the stream ended first.
func (s *sse) next(t *testing.T, within time.Duration) (f frame, ok bool) {
	t.Helper()
	select {
	case f, ok = <-s.frames:
		return f, ok
	case <-time.After(within):
		t.Fatalf("no frame within %v", within)
		return frame{}, false
	}
}

// nextEvent skips comments and returns the next frame that has an event name.
func (s *sse) nextEvent(t *testing.T, within time.Duration) (frame, bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		f, ok := s.next(t, time.Until(deadline))
		if !ok || f.Event != "" {
			return f, ok
		}
	}
}

// hello opens the stream and consumes its first frame.
func (h *harness) hello(w who, query url.Values) *sse {
	h.t.Helper()
	h.grant(w)
	s := h.open(w, query)
	if s.resp.StatusCode != http.StatusOK {
		h.t.Fatalf("stream as %s refused: %d", w.role, s.resp.StatusCode)
	}
	if f, _ := s.nextEvent(h.t, 5*time.Second); f.Event != "hello" {
		h.t.Fatalf("first frame = %+v", f)
	}
	return s
}

// get issues a GET and returns the status code.
func (h *harness) get(path string) int {
	h.t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, h.base+path, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

func q(kv ...string) url.Values {
	v := url.Values{}
	for i := 0; i+1 < len(kv); i += 2 {
		v.Set(kv[i], kv[i+1])
	}
	return v
}

func waitFor(t *testing.T, within time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %v waiting for %s", within, what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
