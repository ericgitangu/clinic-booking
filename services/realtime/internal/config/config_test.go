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
	c, err := config.Load(env(map[string]string{"DATABASE_URL": "postgres://x", "INTERNAL_SIGNING_KEY": strings.Repeat("k", 32)}))
	if err != nil {
		t.Fatal(err)
	}
	if c.MaxStreamsPerInstance != 1 || c.MaxConnection != 290*time.Second || c.Idle != 240*time.Second ||
		c.HeartbeatInterval != 30*time.Second || c.PollInterval != time.Second || c.DBMaxConns != 2 || c.MaxStreamsPerPerson != 1 {
		t.Fatalf("unexpected defaults: %+v", c)
	}
}

func TestRejects(t *testing.T) {
	base := map[string]string{"DATABASE_URL": "postgres://x", "INTERNAL_SIGNING_KEY": strings.Repeat("k", 32)}
	with := func(k, v string) map[string]string {
		m := map[string]string{}
		for a, b := range base {
			m[a] = b
		}
		m[k] = v
		return m
	}
	cases := map[string]map[string]string{
		"DATABASE_URL":               {"INTERNAL_SIGNING_KEY": strings.Repeat("k", 32)},
		"INTERNAL_SIGNING_KEY":       with("INTERNAL_SIGNING_KEY", "short"),
		"HEARTBEAT_INTERVAL must be": with("HEARTBEAT_INTERVAL", "5s"),
		"MAX_STREAMS_PER_PERSON":     with("MAX_STREAMS_PER_PERSON", "0"),
		"MAX_STREAMS_PER_INSTANCE":   with("MAX_STREAMS_PER_INSTANCE", "0"),
		"DB_MAX_CONNS":               with("DB_MAX_CONNS", "3"),
		"IDLE_TIMEOUT":               with("IDLE_TIMEOUT", "0s"),
		"POLL_INTERVAL":              with("POLL_INTERVAL", "soon"),
		"ROLE_RECHECK":               with("ROLE_RECHECK", "0s"),
	}
	for want, m := range cases {
		if _, err := config.Load(env(m)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err = %v", want, err)
		}
	}
}

func TestOwnersAreLowercasedAndTrimmed(t *testing.T) {
	c, err := config.Load(env(map[string]string{
		"DATABASE_URL": "postgres://x", "INTERNAL_SIGNING_KEY": strings.Repeat("k", 32),
		"ADMIN_EMAILS": " Owner@Example.com , ,second@example.com",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if len(c.OwnerEmails) != 2 || !c.OwnerEmails["owner@example.com"] || !c.OwnerEmails["second@example.com"] {
		t.Fatalf("owners = %v", c.OwnerEmails)
	}
}
