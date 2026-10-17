package gateway_test

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/config"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/testenv"
)

// docs/adr/0015: clinic_realtime reads nine columns of one table and nothing else. Every denial is
// SQLSTATE 42501 from the real database, not a code check.
func TestRealtimeRoleIsReadOnlyAndColumnScoped(t *testing.T) {
	env := testenv.Load(t)
	conn := testenv.Connect(t, env.RealtimeDSN)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var n int
	if err := conn.QueryRow(ctx,
		`SELECT count(*) FROM (SELECT id, txid, doctor_id, event_type, from_starts_at, to_starts_at,
		   local_date, from_local_date, occurred_at FROM appointment_events LIMIT 1) s`).Scan(&n); err != nil {
		t.Fatalf("the granted columns must be readable: %v", err)
	}

	denied := map[string]string{
		"appointment_id": `SELECT appointment_id FROM appointment_events LIMIT 1`,
		"select star":    `SELECT * FROM appointment_events LIMIT 1`,
		"patients":       `SELECT id FROM patients LIMIT 1`,
		"appointments":   `SELECT id FROM appointments LIMIT 1`,
		"doctors":        `SELECT id FROM doctors LIMIT 1`,
		"insert":         `INSERT INTO appointment_events (doctor_id) VALUES (gen_random_uuid())`,
		"update":         `UPDATE appointment_events SET event_type = 'booked'`,
		"delete":         `DELETE FROM appointment_events`,
		"truncate":       `TRUNCATE appointment_events`,
		"create table":   `CREATE TABLE rt_probe (id int)`,
		"alter table":    `ALTER TABLE appointment_events ADD COLUMN rt_probe int`,
		"drop table":     `DROP TABLE appointment_events`,
		"create role":    `CREATE ROLE rt_probe_role`,
	}
	for name, sql := range denied {
		_, err := conn.Exec(ctx, sql)
		var pg *pgconn.PgError
		if !errors.As(err, &pg) {
			t.Errorf("%s: expected a database error, got %v", name, err)
			continue
		}
		if pg.Code != "42501" {
			t.Errorf("%s: SQLSTATE %s (%s), want 42501", name, pg.Code, pg.Message)
		}
	}

	var super, createdb, createrole bool
	if err := conn.QueryRow(ctx,
		`SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user`).
		Scan(&super, &createdb, &createrole); err != nil {
		t.Fatal(err)
	}
	if super || createdb || createrole {
		t.Fatalf("role attributes: super=%v createdb=%v createrole=%v", super, createdb, createrole)
	}
}

// When the database refuses the gateway (here: a wrong password against the real server) the
// stream request fails cleanly before any SSE header, as a 503 problem, and holds no slot.
func TestDatabaseFailureIs503Problem(t *testing.T) {
	env := testenv.Load(t)
	h := start(t, func(c *config.Config) {
		c.DatabaseURL = "postgres://clinic_realtime:wrong-password@" + hostOf(env.RealtimeDSN) + "/clinic"
	})
	s := h.open(q(), nil)
	if s.resp.StatusCode != 503 {
		t.Fatalf("status = %d", s.resp.StatusCode)
	}
	if got := problemCode(t, s); got != "DB_UNAVAILABLE" {
		t.Fatalf("code = %s", got)
	}
	if st := h.app.Store.Stats(); st.PoolOpen || st.Leases != 0 || h.app.Gateway.Active() != 0 {
		t.Fatalf("failed connect leaked state: %+v", st)
	}
}

func hostOf(dsn string) string {
	cfg, err := pgconn.ParseConfig(dsn)
	if err != nil {
		return "127.0.0.1:5432"
	}
	return cfg.Host + ":" + strconv.Itoa(int(cfg.Port))
}
