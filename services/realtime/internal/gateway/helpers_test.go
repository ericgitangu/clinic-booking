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
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/config"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/testenv"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/ticket"
)

var testKey = []byte("test-ticket-key-0123456789abcdefABCDEF")

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
		AuthRequired:          false,
		TicketKey:             testKey,
		Audience:              "clinic-realtime",
		MaxStreamsPerInstance: 1,
		MaxStreamsPerIP:       3,
		PollInterval:          100 * time.Millisecond,
		HeartbeatInterval:     15 * time.Second,
		MaxConnection:         30 * time.Second,
		Idle:                  30 * time.Second,
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

func (h *harness) ticket(life int64, mutate func(*ticket.Claims)) string {
	h.t.Helper()
	c := ticket.Claims{V: 1, Aud: "clinic-realtime", Exp: time.Now().Unix() + 60, Life: life}
	if mutate != nil {
		mutate(&c)
	}
	s, err := ticket.Sign(testKey, c)
	if err != nil {
		h.t.Fatal(err)
	}
	return s
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

// open issues GET /stream?query and returns the response without consuming the body.
func (h *harness) open(query url.Values, hdr http.Header) *sse {
	h.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.base+"/stream?"+query.Encode(), nil)
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
		h.t.Fatalf("GET /stream: %v", err)
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
