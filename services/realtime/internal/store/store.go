// Package store reads appointment_events with the commit-safe cursor of docs/adr/0009. It is the
// only code that touches the database, and it only ever issues two SELECTs.
//
// The connection pool exists only while at least one stream holds a Lease: the first Acquire
// opens it, the last Release closes it, so an instance with no viewers holds no Neon connection
// and issues no query, and Neon can suspend.
package store

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/cursor"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/events"
)

// Rows with txid below the snapshot's xmin belong to transactions that have all finished, so
// they can no longer appear late. One statement keeps the horizon and the read consistent.
const pollSQL = `
SELECT id, txid::text, doctor_id::text, event_type, from_starts_at, to_starts_at,
       local_date, from_local_date, occurred_at
FROM appointment_events
WHERE txid < pg_snapshot_xmin(pg_current_snapshot())
  AND (txid, id) > ($1::text::xid8, $2::bigint)
ORDER BY txid, id
LIMIT $3`

const horizonSQL = `SELECT pg_snapshot_xmin(pg_current_snapshot())::text`

// Store owns the lazily opened pool.
type Store struct {
	url      string
	maxConns int32

	mu   sync.Mutex
	refs int
	pool *pgxpool.Pool

	queries atomic.Uint64
}

// New builds a Store. It does not connect.
func New(databaseURL string, maxConns int) *Store {
	return &Store{url: databaseURL, maxConns: int32(maxConns)} // #nosec G115 -- config.Validate bounds this to 1..2
}

// Lease is a reference to the open pool. Release exactly once.
type Lease struct {
	s    *Store
	pool *pgxpool.Pool
	once sync.Once
}

type counter struct{ n *atomic.Uint64 }

func (c counter) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	c.n.Add(1)
	return ctx
}

func (counter) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// Acquire opens the pool if this is the first lease. The pool is verified with a ping so a bad
// URL or role fails the stream request before any SSE header is written.
func (s *Store) Acquire(ctx context.Context) (*Lease, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pool == nil {
		cfg, err := pgxpool.ParseConfig(s.url)
		if err != nil {
			// The parse error can quote the URL, which carries the password: say nothing more.
			return nil, errors.New("database url is not parseable")
		}
		cfg.MaxConns = s.maxConns
		cfg.MinConns = 0
		cfg.MaxConnIdleTime = 30 * time.Second
		cfg.ConnConfig.Tracer = counter{&s.queries}
		pool, err := pgxpool.NewWithConfig(ctx, cfg)
		if err != nil {
			return nil, fmt.Errorf("open pool: %w", err)
		}
		if err := pool.Ping(ctx); err != nil {
			pool.Close()
			return nil, fmt.Errorf("ping: %w", err)
		}
		s.pool = pool
	}
	s.refs++
	return &Lease{s: s, pool: s.pool}, nil
}

// Release drops the reference and closes the pool when it was the last.
func (l *Lease) Release() {
	l.once.Do(func() {
		s := l.s
		s.mu.Lock()
		defer s.mu.Unlock()
		s.refs--
		if s.refs == 0 && s.pool != nil {
			s.pool.Close()
			s.pool = nil
		}
	})
}

// Horizon is the position "now": everything committed before it is behind it. A stream with no
// cursor starts here so it delivers only events that happen while it watches.
func (l *Lease) Horizon(ctx context.Context) (cursor.Cursor, error) {
	var txt string
	if err := l.pool.QueryRow(ctx, horizonSQL).Scan(&txt); err != nil {
		return cursor.Cursor{}, fmt.Errorf("horizon: %w", err)
	}
	txid, err := strconv.ParseUint(txt, 10, 64)
	if err != nil {
		return cursor.Cursor{}, fmt.Errorf("horizon: %w", err)
	}
	return cursor.Cursor{Txid: txid}, nil
}

// Poll returns up to limit rows after the cursor, in (txid, id) order, that are safe to deliver.
func (l *Lease) Poll(ctx context.Context, after cursor.Cursor, limit int) ([]events.Row, error) {
	rows, err := l.pool.Query(ctx, pollSQL, strconv.FormatUint(after.Txid, 10), after.ID, limit)
	if err != nil {
		return nil, fmt.Errorf("poll: %w", err)
	}
	defer rows.Close()
	out := make([]events.Row, 0, limit)
	for rows.Next() {
		var (
			r    events.Row
			txid string
		)
		if err := rows.Scan(&r.ID, &txid, &r.DoctorID, &r.EventType, &r.FromStartsAt, &r.ToStartsAt,
			&r.LocalDate, &r.FromLocalDate, &r.OccurredAt); err != nil {
			return nil, fmt.Errorf("poll scan: %w", err)
		}
		if r.Txid, err = strconv.ParseUint(txid, 10, 64); err != nil {
			return nil, fmt.Errorf("poll txid: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("poll rows: %w", err)
	}
	return out, nil
}

// Stats is a point-in-time view for tests and the shutdown log.
type Stats struct {
	PoolOpen bool
	Leases   int
	// Queries counts every statement sent over any pool this Store has ever opened.
	Queries uint64
}

// Stats reports pool state.
func (s *Store) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Stats{PoolOpen: s.pool != nil, Leases: s.refs, Queries: s.queries.Load()}
}
