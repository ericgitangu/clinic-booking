// Package ticket verifies the stream ticket of docs/adr/0022. clinic-api issues it (POST
// /admin/stream-ticket); the gateway only verifies, with the standard library.
//
// Wire format (the contract clinic-api must produce):
//
//	<base64url(payload)>.<base64url(HMAC-SHA256(key, base64url(payload)))>
//
// Both halves are unpadded base64url. The payload is JSON:
//
//	{"v":1,"aud":"clinic-realtime","exp":<unix seconds>,"life":<seconds>}
//
// exp is when the ticket stops being accepted for a new connection (60 s after issue). life is
// how long the stream it opens may stay open, in seconds: it is what the API debited from its
// connected-seconds budget (700 today). The gateway treats life as authoritative and never
// assumes a value; it only caps it with its own configured maximum.
package ticket

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Version is the only payload version understood.
const Version = 1

// maxTokenLen bounds the work done for a hostile query parameter. A real ticket is ~100 bytes.
const maxTokenLen = 1024

// Claims is the signed payload.
type Claims struct {
	V    int    `json:"v"`
	Aud  string `json:"aud"`
	Exp  int64  `json:"exp"`
	Life int64  `json:"life"`
}

// Lifetime is the permitted stream duration.
func (c Claims) Lifetime() time.Duration { return time.Duration(c.Life) * time.Second }

// Verification failures. Callers map every one of them to the same 401; the distinction is for
// logs and tests.
var (
	ErrMissing   = errors.New("ticket missing")
	ErrMalformed = errors.New("ticket malformed")
	ErrSignature = errors.New("ticket signature mismatch")
	ErrVersion   = errors.New("ticket version unsupported")
	ErrAudience  = errors.New("ticket audience mismatch")
	ErrExpired   = errors.New("ticket expired")
	ErrLifetime  = errors.New("ticket lifetime invalid")
)

var enc = base64.RawURLEncoding

// Sign produces a ticket. The service itself never mints tickets; this exists so tests (and any
// future tool) build tickets with the same code the verifier reads.
func Sign(key []byte, c Claims) (string, error) {
	payload, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	body := enc.EncodeToString(payload)
	return body + "." + enc.EncodeToString(mac(key, body)), nil
}

func mac(key []byte, body string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(body))
	return h.Sum(nil)
}

// Verify checks signature (constant time), then version, audience, expiry and lifetime. The
// signature is checked before the payload is decoded, so unsigned input never reaches the JSON
// decoder.
func Verify(key []byte, audience string, now time.Time, token string) (Claims, error) {
	if token == "" {
		return Claims{}, ErrMissing
	}
	if len(token) > maxTokenLen {
		return Claims{}, ErrMalformed
	}
	body, sig, ok := strings.Cut(token, ".")
	if !ok || body == "" || sig == "" || strings.Contains(sig, ".") {
		return Claims{}, ErrMalformed
	}
	got, err := enc.DecodeString(sig)
	if err != nil {
		return Claims{}, ErrMalformed
	}
	if !hmac.Equal(got, mac(key, body)) {
		return Claims{}, ErrSignature
	}
	raw, err := enc.DecodeString(body)
	if err != nil {
		return Claims{}, ErrMalformed
	}
	var c Claims
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return Claims{}, ErrMalformed
	}
	switch {
	case c.V != Version:
		return Claims{}, ErrVersion
	case c.Aud != audience:
		return Claims{}, ErrAudience
	case now.Unix() >= c.Exp:
		return Claims{}, ErrExpired
	case c.Life <= 0:
		return Claims{}, ErrLifetime
	}
	return c, nil
}
