package gateway_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/config"
)

// One stream per instance (docs/adr/0014). The second connection is refused with 503
// STREAM_CAPACITY and Retry-After, and the slot frees when the first one ends.
func TestOneStreamPerInstance(t *testing.T) {
	h := start(t, nil)
	first := h.open(q(), nil)
	if f, _ := first.nextEvent(t, 3*time.Second); f.Event != "hello" {
		t.Fatalf("got %+v", f)
	}
	second := h.open(q(), nil)
	if second.resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("second stream status = %d, want 503", second.resp.StatusCode)
	}
	if second.resp.Header.Get("Retry-After") == "" || second.resp.Header.Get("Content-Type") != "application/problem+json" {
		t.Fatalf("headers = %v", second.resp.Header)
	}
	if got := problemCode(t, second); got != "STREAM_CAPACITY" {
		t.Fatalf("code = %s", got)
	}

	first.close()
	waitFor(t, 3*time.Second, "slot to free after disconnect", func() bool { return h.app.Gateway.Active() == 0 })
	third := h.open(q(), nil)
	if third.resp.StatusCode != http.StatusOK {
		t.Fatalf("after release status = %d", third.resp.StatusCode)
	}
}

func TestPerIPLimit(t *testing.T) {
	h := start(t, func(c *config.Config) {
		c.MaxStreamsPerInstance = 5
		c.MaxStreamsPerIP = 2
	})
	hdr := func(ip string) http.Header { return http.Header{"X-Client-Ip": {ip}} }
	a1, a2 := h.open(q(), hdr("203.0.113.7")), h.open(q(), hdr("203.0.113.7"))
	if a1.resp.StatusCode != 200 || a2.resp.StatusCode != 200 {
		t.Fatalf("statuses %d %d", a1.resp.StatusCode, a2.resp.StatusCode)
	}
	a3 := h.open(q(), hdr("203.0.113.7"))
	if a3.resp.StatusCode != http.StatusTooManyRequests || a3.resp.Header.Get("Retry-After") == "" {
		t.Fatalf("third from same ip: %d %v", a3.resp.StatusCode, a3.resp.Header)
	}
	if got := problemCode(t, a3); got != "TOO_MANY_STREAMS" {
		t.Fatalf("code = %s", got)
	}
	if other := h.open(q(), hdr("203.0.113.8")); other.resp.StatusCode != 200 {
		t.Fatalf("different ip refused: %d", other.resp.StatusCode)
	}
}

func TestMethodsAndRoutes(t *testing.T) {
	h := start(t, nil)
	for _, tc := range []struct {
		method, path string
		want         int
	}{
		{http.MethodPost, "/stream", 405},
		{http.MethodDelete, "/health", 405},
		{http.MethodGet, "/nope", 404},
	} {
		req, _ := http.NewRequestWithContext(context.Background(), tc.method, h.base+tc.path, nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != tc.want {
			t.Fatalf("%s %s = %d, want %d", tc.method, tc.path, resp.StatusCode, tc.want)
		}
	}
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
