package gateway_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/config"
)

// One stream per instance: a second connection gets 429 with Retry-After (the dashboard then
// falls back to refreshing), and the slot frees as soon as the first one ends.
func TestOneStreamPerInstance(t *testing.T) {
	h := start(t, nil)
	h.grant(asAdmin)
	first := h.hello(asOwner, q())
	second := h.open(asAdmin, q())
	if second.resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("second stream status = %d, want 429", second.resp.StatusCode)
	}
	if second.resp.Header.Get("Retry-After") == "" || second.resp.Header.Get("Content-Type") != "application/problem+json" {
		t.Fatalf("headers = %v", second.resp.Header)
	}
	expectBody(t, second, "RATE_LIMITED")

	first.close()
	waitFor(t, 3*time.Second, "slot to free after disconnect", func() bool { return h.app.Gateway.Active() == 0 })
	third := h.open(asAdmin, q())
	if third.resp.StatusCode != http.StatusOK {
		t.Fatalf("after release status = %d", third.resp.StatusCode)
	}
}

func TestOneStreamPerPerson(t *testing.T) {
	h := start(t, func(c *config.Config) { c.MaxStreamsPerInstance = 5 })
	h.grant(asAdmin)
	first := h.hello(asOwner, q())
	_ = first
	if again := h.open(asOwner, q()); again.resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("same person, second tab: %d", again.resp.StatusCode)
	}
	if other := h.open(asAdmin, q()); other.resp.StatusCode != http.StatusOK {
		t.Fatalf("another person refused: %d", other.resp.StatusCode)
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
