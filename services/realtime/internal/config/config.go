// Package config reads the gateway's environment. Every limit that bounds cost is a setting
// with a safe default, validated at startup so a typo cannot silently lift a cap.
package config

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Config is the validated process configuration.
type Config struct {
	Port        string
	DatabaseURL string

	// SigningKey verifies the staff assertion (INTERNAL_SIGNING_KEY, the key the admin app and
	// the API share). OwnerEmails are the people who hold the owner role by configuration, not
	// by a staff_access row (ADMIN_EMAILS, the same variable the API reads).
	SigningKey []byte
	// SmokeKey, when set, lets the release pipeline open a stream with its own assertion
	// (SMOKE_SIGNING_KEY, role "smoke"). That identity sees only the release smoke's synthetic
	// events, in the viewer shape, and reads no staff_access row.
	SmokeKey    []byte
	OwnerEmails map[string]bool

	MaxStreamsPerInstance int
	MaxStreamsPerPerson   int

	PollInterval      time.Duration
	HeartbeatInterval time.Duration
	// MaxConnection is the hard server-side ceiling on one stream. A ticket's life claim can
	// only shorten it.
	MaxConnection time.Duration
	// Idle closes a stream that has delivered no appointment event for this long. Heartbeat
	// comments do not count as activity.
	Idle time.Duration
	// RoleRecheck is how often an open stream re-reads the person's role. A revoke or a role
	// change ends the stream within this interval.
	RoleRecheck time.Duration

	DBMaxConns      int
	ShutdownTimeout time.Duration
	ProblemsBaseURL string
}

// Lookup abstracts os.LookupEnv so tests need not touch the process environment.
type Lookup func(key string) (string, bool)

// Load parses and validates the environment.
func Load(get Lookup) (Config, error) {
	r := reader{get: get}
	c := Config{
		Port:                  r.str("PORT", "8080"),
		DatabaseURL:           r.str("DATABASE_URL", ""),
		SigningKey:            []byte(r.str("INTERNAL_SIGNING_KEY", "")),
		SmokeKey:              []byte(r.str("SMOKE_SIGNING_KEY", "")),
		OwnerEmails:           emails(r.str("ADMIN_EMAILS", "")),
		MaxStreamsPerInstance: r.integer("MAX_STREAMS_PER_INSTANCE", 1),
		MaxStreamsPerPerson:   r.integer("MAX_STREAMS_PER_PERSON", 1),
		PollInterval:          r.duration("POLL_INTERVAL", time.Second),
		HeartbeatInterval:     r.duration("HEARTBEAT_INTERVAL", 30*time.Second),
		MaxConnection:         r.duration("MAX_CONNECTION", 290*time.Second),
		Idle:                  r.duration("IDLE_TIMEOUT", 240*time.Second),
		RoleRecheck:           r.duration("ROLE_RECHECK", 30*time.Second),
		DBMaxConns:            r.integer("DB_MAX_CONNS", 2),
		ShutdownTimeout:       r.duration("SHUTDOWN_TIMEOUT", 8*time.Second),
		ProblemsBaseURL:       strings.TrimRight(r.str("PROBLEMS_BASE_URL", "https://clinic.invalid"), "/"),
	}
	if err := errors.Join(r.errs...); err != nil {
		return Config{}, err
	}
	if err := c.Validate(); err != nil {
		return Config{}, err
	}
	// The cost guard on heartbeats applies to the real process only; tests build a Config
	// directly and call Validate.
	if c.HeartbeatInterval < MinHeartbeat {
		return Config{}, fmt.Errorf("HEARTBEAT_INTERVAL must be at least %v (cost guard)", MinHeartbeat)
	}
	return c, nil
}

// MinHeartbeat is the floor for heartbeat comments: more frequent frames add nothing but traffic.
const MinHeartbeat = 25 * time.Second

func emails(csv string) map[string]bool {
	out := map[string]bool{}
	for _, e := range strings.Split(csv, ",") {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			out[e] = true
		}
	}
	return out
}

// Validate enforces the invariants the cost and security model relies on.
func (c Config) Validate() error {
	var errs []error
	add := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }
	if c.DatabaseURL == "" {
		add("DATABASE_URL is required")
	}
	if len(c.SigningKey) < 32 {
		add("INTERNAL_SIGNING_KEY must be at least 32 bytes")
	}
	if len(c.SmokeKey) > 0 && len(c.SmokeKey) < 32 {
		add("SMOKE_SIGNING_KEY must be at least 32 bytes when set")
	}
	if c.MaxStreamsPerInstance < 1 {
		add("MAX_STREAMS_PER_INSTANCE must be >= 1")
	}
	if c.MaxStreamsPerPerson < 1 {
		add("MAX_STREAMS_PER_PERSON must be >= 1")
	}
	if c.DBMaxConns < 1 || c.DBMaxConns > 2 {
		add("DB_MAX_CONNS must be 1 or 2 (at most 2 connections per instance)")
	}
	for name, d := range map[string]time.Duration{
		"POLL_INTERVAL": c.PollInterval, "HEARTBEAT_INTERVAL": c.HeartbeatInterval,
		"MAX_CONNECTION": c.MaxConnection, "IDLE_TIMEOUT": c.Idle, "SHUTDOWN_TIMEOUT": c.ShutdownTimeout,
		"ROLE_RECHECK": c.RoleRecheck,
	} {
		if d <= 0 {
			add("%s must be positive", name)
		}
	}
	return errors.Join(errs...)
}

type reader struct {
	get  Lookup
	errs []error
}

func (r *reader) str(key, def string) string {
	if v, ok := r.get(key); ok && v != "" {
		return v
	}
	return def
}

func (r *reader) integer(key string, def int) int {
	v := r.str(key, "")
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		r.errs = append(r.errs, fmt.Errorf("%s: %w", key, err))
		return def
	}
	return n
}

func (r *reader) duration(key string, def time.Duration) time.Duration {
	v := r.str(key, "")
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		r.errs = append(r.errs, fmt.Errorf("%s: %w", key, err))
		return def
	}
	return d
}
