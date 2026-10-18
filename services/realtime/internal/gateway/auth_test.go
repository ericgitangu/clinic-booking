package gateway_test

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/assertion"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/config"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/testenv"
)

func problem(t *testing.T, s *sse) (status int, code, typ string) {
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
	return s.resp.StatusCode, p.Code, p.Type
}

func expect(t *testing.T, s *sse, status int, code string) {
	t.Helper()
	got, c, typ := problem(t, s)
	if got != status || c != code {
		t.Fatalf("got %d %s, want %d %s", got, c, status, code)
	}
	if want := "http://api.test/problems/"; len(typ) < len(want) || typ[:len(want)] != want {
		t.Fatalf("problem type %q does not point at the API catalogue", typ)
	}
}

// The assertion is bound to this exact request and is checked before the database is touched.
func TestAssertionIsRequiredAndBoundToTheRequest(t *testing.T) {
	h := start(t, nil)
	target := "/stream?cursor=1.1"
	other := who{"admin@gateway-tests.org", "admin"}

	cases := []struct {
		name string
		hdr  http.Header
	}{
		{"missing", http.Header{}},
		{"garbage", http.Header{assertion.Header: {"v1.x.y"}}},
		{"another path", header(asOwner, "/stream?cursor=9.9", nil)},
		{"POST claim", header(asOwner, target, func(c map[string]any) { c["m"] = "POST" })},
		{"body claim", header(asOwner, target, func(c map[string]any) { c["bh"] = assertion.BodyHash([]byte("x")) })},
		{"wrong audience", header(asOwner, target, func(c map[string]any) { c["aud"] = "clinic-api" })},
		{"expired", header(asOwner, target, func(c map[string]any) {
			c["iat"] = time.Now().Unix() - 300
			c["exp"] = time.Now().Unix() - 240
		})},
		{"lifetime too long", header(asOwner, target, func(c map[string]any) { c["exp"] = time.Now().Unix() + 600 })},
		{"no identity", header(other, target, func(c map[string]any) { delete(c, "email") })},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			expect(t, h.openRaw(target, tc.hdr), http.StatusUnauthorized, "UNAUTHENTICATED")
		})
	}
	if st := h.app.Store.Stats(); st.PoolOpen || st.Queries != 0 {
		t.Fatalf("the database was touched by unauthenticated requests: %+v", st)
	}
}

// The role in the assertion must be the one the database says the person holds right now.
func TestRoleIsCheckedAgainstTheDatabase(t *testing.T) {
	h := start(t, func(c *config.Config) { c.MaxStreamsPerInstance = 5; c.MaxStreamsPerPerson = 5 })
	target := "/stream"

	// A role that may never stream, even with a valid signature.
	expect(t, h.openRaw(target, header(who{"x@gateway-tests.org", "system"}, target, nil)), http.StatusForbidden, "FORBIDDEN")
	expect(t, h.openRaw(target, header(who{"x@gateway-tests.org", "smoke"}, target, nil)), http.StatusForbidden, "FORBIDDEN")

	// Signed as admin but the database has no row for this person.
	nobody := who{"nobody@gateway-tests.org", "admin"}
	expect(t, h.openRaw(target, header(nobody, target, nil)), http.StatusForbidden, "FORBIDDEN")

	// Signed as admin, the database says viewer: the claim does not win.
	testenv.GrantStaff(t, h.env, "demoted@gateway-tests.org", "viewer")
	expect(t, h.openRaw(target, header(who{"demoted@gateway-tests.org", "admin"}, target, nil)), http.StatusForbidden, "FORBIDDEN")

	// Claiming owner without being a configured owner.
	testenv.GrantStaff(t, h.env, "climber@gateway-tests.org", "admin")
	expect(t, h.openRaw(target, header(who{"climber@gateway-tests.org", "owner"}, target, nil)), http.StatusForbidden, "FORBIDDEN")

	// A revoked person.
	testenv.GrantStaff(t, h.env, "gone@gateway-tests.org", "admin")
	testenv.SetStaff(t, h.env, "gone@gateway-tests.org", "")
	expect(t, h.openRaw(target, header(who{"gone@gateway-tests.org", "admin"}, target, nil)), http.StatusForbidden, "FORBIDDEN")

	// The matching claims open the stream, including a configured owner (no staff_access row) and
	// an email in a different case.
	for _, w := range []who{asOwner, {"OWNER@Gateway-Tests.org", "owner"}, asAdmin, asView} {
		h.grant(w)
		s := h.openRaw(target, header(w, target, nil))
		if s.resp.StatusCode != http.StatusOK {
			t.Fatalf("%s refused: %d", w.role, s.resp.StatusCode)
		}
		s.close()
		waitFor(t, 3*time.Second, "slot to free", func() bool { return h.app.Gateway.Active() == 0 })
	}
}

// A revoke or a role change ends an open stream within ROLE_RECHECK.
func TestRevokeAndRoleChangeEndAnOpenStream(t *testing.T) {
	for _, change := range []struct{ name, to string }{{"revoke", ""}, {"downgrade", "viewer"}} {
		t.Run(change.name, func(t *testing.T) {
			h := start(t, func(c *config.Config) { c.RoleRecheck = 200 * time.Millisecond })
			s := h.hello(asAdmin, q())
			begin := time.Now()
			testenv.SetStaff(t, h.env, asAdmin.email, change.to)
			final, closed := closeAfter(t, s, 3*time.Second)
			if final.Event != "reconnect" || final.Data != `{"reason":"access_changed"}` {
				t.Fatalf("final = %+v", final)
			}
			if d := closed.Sub(begin); d > 2*time.Second {
				t.Fatalf("took %v to notice", d)
			}
			// And the reconnect is refused or reshaped by the database, not by the old claim.
			// Still signed as admin: refused, because the database no longer says admin.
			expect(t, h.open(asAdmin, q()), http.StatusForbidden, "FORBIDDEN")
		})
	}
}

func expectBody(t *testing.T, s *sse, code string) {
	t.Helper()
	_, c, _ := problem(t, s)
	if c != code {
		t.Fatalf("code = %s, want %s", c, code)
	}
}
