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
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Env is the stack under test.
type Env struct {
	OwnerDSN    string // compose superuser: used to set up and to write rows in ordering tests
	RealtimeDSN string // the clinic_realtime role: what the gateway connects as
	AppDSN      string // the clinic_app role: reads a booking back, proves the API wrote the row
	APIURL      string
}

var (
	setupOnce sync.Once
	setupErr  error
	setupMode string
)

// Load reads the environment and applies the stand-in schema once per test binary.
func Load(t testing.TB) Env {
	t.Helper()
	e := Env{
		OwnerDSN:    os.Getenv("TEST_OWNER_DSN"),
		RealtimeDSN: os.Getenv("TEST_REALTIME_DSN"),
		AppDSN:      os.Getenv("TEST_APP_DSN"),
		APIURL:      os.Getenv("TEST_API_URL"),
	}
	for name, v := range map[string]string{
		"TEST_OWNER_DSN": e.OwnerDSN, "TEST_REALTIME_DSN": e.RealtimeDSN,
		"TEST_APP_DSN": e.AppDSN, "TEST_API_URL": e.APIURL,
	} {
		if v == "" {
			t.Fatalf("%s is not set: bring the compose stack up and use `make -C services/realtime test`", name)
		}
	}
	setupOnce.Do(func() { setupMode, setupErr = e.applySetup() })
	if setupErr != nil {
		t.Fatalf("test schema setup: %v", setupErr)
	}
	t.Logf("schema source: %s", setupMode)
	return e
}

func (e Env) applySetup() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, e.OwnerDSN)
	if err != nil {
		return "", fmt.Errorf("connect owner: %w", err)
	}
	defer func() { _ = conn.Close(ctx) }()

	var has bool
	if err := conn.QueryRow(ctx, `SELECT EXISTS (SELECT FROM information_schema.columns
		WHERE table_name = 'appointment_events' AND column_name = 'txid')`).Scan(&has); err != nil {
		return "", err
	}
	if has {
		return "migrated database (txid column already present; stand-in not applied)", nil
	}
	_, here, _, _ := runtime.Caller(0)
	sql, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "testdata", "realtime-setup.sql"))
	if err != nil {
		return "", err
	}
	if _, err := conn.Exec(ctx, string(sql)); err != nil {
		return "", fmt.Errorf("apply stand-in: %w", err)
	}
	return "testdata/realtime-setup.sql (stand-in for lane L1's migration)", nil
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

// Booking is what a test needs to know about an appointment it made.
type Booking struct {
	ID        string
	DoctorID  string
	PatientID string
	StartsAt  time.Time
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

// Patient creates a patient with unique contact details.
func (a *API) Patient() string {
	a.t.Helper()
	n := randN(1_000_000_000)
	var out struct {
		ID string `json:"id"`
	}
	a.do(http.MethodPost, "/patients", map[string]any{
		"full_name": fmt.Sprintf("Realtime Test %d", n),
		"email":     fmt.Sprintf("rt-%d@realtime-tests.org", n),
		"phone":     fmt.Sprintf("+2547%08d", n%100_000_000),
	}, http.StatusCreated, &out)
	return out.ID
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
	patient := a.Patient()
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
	return Booking{ID: out.ID, DoctorID: doctor, PatientID: patient, StartsAt: start}
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
func (a *API) Cancel(b Booking) {
	a.t.Helper()
	a.do(http.MethodPatch, "/appointments/"+b.ID+"/cancel", map[string]any{"reason": "realtime test"}, http.StatusOK, nil)
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
