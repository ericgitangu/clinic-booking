package assertion_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/assertion"
)

type vectors struct {
	Key   string `json:"key"`
	Cases []struct {
		Name      string `json:"name"`
		Header    string `json:"header"`
		Method    string `json:"method"`
		Path      string `json:"path"`
		Body      string `json:"body"`
		Now       int64  `json:"now"`
		Expect    string `json:"expect"`
		Principal *struct {
			Sub           string `json:"sub"`
			Email         string `json:"email"`
			Role          string `json:"role"`
			EmailVerified bool   `json:"email_verified"`
		} `json:"principal"`
	} `json:"cases"`
}

// The Python side signed every header in this file (backend/scripts/make_assertion_vectors.py);
// the Go verifier must reach the same verdict for each one.
func TestSharedVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../../contracts/assertion-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Cases) < 10 {
		t.Fatalf("only %d vectors", len(v.Cases))
	}
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			p, err := assertion.Verify(c.Header, []byte(v.Key), c.Method, c.Path, []byte(c.Body), time.Unix(c.Now, 0))
			if c.Expect == "ok" {
				if err != nil {
					t.Fatalf("rejected: %v", err)
				}
				w := c.Principal
				if p.Sub != w.Sub || p.Email != w.Email || p.Role != w.Role || p.EmailVerified != w.EmailVerified {
					t.Fatalf("principal = %+v, want %+v", p, *w)
				}
				return
			}
			if !errors.Is(err, assertion.ErrInvalid) || !strings.Contains(err.Error(), c.Expect) {
				t.Fatalf("err = %v, want rejection containing %q", err, c.Expect)
			}
		})
	}
}

func TestGoSignedHeaderRoundTripsAndRejectsGarbage(t *testing.T) {
	key := []byte(strings.Repeat("k", 32))
	now := time.Unix(1_800_000_000, 0)
	h, err := assertion.Sign(map[string]any{
		"aud": assertion.Audience, "sub": "s", "email": "a@b.c", "role": "viewer",
		"iat": now.Unix(), "exp": now.Unix() + 60, "m": "GET", "p": "/stream", "bh": assertion.BodyHash(nil),
	}, key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := assertion.Verify(h, key, "get", "/stream", nil, now); err != nil {
		t.Fatalf("lower-case method must match: %v", err)
	}
	for _, bad := range []string{"", "v1.x", "v1.a.b.c", "v2.a.b", h + "x", strings.Replace(h, "v1", "v2", 1)} {
		if _, err := assertion.Verify(bad, key, "GET", "/stream", nil, now); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

// A payload whose last base64 character carries non-zero padding bits decodes to the same bytes
// under a lenient decoder. The verifier refuses it even with a valid MAC over that exact string:
// one payload, one encoding.
func TestNonCanonicalBase64IsRefused(t *testing.T) {
	key := []byte(strings.Repeat("k", 32))
	now := time.Unix(1_800_000_000, 0)
	h, err := assertion.Sign(map[string]any{
		"aud": assertion.Audience, "sub": "s1", "email": "a@b.c", "role": "viewer",
		"iat": now.Unix(), "exp": now.Unix() + 60, "m": "GET", "p": "/stream", "bh": assertion.BodyHash(nil),
	}, key)
	if err != nil {
		t.Fatal(err)
	}
	payload := strings.Split(h, ".")[1]
	if len(payload)%4 == 0 {
		t.Fatalf("payload length %d leaves no padding bits: change the claims", len(payload))
	}
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	last := strings.IndexByte(alphabet, payload[len(payload)-1])
	// The low bit of the last character is a padding bit whenever the length is not a multiple of 4.
	tampered := payload[:len(payload)-1] + string(alphabet[last^1])
	m := hmac.New(sha256.New, key)
	m.Write([]byte(tampered))
	header := "v1." + tampered + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
	if _, err := base64.RawURLEncoding.DecodeString(tampered); err != nil {
		t.Fatalf("the lenient decoder must accept the tampered payload for this test to mean anything: %v", err)
	}
	_, err = assertion.Verify(header, key, "GET", "/stream", nil, now)
	if !errors.Is(err, assertion.ErrInvalid) || !strings.Contains(err.Error(), "bad base64") {
		t.Fatalf("err = %v, want bad base64", err)
	}
}
