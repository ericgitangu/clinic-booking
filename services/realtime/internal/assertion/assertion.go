// Package assertion verifies the signed staff assertion the admin app sends, byte for byte the
// scheme of backend/app/core/assertion.py: header X-Internal-Assertion = v1.<payload>.<mac>,
// payload = base64url (no padding) of the claims JSON, mac = base64url HMAC-SHA256 of the payload
// string under INTERNAL_SIGNING_KEY. The claims bind the audience, the HTTP method, the path with
// query string and the SHA-256 of the body, so a captured header opens nothing else.
//
// The MAC is checked over the payload exactly as received (the claims are never re-serialised),
// so key order and whitespace do not matter to the verifier.
package assertion

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

// Wire constants shared with the Python and TypeScript sides.
const (
	Audience   = "clinic-api/internal"
	Header     = "X-Internal-Assertion"
	Version    = "v1"
	MaxTTL     = 60 // seconds between iat and exp
	SkewSecond = 5
	// TimeBound bounds iat and exp (epoch seconds, about 34,800 years either way) before any
	// arithmetic, so exp-iat and exp+SkewSecond cannot overflow int64. The Python verifier applies
	// the same bound with the same verdict ("bad times"); contracts/assertion-vectors.json pins it.
	TimeBound = int64(1) << 40
)

// SmokeSub is the subject the release smoke signs with (backend/app/api/deps.py SMOKE_SUB).
const SmokeSub = "smoke:verify-claims"

// ErrInvalid wraps every rejection. The reason is for logs only, never for the response.
var ErrInvalid = errors.New("assertion rejected")

func reject(reason string) error { return fmt.Errorf("%w: %s", ErrInvalid, reason) }

// Principal is who the assertion says is calling.
type Principal struct {
	Sub           string
	Email         string
	Role          string
	EmailVerified bool
}

// enc rejects padding and non-zero trailing bits: one payload has exactly one encoding.
var enc = base64.RawURLEncoding.Strict()

// BodyHash is the lowercase hex SHA-256 the bh claim carries.
func BodyHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// Sign builds a header value. The gateway only verifies; this exists for tests and tooling and
// produces the same canonical form as the Python and TypeScript signers (sorted keys, no spaces).
func Sign(claims map[string]any, key []byte) (string, error) {
	// encoding/json sorts map keys, which is the canonical form.
	raw, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	payload := enc.EncodeToString(raw)
	return Version + "." + payload + "." + enc.EncodeToString(mac(key, payload)), nil
}

func mac(key []byte, payload string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(payload))
	return h.Sum(nil)
}

// Verify checks the header for this exact request.
func Verify(header string, key []byte, method, pathWithQuery string, body []byte, now time.Time) (Principal, error) {
	if header == "" {
		return Principal{}, reject("missing header")
	}
	parts := strings.Split(header, ".")
	if len(parts) != 3 || parts[0] != Version {
		return Principal{}, reject("bad format")
	}
	payload, got := parts[1], parts[2]
	gotMAC, err := enc.DecodeString(got)
	if err != nil || !hmac.Equal(gotMAC, mac(key, payload)) {
		return Principal{}, reject("bad signature")
	}
	raw, err := enc.DecodeString(payload)
	if err != nil {
		return Principal{}, reject("bad base64")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var claims map[string]any
	if err := dec.Decode(&claims); err != nil || claims == nil {
		return Principal{}, reject("bad payload")
	}
	// The claims object must be the whole payload: anything after it (even another JSON value)
	// is refused, as the Python verifier's json.loads refuses it.
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return Principal{}, reject("bad payload")
	}

	if claims["aud"] != Audience {
		return Principal{}, reject("wrong audience")
	}
	iat, ok1 := integer(claims["iat"])
	exp, ok2 := integer(claims["exp"])
	if !ok1 || !ok2 || iat < -TimeBound || iat > TimeBound || exp < -TimeBound || exp > TimeBound {
		return Principal{}, reject("bad times")
	}
	if exp-iat > MaxTTL || exp < iat {
		return Principal{}, reject("lifetime too long")
	}
	nowS := now.Unix()
	if iat > nowS+SkewSecond {
		return Principal{}, reject("issued in the future")
	}
	if nowS > exp+SkewSecond {
		return Principal{}, reject("expired")
	}
	if m, _ := claims["m"].(string); m != strings.ToUpper(method) {
		return Principal{}, reject("method mismatch")
	}
	if p, _ := claims["p"].(string); p != pathWithQuery {
		return Principal{}, reject("path mismatch")
	}
	bh, _ := claims["bh"].(string)
	if !hmac.Equal([]byte(bh), []byte(BodyHash(body))) {
		return Principal{}, reject("body mismatch")
	}
	sub, ok1s := claims["sub"].(string)
	email, ok2s := claims["email"].(string)
	role, ok3s := claims["role"].(string)
	if !ok1s || !ok2s || !ok3s {
		return Principal{}, reject("missing identity")
	}
	ev, _ := claims["ev"].(bool)
	return Principal{Sub: sub, Email: email, Role: role, EmailVerified: ev}, nil
}

// integer accepts only a JSON integer (not a float, not a bool), like the Python check.
func integer(v any) (int64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	i, err := n.Int64()
	return i, err == nil
}
