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

	// AuthRequired makes every stream need a valid ticket (STREAM_AUTH_REQUIRED). False only for
	// local runs and CI, where the gateway ignores tickets.
	AuthRequired bool
	TicketKey    []byte
	Audience     string

	MaxStreamsPerInstance int
	MaxStreamsPerIP       int

	PollInterval      time.Duration
	HeartbeatInterval time.Duration
	// MaxConnection is the hard server-side ceiling on one stream. A ticket's life claim can
	// only shorten it.
	MaxConnection time.Duration
	// Idle closes a stream that has delivered no appointment event for this long. Heartbeat
	// comments do not count as activity.
	Idle time.Duration

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
		AuthRequired:          r.boolean("STREAM_AUTH_REQUIRED", false),
		TicketKey:             []byte(r.str("STREAM_TICKET_KEY", "")),
		Audience:              r.str("TICKET_AUDIENCE", "clinic-realtime"),
		MaxStreamsPerInstance: r.integer("MAX_STREAMS_PER_INSTANCE", 1),
		MaxStreamsPerIP:       r.integer("MAX_STREAMS_PER_IP", 3),
		PollInterval:          r.duration("POLL_INTERVAL", time.Second),
		HeartbeatInterval:     r.duration("HEARTBEAT_INTERVAL", 15*time.Second),
		MaxConnection:         r.duration("MAX_CONNECTION", 290*time.Second),
		Idle:                  r.duration("IDLE_TIMEOUT", 60*time.Second),
		DBMaxConns:            r.integer("DB_MAX_CONNS", 2),
		ShutdownTimeout:       r.duration("SHUTDOWN_TIMEOUT", 8*time.Second),
		ProblemsBaseURL:       strings.TrimRight(r.str("PROBLEMS_BASE_URL", "https://clinic.invalid"), "/"),
	}
	if err := errors.Join(r.errs...); err != nil {
		return Config{}, err
	}
	return c, c.Validate()
}

// Validate enforces the invariants the cost and security model relies on.
func (c Config) Validate() error {
	var errs []error
	add := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }
	if c.DatabaseURL == "" {
		add("DATABASE_URL is required")
	}
	if c.AuthRequired && len(c.TicketKey) < 32 {
		add("STREAM_TICKET_KEY must be at least 32 bytes when STREAM_AUTH_REQUIRED is true")
	}
	if c.MaxStreamsPerInstance < 1 {
		add("MAX_STREAMS_PER_INSTANCE must be >= 1")
	}
	if c.MaxStreamsPerIP < 1 {
		add("MAX_STREAMS_PER_IP must be >= 1")
	}
	if c.DBMaxConns < 1 || c.DBMaxConns > 2 {
		add("DB_MAX_CONNS must be 1 or 2 (docs/adr/0014: at most 2 connections per instance)")
	}
	for name, d := range map[string]time.Duration{
		"POLL_INTERVAL": c.PollInterval, "HEARTBEAT_INTERVAL": c.HeartbeatInterval,
		"MAX_CONNECTION": c.MaxConnection, "IDLE_TIMEOUT": c.Idle, "SHUTDOWN_TIMEOUT": c.ShutdownTimeout,
	} {
		if d <= 0 {
			add("%s must be positive", name)
		}
	}
	if c.Idle > c.MaxConnection {
		add("IDLE_TIMEOUT must not exceed MAX_CONNECTION")
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

func (r *reader) boolean(key string, def bool) bool {
	v := r.str(key, "")
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		r.errs = append(r.errs, fmt.Errorf("%s: %w", key, err))
		return def
	}
	return b
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
