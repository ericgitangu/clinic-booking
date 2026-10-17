package events_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/events"
)

const schemaPath = "../../testdata/appointment-event.v1.schema.json"

func schema(t *testing.T) (*jsonschema.Schema, map[string]any) {
	t.Helper()
	raw, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	c := jsonschema.NewCompiler()
	c.AssertFormat()
	if err := c.AddResource("s.json", doc); err != nil {
		t.Fatal(err)
	}
	s, err := c.Compile("s.json")
	if err != nil {
		t.Fatal(err)
	}
	return s, doc
}

func day(s string) time.Time {
	d, err := time.Parse(time.DateOnly, s)
	if err != nil {
		panic(err)
	}
	return d
}

func at(s string) *time.Time {
	v, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return &v
}

func TestEncodeMatchesSchemaForEveryType(t *testing.T) {
	s, _ := schema(t)
	from := day("2026-10-20")
	rows := []events.Row{
		{Txid: 9, ID: 1, DoctorID: "e52e9da0-f7f3-5a6a-93d3-d7f658947afa", EventType: "booked",
			ToStartsAt: at("2026-10-20T09:00:00+03:00"), LocalDate: day("2026-10-20"), OccurredAt: time.Now()},
		{Txid: 9, ID: 2, DoctorID: "e52e9da0-f7f3-5a6a-93d3-d7f658947afa", EventType: "cancelled",
			FromStartsAt: at("2026-10-20T09:00:00+03:00"), LocalDate: day("2026-10-20"), OccurredAt: time.Now()},
		{Txid: 9, ID: 3, DoctorID: "e52e9da0-f7f3-5a6a-93d3-d7f658947afa", EventType: "rescheduled",
			FromStartsAt: at("2026-10-20T09:00:00+03:00"), ToStartsAt: at("2026-10-21T10:00:00+03:00"),
			LocalDate: day("2026-10-21"), FromLocalDate: &from, OccurredAt: time.Now()},
	}
	wantNames := []string{"appointment.booked", "appointment.cancelled", "appointment.rescheduled"}
	for i, r := range rows {
		name, data, err := events.Encode(r)
		if err != nil {
			t.Fatal(err)
		}
		if name != wantNames[i] {
			t.Fatalf("name = %s", name)
		}
		var v any
		if err := json.Unmarshal(data, &v); err != nil {
			t.Fatal(err)
		}
		if err := s.Validate(v); err != nil {
			t.Fatalf("%s: %v\n%s", name, err, data)
		}
		if !strings.Contains(string(data), "Z") || strings.Contains(string(data), "+03:00") {
			t.Fatalf("timestamps must be UTC: %s", data)
		}
	}
}

func TestEncodeRejectsUnknownType(t *testing.T) {
	_, _, err := events.Encode(events.Row{EventType: "deleted", LocalDate: day("2026-10-20")})
	if err == nil {
		t.Fatal("unknown event_type was encoded")
	}
}

// The schema is the PHI boundary: its property list is exactly the allowed set, closed to
// additions, and the Go payload emits exactly those keys.
func TestSchemaPropertiesAreExactlyTheAllowedNonPIISet(t *testing.T) {
	_, doc := schema(t)
	props := doc["properties"].(map[string]any)
	got := make([]string, 0, len(props))
	for k := range props {
		got = append(got, k)
	}
	slices.Sort(got)
	want := []string{"doctor_id", "from_local_date", "from_starts_at", "local_date", "occurred_at",
		"schema_version", "to_starts_at", "type"}
	if !slices.Equal(got, want) {
		t.Fatalf("schema properties = %v, want %v", got, want)
	}
	if doc["additionalProperties"] != false {
		t.Fatal("schema must set additionalProperties: false")
	}
	_, data, _ := events.Encode(events.Row{EventType: "booked", LocalDate: day("2026-10-20"), OccurredAt: time.Now()})
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	if !slices.Equal(keys, want) {
		t.Fatalf("payload keys = %v, want %v", keys, want)
	}
}

func TestSchemaExamplesValidate(t *testing.T) {
	s, doc := schema(t)
	examples := doc["examples"].([]any)
	if len(examples) != 3 {
		t.Fatalf("want one example per event type, have %d", len(examples))
	}
	for i, ex := range examples {
		if err := s.Validate(ex); err != nil {
			t.Fatalf("example %d: %v", i, err)
		}
	}
	bad := map[string]any{"schema_version": 1, "appointment_id": "x"}
	if err := s.Validate(bad); err == nil {
		t.Fatal("schema accepted a payload carrying appointment_id")
	}
}

// Once lane L1 lands contracts/events/, that file is the source of truth and the copy used by
// these tests must not drift from it. Until then there is nothing to compare against, which this
// test says out loud instead of skipping.
func TestSchemaMatchesSharedContractWhenPresent(t *testing.T) {
	shared := "../../../../contracts/events/appointment-event.v1.schema.json"
	b, err := os.ReadFile(shared)
	if errors.Is(err, os.ErrNotExist) {
		t.Log("contracts/events/appointment-event.v1.schema.json is not in the tree yet: drift check inactive (dependency on lane L1)")
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	mine, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(b, mine) {
		t.Fatal("services/realtime/testdata/appointment-event.v1.schema.json differs from contracts/events/appointment-event.v1.schema.json: update the copy")
	}
}
