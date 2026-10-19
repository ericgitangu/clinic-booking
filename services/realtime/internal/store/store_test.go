package store_test

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/cursor"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/store"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/testenv"
)

// Many streams opening and closing at once must leave the pool exactly as they found it: open
// while any lease is held, closed when the last is released, never leaked or double-closed.
func TestPoolLifecycleUnderConcurrency(t *testing.T) {
	env := testenv.Load(t)
	s := store.New(env.RealtimeDSN, 2)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	for range 40 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			l, err := s.Acquire(ctx)
			if err != nil {
				t.Error(err)
				return
			}
			if _, err := l.Horizon(ctx); err != nil {
				t.Error(err)
			}
			l.Release()
			l.Release() // double release must be harmless
		}()
	}
	wg.Wait()
	if st := s.Stats(); st.PoolOpen || st.Leases != 0 {
		t.Fatalf("after all leases released: %+v", st)
	}
	if s.Stats().Queries == 0 {
		t.Fatal("query counter did not move: the tracer is not wired")
	}
}

func TestHorizonAndPollAgainstTheRealTable(t *testing.T) {
	env := testenv.Load(t)
	s := store.New(env.RealtimeDSN, 2)
	ctx := context.Background()
	l, err := s.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Release()

	h, err := l.Horizon(ctx)
	if err != nil || h.Txid == 0 || h.ID != 0 {
		t.Fatalf("horizon = %v, %v", h, err)
	}
	// Everything at or before the horizon is behind it; polling from zero returns ordered rows.
	rows, err := l.Poll(ctx, cursor.Cursor{}, 50, false, "")
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i < len(rows); i++ {
		if !rows[i-1].Cursor().Less(rows[i].Cursor()) {
			t.Fatalf("rows not strictly ordered at %d: %v then %v", i, rows[i-1].Cursor(), rows[i].Cursor())
		}
	}
	// The horizon only moves forward, so every row returned is strictly behind a later horizon.
	h2, err := l.Horizon(ctx)
	if err != nil || h2.Txid < h.Txid {
		t.Fatalf("horizon went backwards: %v then %v (%v)", h, h2, err)
	}
	for _, r := range rows {
		if r.Txid >= h2.Txid {
			t.Fatalf("row %v is not behind the horizon %v", r.Cursor(), h2)
		}
	}
}

func TestAcquireWithBadURLNeverLeaksThePassword(t *testing.T) {
	s := store.New("postgres://user:s3cret-pass@127.0.0.1:1/x?sslmode=bogus%zz", 1)
	_, err := s.Acquire(context.Background())
	if err == nil {
		t.Fatal("expected an error")
	}
	if msg := err.Error(); strings.Contains(msg, "s3cret-pass") {
		t.Fatalf("error leaks the password: %s", msg)
	}
	if st := s.Stats(); st.PoolOpen || st.Leases != 0 {
		t.Fatalf("failed acquire left state: %+v", st)
	}
}

func TestRoleLookupReadsStaffAccessFresh(t *testing.T) {
	env := testenv.Load(t)
	testenv.GrantStaff(t, env, "lookup@store-tests.org", "viewer")
	s := store.New(env.RealtimeDSN, 2)
	ctx := context.Background()
	l, err := s.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Release()
	if got, err := l.Role(ctx, "  Lookup@Store-Tests.org "); err != nil || got != "viewer" {
		t.Fatalf("role = %q, %v", got, err)
	}
	testenv.SetStaff(t, env, "lookup@store-tests.org", "admin")
	if got, _ := l.Role(ctx, "lookup@store-tests.org"); got != "admin" {
		t.Fatalf("a change must show at once, got %q", got)
	}
	testenv.SetStaff(t, env, "lookup@store-tests.org", "")
	if got, _ := l.Role(ctx, "lookup@store-tests.org"); got != "" {
		t.Fatalf("a revoked person holds no role, got %q", got)
	}
	if got, _ := l.Role(ctx, "never@store-tests.org"); got != "" {
		t.Fatalf("an unknown person holds no role, got %q", got)
	}
}
