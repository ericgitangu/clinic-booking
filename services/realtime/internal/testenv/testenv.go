// Package testenv connects the integration tests to the real compose stack: real Postgres, the
// real clinic-api over HTTP. There are no fakes. A missing variable fails the test loudly; it is
// never a skip.
package testenv

import (
	"bytes"
	"context"
	crand "crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/assertion"
)

// Env is the stack under test.
type Env struct {
	OwnerDSN    string // compose superuser: staff rows and ordering tests
	RealtimeDSN string // the clinic_realtime role: what the gateway connects as
	APIURL      string
}

// Load reads the environment and checks the stack is the one the tests need.
func Load(t testing.TB) Env {
	t.Helper()
	e := Env{
		OwnerDSN:    os.Getenv("TEST_OWNER_DSN"),
		RealtimeDSN: os.Getenv("TEST_REALTIME_DSN"),
		APIURL:      os.Getenv("TEST_API_URL"),
	}
	for name, v := range map[string]string{
		"TEST_OWNER_DSN": e.OwnerDSN, "TEST_REALTIME_DSN": e.RealtimeDSN, "TEST_API_URL": e.APIURL,
	} {
		if v == "" {
			t.Fatalf("%s is not set: bring the compose stack up and use `make -C services/realtime test`", name)
		}
	}
	probeOnce.Do(func() { probeErr = e.probe() })
	if probeErr != nil {
		t.Fatalf("the stack is not migrated to the gateway's schema (alembic 0014): %v", probeErr)
	}
	return e
}

var (
	probeOnce sync.Once
	probeErr  error
)

// probe proves the real migration is in place: the gateway's login can read the cursor column.
func (e Env) probe() error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, e.RealtimeDSN)
	if err != nil {
		return fmt.Errorf("connect as the realtime role: %w", err)
	}
	defer func() { _ = conn.Close(ctx) }()
	var n int
	return conn.QueryRow(ctx, `SELECT count(*) FROM (SELECT id, txid FROM appointment_events LIMIT 1) s`).Scan(&n)
}

// Connect opens a single connection with the given DSN.
func Connect(t testing.TB, dsn string) *pgx.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer ccancel()
		_ = c.Close(cctx)
	})
	return c
}

// API is a thin client for the real clinic-api.
type API struct {
	t    testing.TB
	base string
	http *http.Client
}

// NewAPI returns a client for e.APIURL.
func (e Env) NewAPI(t testing.TB) *API {
	return &API{t: t, base: e.APIURL, http: &http.Client{Timeout: 20 * time.Second}}
}

// Staffer is a signed-in staff member as the admin app would describe them to the API.
type Staffer struct{ Email, Role string }

// Staff calls an /internal/admin route of the real API as s, with the assertion the admin app
// would sign (TEST_API_SIGNING_KEY is the API's INTERNAL_SIGNING_KEY). It fails the test on any
// other status than want.
func (a *API) Staff(s Staffer, method, path string, body any, want int, out any) {
	a.t.Helper()
	key := os.Getenv("TEST_API_SIGNING_KEY")
	if key == "" {
		a.t.Fatal("TEST_API_SIGNING_KEY is not set: it must equal the API's INTERNAL_SIGNING_KEY " +
			"(the staff-action tests drive the real staff routes)")
	}
	var raw []byte
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			a.t.Fatal(err)
		}
		raw = b
	}
	now := time.Now().Unix()
	header, err := assertion.Sign(map[string]any{
		"aud": assertion.Audience, "sub": "sub-" + s.Email, "email": s.Email, "role": s.Role,
		"iat": now, "exp": now + 60, "m": method, "p": path, "bh": assertion.BodyHash(raw), "ev": true,
	}, []byte(key))
	if err != nil {
		a.t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(context.Background(), method, a.base+path, bytes.NewReader(raw))
	if err != nil {
		a.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set(assertion.Header, header)
	req.Header.Set("Idempotency-Key", fmt.Sprintf("rt-staff-%d-%d", time.Now().UnixNano(), randN(1<<62)))
	resp, err := a.http.Do(req)
	if err != nil {
		a.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	got, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != want {
		a.t.Fatalf("%s %s as %s = %d, want %d: %s", method, path, s.Role, resp.StatusCode, want, got)
	}
	if out != nil {
		if err := json.Unmarshal(got, out); err != nil {
			a.t.Fatalf("decode %s: %v (%s)", path, err, got)
		}
	}
}

// Exec runs one statement as the database owner (for rows the API only writes inside a time
// window a test cannot rely on; see the callers).
func Exec(t testing.TB, env Env, sql string, args ...any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn := Connect(t, env.OwnerDSN)
	if _, err := conn.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("exec: %v", err)
	}
}

// Booking is what a test needs to know about an appointment it made.
type Booking struct {
	ID          string
	DoctorID    string
	PatientID   string
	PatientName string
	StartsAt    time.Time
}

func (a *API) do(method, path string, body any, want int, out any) {
	a.t.Helper()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			a.t.Fatal(err)
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(context.Background(), method, a.base+path, rd)
	if err != nil {
		a.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Idempotency-Key", fmt.Sprintf("rt-%d-%d", time.Now().UnixNano(), randN(1<<62)))
	resp, err := a.http.Do(req)
	if err != nil {
		a.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != want {
		a.t.Fatalf("%s %s = %d, want %d: %s", method, path, resp.StatusCode, want, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			a.t.Fatalf("decode %s: %v (%s)", path, err, raw)
		}
	}
}

// Doctor returns the first seeded doctor id.
func (a *API) Doctor() string {
	a.t.Helper()
	var out struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	a.do(http.MethodGet, "/doctors", nil, http.StatusOK, &out)
	if len(out.Items) == 0 {
		a.t.Fatal("no seeded doctors")
	}
	return out.Items[0].ID
}

// Patient creates a patient with unique contact details and returns its id and name.
func (a *API) Patient() (id, name string) {
	a.t.Helper()
	n := randN(1_000_000_000)
	name = fmt.Sprintf("Realtime Test %d", n)
	var out struct {
		ID string `json:"id"`
	}
	a.do(http.MethodPost, "/patients", map[string]any{
		"full_name": name,
		"email":     fmt.Sprintf("rt-%d@realtime-tests.org", n),
		"phone":     fmt.Sprintf("+2547%08d", n%100_000_000),
	}, http.StatusCreated, &out)
	return out.ID, name
}

// Slots returns the free slot starts for a doctor on a date.
func (a *API) slots(doctor, date string) []time.Time {
	a.t.Helper()
	var out struct {
		Slots []struct {
			StartsAt time.Time `json:"starts_at"`
		} `json:"slots"`
	}
	a.do(http.MethodGet, "/doctors/"+doctor+"/availability?date="+date, nil, http.StatusOK, &out)
	res := make([]time.Time, 0, len(out.Slots))
	for _, s := range out.Slots {
		res = append(res, s.StartsAt)
	}
	return res
}

// FreeSlot returns a free slot, on a day that still has another free slot, between 3 and 88
// days out (the API books 90 days ahead). The starting day is random so concurrent test runs
// rarely contend; it fails the test, rather than looping, when the calendar is full.
func (a *API) FreeSlot(doctor string) time.Time {
	a.t.Helper()
	return a.freeSlot(doctor, "")
}

func (a *API) freeSlot(doctor, excludeDate string) time.Time {
	a.t.Helper()
	const first, last = 3, 88
	start := first + int(randN(20))
	for i := 0; i <= last-first; i++ {
		off := first + (start-first+i)%(last-first+1)
		date := time.Now().UTC().AddDate(0, 0, off).Format(time.DateOnly)
		if date == excludeDate {
			continue
		}
		if slots := a.slots(doctor, date); len(slots) >= 2 {
			return slots[int(randN(int64(len(slots))))]
		}
	}
	a.t.Fatalf("no day with two free slots in days %d-%d (excluding %q): the stack's calendar is full", first, last, excludeDate)
	return time.Time{}
}

// Book makes a real booking through POST /appointments.
func (a *API) Book(doctor string) Booking {
	a.t.Helper()
	patient, name := a.Patient()
	return a.BookFor(doctor, patient, name)
}

// BookFor books a slot for an existing patient.
func (a *API) BookFor(doctor, patient, name string) Booking {
	a.t.Helper()
	start := a.FreeSlot(doctor)
	var out struct {
		ID string `json:"id"`
	}
	a.do(http.MethodPost, "/appointments", map[string]any{
		"doctor_id": doctor, "patient_id": patient, "starts_at": start.Format(time.RFC3339),
	}, http.StatusCreated, &out)
	// Free the slot again so a long-lived stack does not run out of calendar. A test that already
	// cancelled gets 409, which is fine here.
	a.t.Cleanup(func() { a.cancelIgnoringConflict(out.ID) })
	return Booking{ID: out.ID, DoctorID: doctor, PatientID: patient, PatientName: name, StartsAt: start}
}

func (a *API) cancelIgnoringConflict(id string) {
	body, err := json.Marshal(map[string]any{"reason": "realtime test cleanup"})
	if err != nil {
		a.t.Error(err)
		return
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPatch, a.base+"/appointments/"+id+"/cancel", bytes.NewReader(body))
	if err != nil {
		a.t.Error(err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.http.Do(req)
	if err != nil {
		a.t.Errorf("cleanup cancel: %v", err)
		return
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusConflict {
		a.t.Errorf("cleanup cancel = %d", resp.StatusCode)
	}
}

// Cancel cancels a booking through the API.
func (a *API) Cancel(b Booking, reason string) {
	a.t.Helper()
	a.do(http.MethodPatch, "/appointments/"+b.ID+"/cancel", map[string]any{"reason": reason}, http.StatusOK, nil)
}

// Reschedule moves a booking to another free slot and returns it. With crossDay the new slot is
// on a different calendar day, otherwise on the same day (clinic hours fall inside one UTC date
// for the Nairobi clinic, so the UTC date is the clinic-local date).
func (a *API) Reschedule(b Booking, crossDay bool) time.Time {
	a.t.Helper()
	var to time.Time
	if crossDay {
		to = a.freeSlot(b.DoctorID, b.StartsAt.UTC().Format(time.DateOnly))
	} else {
		for _, s := range a.slots(b.DoctorID, b.StartsAt.UTC().Format(time.DateOnly)) {
			if !s.Equal(b.StartsAt) {
				to = s
				break
			}
		}
		if to.IsZero() {
			a.t.Fatal("no second free slot on the booking's day")
		}
	}
	a.do(http.MethodPatch, "/appointments/"+b.ID+"/reschedule", map[string]any{"starts_at": to.Format(time.RFC3339)}, http.StatusOK, nil)
	return to
}

// randN returns a uniform value in [0, n). Test data only; crypto/rand keeps the linters quiet
// without suppressions and costs nothing here.
func randN(n int64) int64 {
	v, err := crand.Int(crand.Reader, big.NewInt(n))
	if err != nil {
		panic(err)
	}
	return v.Int64()
}

// GrantStaff gives an email a role in staff_access (as the database owner, like the API's own
// grant would) and restores "revoked" on cleanup, so a stack is left as it was found.
func GrantStaff(t testing.TB, env Env, email, role string) {
	t.Helper()
	exec := func(sql string, args ...any) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		conn, err := pgx.Connect(ctx, env.OwnerDSN)
		if err != nil {
			t.Fatalf("connect owner: %v", err)
		}
		defer func() { _ = conn.Close(ctx) }()
		if _, err := conn.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("staff_access: %v", err)
		}
	}
	exec(`INSERT INTO staff_access (email, role, granted_by) VALUES ($1, $2::staff_role, 'realtime-test')
	      ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, revoked_at = NULL`, email, role)
	t.Cleanup(func() { exec(`UPDATE staff_access SET revoked_at = now() WHERE email = $1`, email) })
}

// SetStaff changes or revokes a staff row mid-test. role "" revokes.
func SetStaff(t testing.TB, env Env, email, role string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn := Connect(t, env.OwnerDSN)
	var err error
	if role == "" {
		_, err = conn.Exec(ctx, `UPDATE staff_access SET revoked_at = now() WHERE email = $1`, email)
	} else {
		_, err = conn.Exec(ctx, `UPDATE staff_access SET role = $2::staff_role, revoked_at = NULL WHERE email = $1`, email, role)
	}
	if err != nil {
		t.Fatalf("staff_access: %v", err)
	}
}

// MarkSynthetic flags a patient as the release smoke's synthetic one.
func MarkSynthetic(t testing.TB, env Env, patientID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn := Connect(t, env.OwnerDSN)
	if _, err := conn.Exec(ctx, `UPDATE patients SET synthetic = true WHERE id = $1::uuid`, patientID); err != nil {
		t.Fatalf("mark synthetic: %v", err)
	}
}
