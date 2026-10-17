package gateway_test

import (
	"encoding/json"
	"io"
	"testing"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/config"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/ticket"
)

func problemCode(t *testing.T, s *sse) string {
	t.Helper()
	b, err := io.ReadAll(s.resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var p struct {
		Code string `json:"code"`
		Type string `json:"type"`
	}
	if err := json.Unmarshal(b, &p); err != nil {
		t.Fatalf("not a problem body: %s", b)
	}
	if want := "http://api.test/problems/"; len(p.Type) < len(want) || p.Type[:len(want)] != want {
		t.Fatalf("problem type %q does not point at the API catalogue", p.Type)
	}
	return p.Code
}

func TestTicketEnforcement(t *testing.T) {
	h := start(t, func(c *config.Config) { c.AuthRequired = true })

	other, err := ticket.Sign([]byte("a-different-key-0123456789abcdef!!"), ticket.Claims{
		V: 1, Aud: "clinic-realtime", Exp: time.Now().Unix() + 60, Life: 700})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, ticket, code string
	}{
		{"missing", "", "STREAM_TICKET_REQUIRED"},
		{"garbage", "not-a-ticket", "STREAM_TICKET_INVALID"},
		{"wrong key", other, "STREAM_TICKET_INVALID"},
		{"wrong audience", h.ticket(700, func(c *ticket.Claims) { c.Aud = "clinic-api" }), "STREAM_TICKET_INVALID"},
		{"expired", h.ticket(700, func(c *ticket.Claims) { c.Exp = time.Now().Unix() - 1 }), "STREAM_TICKET_INVALID"},
		{"no lifetime", h.ticket(0, nil), "STREAM_TICKET_INVALID"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := h.open(q("ticket", tc.ticket), nil)
			if s.resp.StatusCode != 401 {
				t.Fatalf("status = %d", s.resp.StatusCode)
			}
			if got := problemCode(t, s); got != tc.code {
				t.Fatalf("code = %s, want %s", got, tc.code)
			}
		})
	}

	s := h.open(q("ticket", h.ticket(700, nil)), nil)
	if s.resp.StatusCode != 200 {
		t.Fatalf("valid ticket got %d", s.resp.StatusCode)
	}
	if f, _ := s.nextEvent(t, 3*time.Second); f.Event != "hello" {
		t.Fatalf("got %+v", f)
	}
}

// A rejected ticket must not open the database: auth happens before any connection.
func TestRejectedTicketNeverTouchesTheDatabase(t *testing.T) {
	h := start(t, func(c *config.Config) { c.AuthRequired = true })
	for range 5 {
		h.open(q("ticket", "nope"), nil).close()
	}
	if st := h.app.Store.Stats(); st.PoolOpen || st.Queries != 0 {
		t.Fatalf("store touched by unauthenticated requests: %+v", st)
	}
}

func TestTicketsAreIgnoredWhenAuthIsOff(t *testing.T) {
	h := start(t, nil)
	s := h.open(q(), nil)
	if s.resp.StatusCode != 200 {
		t.Fatalf("status = %d", s.resp.StatusCode)
	}
	s2 := h.open(q("ticket", "junk"), nil)
	// Second stream hits the instance cap, not an auth error.
	if s2.resp.StatusCode != 503 {
		t.Fatalf("status = %d, want 503 (cap), junk ticket must be ignored", s2.resp.StatusCode)
	}
}

// The ticket's life claim bounds the stream; the gateway must not assume any fixed value.
func TestTicketLifetimeIsAuthoritative(t *testing.T) {
	h := start(t, func(c *config.Config) {
		c.AuthRequired = true
		c.MaxConnection = 20 * time.Second
		c.Idle = 20 * time.Second
	})
	s := h.open(q("ticket", h.ticket(3, nil)), nil)
	hello, _ := s.nextEvent(t, 3*time.Second)
	var body struct {
		Lifetime int `json:"lifetime_seconds"`
	}
	if err := json.Unmarshal([]byte(hello.Data), &body); err != nil || body.Lifetime != 3 {
		t.Fatalf("hello = %+v (%v)", hello, err)
	}
	// A life claim above the server ceiling is capped, never extended.
	s2 := start(t, func(c *config.Config) {
		c.AuthRequired = true
		c.MaxConnection = 5 * time.Second
		c.Idle = 5 * time.Second
	})
	big := s2.open(q("ticket", s2.ticket(700, nil)), nil)
	hello, _ = big.nextEvent(t, 3*time.Second)
	if err := json.Unmarshal([]byte(hello.Data), &body); err != nil || body.Lifetime != 5 {
		t.Fatalf("capped hello = %+v (%v)", hello, err)
	}
}
