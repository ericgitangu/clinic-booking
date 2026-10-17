package ticket_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/ticket"
)

var (
	key = []byte("0123456789abcdef0123456789abcdef")
	now = time.Unix(1_800_000_000, 0)
)

func sign(t *testing.T, k []byte, c ticket.Claims) string {
	t.Helper()
	s, err := ticket.Sign(k, c)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func good() ticket.Claims {
	return ticket.Claims{V: 1, Aud: "clinic-realtime", Exp: now.Unix() + 60, Life: 700}
}

func TestVerifyAccepts(t *testing.T) {
	c, err := ticket.Verify(key, "clinic-realtime", now, sign(t, key, good()))
	if err != nil {
		t.Fatal(err)
	}
	if c.Lifetime() != 700*time.Second {
		t.Fatalf("lifetime = %v", c.Lifetime())
	}
}

func TestVerifyRejects(t *testing.T) {
	enc := base64.RawURLEncoding
	other := []byte("ffffffffffffffffffffffffffffffff")
	valid := sign(t, key, good())
	body, sig, _ := strings.Cut(valid, ".")
	tamperedBody := enc.EncodeToString([]byte(`{"v":1,"aud":"clinic-realtime","exp":1800000060,"life":99999}`))

	expired := good()
	expired.Exp = now.Unix()
	noLife := good()
	noLife.Life = 0
	badV := good()
	badV.V = 2
	badAud := good()
	badAud.Aud = "clinic-api"

	cases := []struct {
		name  string
		token string
		want  error
	}{
		{"empty", "", ticket.ErrMissing},
		{"no dot", "abc", ticket.ErrMalformed},
		{"empty body", "." + sig, ticket.ErrMalformed},
		{"empty sig", body + ".", ticket.ErrMalformed},
		{"three parts", valid + ".x", ticket.ErrMalformed},
		{"sig not base64", body + ".!!!", ticket.ErrMalformed},
		{"oversized", strings.Repeat("a", 2000), ticket.ErrMalformed},
		{"wrong key", sign(t, other, good()), ticket.ErrSignature},
		{"tampered payload keeps old sig", tamperedBody + "." + sig, ticket.ErrSignature},
		{"expired at exp", sign(t, key, expired), ticket.ErrExpired},
		{"wrong audience", sign(t, key, badAud), ticket.ErrAudience},
		{"wrong version", sign(t, key, badV), ticket.ErrVersion},
		{"no lifetime", sign(t, key, noLife), ticket.ErrLifetime},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ticket.Verify(key, "clinic-realtime", now, tc.token)
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestVerifyRejectsUnknownFieldsAndGarbagePayload(t *testing.T) {
	enc := base64.RawURLEncoding
	for _, raw := range []string{`not json`, `{"v":1,"aud":"clinic-realtime","exp":1800000060,"life":1,"email":"a@b.c"}`} {
		body := enc.EncodeToString([]byte(raw))
		// Sign over the raw body so only the payload check can fail.
		tok := signBody(t, body)
		if _, err := ticket.Verify(key, "clinic-realtime", now, tok); !errors.Is(err, ticket.ErrMalformed) {
			t.Fatalf("%q: err = %v", raw, err)
		}
	}
}

func signBody(t *testing.T, body string) string {
	t.Helper()
	h := hmac.New(sha256.New, key)
	h.Write([]byte(body))
	return body + "." + base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

func TestExpiryBoundary(t *testing.T) {
	tok := sign(t, key, good())
	if _, err := ticket.Verify(key, "clinic-realtime", now.Add(59*time.Second), tok); err != nil {
		t.Fatalf("one second before exp: %v", err)
	}
	if _, err := ticket.Verify(key, "clinic-realtime", now.Add(60*time.Second), tok); !errors.Is(err, ticket.ErrExpired) {
		t.Fatalf("at exp: %v", err)
	}
}
