package events_test

import (
	"bytes"
	"encoding/json"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/events"
)

const dir = "../../../../contracts/events/"

type exampleCase struct {
	Name string `json:"name"`
	Row  struct {
		Txid               uint64  `json:"txid"`
		ID                 int64   `json:"id"`
		DoctorID           string  `json:"doctor_id"`
		AppointmentID      string  `json:"appointment_id"`
		PatientName        string  `json:"patient_name"`
		CancellationReason *string `json:"cancellation_reason"`
		EventType          string  `json:"event_type"`
		FromStartsAt       *string `json:"from_starts_at"`
		ToStartsAt         *string `json:"to_starts_at"`
		LocalDate          string  `json:"local_date"`
		FromLocalDate      *string `json:"from_local_date"`
		ActorEmail         *string `json:"actor_email"`
		ActorRole          *string `json:"actor_role"`
		StaffReason        *string `json:"staff_reason"`
	} `json:"row"`
	Viewer json.RawMessage `json:"viewer"`
	Staff  json.RawMessage `json:"staff"`
}

func examples(t *testing.T) []exampleCase {
	t.Helper()
	raw, err := os.ReadFile(dir + "examples.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases []exampleCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Cases) < 4 {
		t.Fatalf("only %d shared examples", len(doc.Cases))
	}
	return doc.Cases
}

func schemaOf(t *testing.T, file string) (*jsonschema.Schema, map[string]any) {
	t.Helper()
	raw, err := os.ReadFile(dir + file) // #nosec G304 -- fixed contract file names in this repository
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

func parse(s *string) *time.Time {
	if s == nil {
		return nil
	}
	v, err := time.Parse(time.RFC3339Nano, *s)
	if err != nil {
		panic(err)
	}
	return &v
}

func row(c exampleCase) events.Row {
	r := c.Row
	ld, _ := time.Parse(time.DateOnly, r.LocalDate)
	var fld *time.Time
	if r.FromLocalDate != nil {
		v, _ := time.Parse(time.DateOnly, *r.FromLocalDate)
		fld = &v
	}
	return events.Row{
		Txid: r.Txid, ID: r.ID, DoctorID: r.DoctorID, EventType: r.EventType,
		FromStartsAt: parse(r.FromStartsAt), ToStartsAt: parse(r.ToStartsAt),
		LocalDate: ld, FromLocalDate: fld, OccurredAt: time.Now(),
		AppointmentID: r.AppointmentID, PatientName: r.PatientName, CancellationReason: r.CancellationReason,
		ActorEmail: r.ActorEmail, ActorRole: r.ActorRole, Reason: r.StaffReason,
	}
}

func equalJSON(t *testing.T, got, want []byte) {
	t.Helper()
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatal(err)
	}
	gb, _ := json.Marshal(g)
	wb, _ := json.Marshal(w)
	if !bytes.Equal(gb, wb) {
		t.Fatalf("got  %s\nwant %s", gb, wb)
	}
}

// The contract test shared with the Python relay: the same rows, the same expected messages. The
// Python side asserts messages_for(row) equals "viewer"; here Encode must produce "viewer" and
// "staff" from the same row, and both must validate against the exported JSON Schemas.
func TestEncodeMatchesTheSharedExamplesAndSchemas(t *testing.T) {
	viewerSchema, _ := schemaOf(t, "admin-event.v1.schema.json")
	staffSchema, _ := schemaOf(t, "staff-event.v1.schema.json")
	for _, c := range examples(t) {
		t.Run(c.Name, func(t *testing.T) {
			name, data, err := events.Encode(row(c), false)
			if err != nil || name != c.Row.EventType {
				t.Fatalf("viewer: %q %v", name, err)
			}
			equalJSON(t, data, c.Viewer)
			var v any
			_ = json.Unmarshal(data, &v)
			if err := viewerSchema.Validate(v); err != nil {
				t.Fatalf("viewer message violates the schema: %v", err)
			}

			_, data, err = events.Encode(row(c), true)
			if err != nil {
				t.Fatal(err)
			}
			equalJSON(t, data, c.Staff)
			_ = json.Unmarshal(data, &v)
			if err := staffSchema.Validate(v); err != nil {
				t.Fatalf("staff message violates the schema: %v", err)
			}
		})
	}
}

func TestViewerShapeNeverCarriesPersonalFields(t *testing.T) {
	for _, c := range examples(t) {
		r := row(c)
		_, data, err := events.Encode(r, false)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		_ = json.Unmarshal(data, &m)
		for _, banned := range []string{"appointment_id", "patient_name", "cancellation_reason",
			"actor_email", "actor_role", "staff_reason"} {
			if _, ok := m[banned]; ok {
				t.Fatalf("%s: viewer message has %s", c.Name, banned)
			}
		}
		secrets := []string{r.PatientName, r.AppointmentID}
		for _, p := range []*string{r.ActorEmail, r.Reason} {
			if p != nil {
				secrets = append(secrets, *p)
			}
		}
		for _, secret := range secrets {
			if bytes.Contains(data, []byte(secret)) {
				t.Fatalf("%s: viewer message contains %q", c.Name, secret)
			}
		}
	}
}

func TestOnlyCancellationsCarryAReason(t *testing.T) {
	for _, c := range examples(t) {
		_, data, _ := events.Encode(row(c), true)
		var m map[string]any
		_ = json.Unmarshal(data, &m)
		reason := m["cancellation_reason"]
		if (c.Row.EventType == "cancelled") != (reason != nil) {
			t.Fatalf("%s: reason = %v", c.Name, reason)
		}
	}
}

func TestEncodeRejectsUnknownType(t *testing.T) {
	r := events.Row{EventType: "teleported", LocalDate: time.Now()}
	if _, _, err := events.Encode(r, true); err == nil {
		t.Fatal("unknown event_type was encoded")
	}
	for _, k := range []string{"booked", "rescheduled", "cancelled", "vetoed", "unlocked", "arrived", "no_show"} {
		if !events.Known(k) {
			t.Fatalf("Known(%q) = false: every kind the API writes must be streamable", k)
		}
	}
	if events.Known("teleported") {
		t.Fatal("Known disagrees with Encode")
	}
	a := events.Row{Source: events.SourceAction, EventType: "book"}
	if _, _, err := events.Encode(a, false); err == nil {
		t.Fatal("an action the stream does not carry on its own was encoded")
	}
}

// The viewer schema is the PII boundary: its property set is exactly the allowed one and closed.
func TestViewerSchemaIsExactlyTheAllowedSet(t *testing.T) {
	_, doc := schemaOf(t, "admin-event.v1.schema.json")
	props := doc["properties"].(map[string]any)
	got := make([]string, 0, len(props))
	for k := range props {
		got = append(got, k)
	}
	slices.Sort(got)
	want := []string{"doctor_id", "event_type", "from_local_date", "from_starts_at", "local_date", "seq", "to_starts_at"}
	if !slices.Equal(got, want) || doc["additionalProperties"] != false {
		t.Fatalf("viewer schema properties = %v (closed=%v)", got, doc["additionalProperties"])
	}
}

type actionCase struct {
	Name string `json:"name"`
	Row  struct {
		Txid          uint64  `json:"txid"`
		ID            int64   `json:"id"`
		Action        string  `json:"action"`
		DoctorID      *string `json:"doctor_id"`
		StartsAt      *string `json:"starts_at"`
		DelayMinutes  *int    `json:"delay_minutes"`
		AppointmentID *string `json:"appointment_id"`
		PatientName   *string `json:"patient_name"`
		ActorEmail    *string `json:"actor_email"`
		ActorRole     *string `json:"actor_role"`
		Reason        *string `json:"reason"`
		InviteEmail   *string `json:"invite_email"`
		InviteRole    *string `json:"invite_role"`
	} `json:"row"`
	Viewer json.RawMessage `json:"viewer"`
	Staff  json.RawMessage `json:"staff"`
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func actionRow(c actionCase) events.Row {
	r := c.Row
	return events.Row{
		Txid: r.Txid, ID: r.ID, Source: events.SourceAction, EventType: r.Action,
		DoctorID: deref(r.DoctorID), StartsAt: parse(r.StartsAt), DelayMinutes: r.DelayMinutes,
		AppointmentID: deref(r.AppointmentID), PatientName: deref(r.PatientName),
		ActorEmail: r.ActorEmail, ActorRole: r.ActorRole, Reason: r.Reason,
		InviteEmail: r.InviteEmail, InviteRole: r.InviteRole,
	}
}

// The staff actions streamed from staff_action_audit: the same shared examples the Python models
// validate (backend/tests/unit/test_event_examples.py), both shapes against the exported schemas,
// and the viewer shape free of every personal value in the row.
func TestActionsMatchTheSharedExamplesAndSchemas(t *testing.T) {
	raw, err := os.ReadFile(dir + "action-examples.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases []actionCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Cases) != len(events.StreamedActions()) {
		t.Fatalf("%d action examples for %d streamed actions", len(doc.Cases), len(events.StreamedActions()))
	}
	viewerSchema, _ := schemaOf(t, "admin-action.v1.schema.json")
	staffSchema, _ := schemaOf(t, "staff-action.v1.schema.json")
	for _, c := range doc.Cases {
		t.Run(c.Name, func(t *testing.T) {
			r := actionRow(c)
			name, data, err := events.Encode(r, false)
			if err != nil {
				t.Fatal(err)
			}
			equalJSON(t, data, c.Viewer)
			var v map[string]any
			_ = json.Unmarshal(data, &v)
			if name != v["kind"] {
				t.Fatalf("SSE name %q, kind %v", name, v["kind"])
			}
			if err := viewerSchema.Validate(v); err != nil {
				t.Fatalf("viewer action violates the schema: %v", err)
			}
			for _, secret := range []*string{c.Row.PatientName, c.Row.ActorEmail, c.Row.Reason, c.Row.InviteEmail, c.Row.AppointmentID} {
				if secret != nil && bytes.Contains(data, []byte(*secret)) {
					t.Fatalf("viewer action contains %q", *secret)
				}
			}
			_, data, err = events.Encode(r, true)
			if err != nil {
				t.Fatal(err)
			}
			equalJSON(t, data, c.Staff)
			var sv any
			_ = json.Unmarshal(data, &sv)
			if err := staffSchema.Validate(sv); err != nil {
				t.Fatalf("staff action violates the schema: %v", err)
			}
		})
	}
}
