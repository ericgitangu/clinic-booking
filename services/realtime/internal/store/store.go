// Package store reads the event stream (appointment_events and the streamed staff actions of
// staff_action_audit) with the commit-safe cursor of docs/adr/0009. It is the only code that
// touches the database, and it only ever issues SELECTs.
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
	"strings"
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
//
// The stream is the union of appointment_events and the staff actions that change no appointment
// (staff_action_audit), ordered by (txid, id) with ONE cursor: the audit row's stream_id is drawn
// from the event log's sequence (migration 0014), so the two never share an id.
//
// $1, $2 = cursor, $3 = limit, $4 = appointment filter (NULL for the whole clinic). The filter also
// matches the successor a veto books for a cancelled appointment (predecessor_id).
//
// Two variants. The viewer's never selects a personal column (no name, no reason, no address, no
// actor): it joins patients only to learn whether the patient is the release smoke's synthetic
// one, whose events staff do not see. The role CAN read those columns (migration 0014); this query
// is where the minimisation is enforced, and TestViewerSQLSelectsNoPersonalColumn keeps it so.
const viewerSQL = `
WITH h AS (SELECT pg_snapshot_xmin(pg_current_snapshot()) AS xmin)
SELECT u.src, u.id, u.txid::text, u.kind, u.doctor_id, u.from_starts_at, u.to_starts_at,
       u.local_date, u.from_local_date, u.starts_at, u.delay_minutes, u.synthetic
FROM (
  SELECT 'event' AS src, e.id, e.txid, e.event_type AS kind, e.doctor_id::text AS doctor_id,
         e.from_starts_at, e.to_starts_at, e.local_date, e.from_local_date,
         NULL::timestamptz AS starts_at, NULL::int AS delay_minutes,
         COALESCE(p.synthetic, false) AS synthetic
  FROM appointment_events e
  CROSS JOIN h
  LEFT JOIN appointments a ON a.id = e.appointment_id
  LEFT JOIN patients p ON p.id = a.patient_id
  WHERE e.txid < h.xmin
    AND (e.txid, e.id) > ($1::text::xid8, $2::bigint)
    AND ($4::uuid IS NULL OR e.appointment_id = $4::uuid OR a.predecessor_id = $4::uuid)
  UNION ALL
  SELECT 'action', s.stream_id, s.txid, s.action, a.doctor_id::text,
         NULL, NULL, NULL, NULL, a.starts_at,
         CASE WHEN s.after ->> 'delay_minutes' ~ '^[0-9]{1,4}$'
              THEN (s.after ->> 'delay_minutes')::int END,
         COALESCE(p.synthetic, false)
  FROM staff_action_audit s
  CROSS JOIN h
  LEFT JOIN appointments a ON a.id = s.appointment_id
  LEFT JOIN patients p ON p.id = a.patient_id
  WHERE s.action = ANY($5::text[])
    AND s.txid < h.xmin
    AND (s.txid, s.stream_id) > ($1::text::xid8, $2::bigint)
    AND ($4::uuid IS NULL OR s.appointment_id = $4::uuid)
) u
ORDER BY u.txid, u.id
LIMIT $3`

// staffSQL adds the appointment, the patient's name, a cancellation reason, and for a staff change
// who made it and why: the audit row the API writes in the same transaction as the event.
const staffSQL = `
WITH h AS (SELECT pg_snapshot_xmin(pg_current_snapshot()) AS xmin)
SELECT u.src, u.id, u.txid::text, u.kind, u.doctor_id, u.from_starts_at, u.to_starts_at,
       u.local_date, u.from_local_date, u.starts_at, u.delay_minutes, u.synthetic,
       u.appointment_id, u.patient_name, u.cancellation_reason, u.actor_email, u.actor_role,
       u.reason, u.invite_email, u.invite_role
FROM (
  SELECT 'event' AS src, e.id, e.txid, e.event_type AS kind, e.doctor_id::text AS doctor_id,
         e.from_starts_at, e.to_starts_at, e.local_date, e.from_local_date,
         NULL::timestamptz AS starts_at, NULL::int AS delay_minutes,
         COALESCE(p.synthetic, false) AS synthetic,
         COALESCE(e.appointment_id::text, '') AS appointment_id,
         COALESCE(p.full_name, '') AS patient_name, a.cancellation_reason,
         sa.actor_email, sa.actor_role, sa.reason,
         NULL::text AS invite_email, NULL::text AS invite_role
  FROM appointment_events e
  CROSS JOIN h
  LEFT JOIN appointments a ON a.id = e.appointment_id
  LEFT JOIN patients p ON p.id = a.patient_id
  LEFT JOIN LATERAL (
    SELECT x.actor_email, x.actor_role::text AS actor_role, x.reason
    FROM staff_action_audit x
    WHERE e.actor = 'staff' AND x.appointment_id = e.appointment_id AND x.txid = e.txid
      AND x.action IN ('book', 'reschedule', 'cancel', 'veto', 'unlock', 'arrived', 'no_show')
    ORDER BY x.stream_id
    LIMIT 1
  ) sa ON true
  WHERE e.txid < h.xmin
    AND (e.txid, e.id) > ($1::text::xid8, $2::bigint)
    AND ($4::uuid IS NULL OR e.appointment_id = $4::uuid OR a.predecessor_id = $4::uuid)
  UNION ALL
  SELECT 'action', s.stream_id, s.txid, s.action, a.doctor_id::text,
         NULL, NULL, NULL, NULL, a.starts_at,
         CASE WHEN s.after ->> 'delay_minutes' ~ '^[0-9]{1,4}$'
              THEN (s.after ->> 'delay_minutes')::int END,
         COALESCE(p.synthetic, false),
         COALESCE(s.appointment_id::text, ''), COALESCE(p.full_name, ''), NULL,
         s.actor_email, s.actor_role::text, s.reason, i.email::text, i.role::text
  FROM staff_action_audit s
  CROSS JOIN h
  LEFT JOIN appointments a ON a.id = s.appointment_id
  LEFT JOIN patients p ON p.id = a.patient_id
  LEFT JOIN staff_invites i
    ON s.after ->> 'invite_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND i.id = (s.after ->> 'invite_id')::uuid
  WHERE s.action = ANY($5::text[])
    AND s.txid < h.xmin
    AND (s.txid, s.stream_id) > ($1::text::xid8, $2::bigint)
    AND ($4::uuid IS NULL OR s.appointment_id = $4::uuid)
) u
ORDER BY u.txid, u.id
LIMIT $3`

const horizonSQL = `SELECT pg_snapshot_xmin(pg_current_snapshot())::text`

// The role an email holds right now, read fresh each time, never cached (see Role).
const roleSQL = `SELECT role::text FROM staff_access WHERE email = $1::citext AND revoked_at IS NULL`

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
// staff selects the query that also reads the personal columns. appointment, when not "", limits
// the rows to that appointment (and a successor a veto booked for it); the caller validates it.
func (l *Lease) Poll(ctx context.Context, after cursor.Cursor, limit int, staff bool, appointment string) ([]events.Row, error) {
	sql := viewerSQL
	if staff {
		sql = staffSQL
	}
	var filter *string
	if appointment != "" {
		filter = &appointment
	}
	rows, err := l.pool.Query(ctx, sql, strconv.FormatUint(after.Txid, 10), after.ID, limit, filter,
		events.StreamedActions())
	if err != nil {
		return nil, fmt.Errorf("poll: %w", err)
	}
	defer rows.Close()
	out := make([]events.Row, 0, limit)
	for rows.Next() {
		var (
			r         events.Row
			txid      string
			doctor    *string
			localDate *time.Time
		)
		dest := []any{&r.Source, &r.ID, &txid, &r.EventType, &doctor, &r.FromStartsAt, &r.ToStartsAt,
			&localDate, &r.FromLocalDate, &r.StartsAt, &r.DelayMinutes, &r.Synthetic}
		if staff {
			dest = append(dest, &r.AppointmentID, &r.PatientName, &r.CancellationReason, &r.ActorEmail,
				&r.ActorRole, &r.Reason, &r.InviteEmail, &r.InviteRole)
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, fmt.Errorf("poll scan: %w", err)
		}
		if r.Txid, err = strconv.ParseUint(txid, 10, 64); err != nil {
			return nil, fmt.Errorf("poll txid: %w", err)
		}
		if doctor != nil {
			r.DoctorID = *doctor
		}
		if localDate != nil {
			r.LocalDate = *localDate
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("poll rows: %w", err)
	}
	return out, nil
}

// Role returns the role the email holds in staff_access right now, or "" when it holds none
// (never granted, or revoked). The owner is not a row; the caller adds the configured owners.
func (l *Lease) Role(ctx context.Context, email string) (string, error) {
	var role string
	err := l.pool.QueryRow(ctx, roleSQL, strings.ToLower(strings.TrimSpace(email))).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("role: %w", err)
	}
	return role, nil
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
