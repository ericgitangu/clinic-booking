package config_test

import (
	"strings"
	"testing"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/config"
)

func env(m map[string]string) config.Lookup {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func TestDefaultsAreTheAdrValues(t *testing.T) {
	c, err := config.Load(env(map[string]string{"DATABASE_URL": "postgres://x"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.MaxStreamsPerInstance != 1 || c.MaxConnection != 290*time.Second || c.Idle != 60*time.Second ||
		c.HeartbeatInterval != 15*time.Second || c.PollInterval != time.Second || c.DBMaxConns != 2 || c.AuthRequired {
		t.Fatalf("unexpected defaults: %+v", c)
	}
}

func TestRejects(t *testing.T) {
	base := map[string]string{"DATABASE_URL": "postgres://x"}
	with := func(k, v string) map[string]string {
		m := map[string]string{}
		for a, b := range base {
			m[a] = b
		}
		m[k] = v
		return m
	}
	cases := map[string]map[string]string{
		"DATABASE_URL":                 {},
		"STREAM_TICKET_KEY":            with("STREAM_AUTH_REQUIRED", "true"),
		"MAX_STREAMS_PER_INSTANCE":     with("MAX_STREAMS_PER_INSTANCE", "0"),
		"DB_MAX_CONNS":                 with("DB_MAX_CONNS", "3"),
		"IDLE_TIMEOUT must not exceed": with("IDLE_TIMEOUT", "400s"),
		"POLL_INTERVAL":                with("POLL_INTERVAL", "soon"),
		"STREAM_AUTH_REQUIRED":         with("STREAM_AUTH_REQUIRED", "maybe"),
	}
	for want, m := range cases {
		if _, err := config.Load(env(m)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err = %v", want, err)
		}
	}
}
