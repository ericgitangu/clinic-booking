package store

import (
	"regexp"
	"strings"
	"testing"
)

// The PII boundary for viewers lives in the viewer query, not in the role's grants (migration
// 0014): clinic_realtime can read the patient's name, the reasons and the invited address. This
// fails if the viewer query ever names one of those columns, or any other personal one. The
// streamed action names travel as the $5 parameter, so no identifier here is exempt.
func TestViewerSQLSelectsNoPersonalColumn(t *testing.T) {
	banned := []string{"full_name", "patient_name", "cancellation_reason", "reason", "actor_email",
		"actor_role", "email", "phone", "staff_invites", "invite_email", "invite_role"}
	lower := strings.ToLower(viewerSQL)
	for _, word := range banned {
		if regexp.MustCompile(`\b` + regexp.QuoteMeta(word) + `\b`).MatchString(lower) {
			t.Errorf("viewer query names %q", word)
		}
	}
	// The staff query is the one that reads them, so the check above cannot pass vacuously.
	for _, word := range []string{"full_name", "cancellation_reason", "actor_email", "staff_invites"} {
		if !strings.Contains(staffSQL, word) {
			t.Errorf("staff query no longer reads %q: update this test with the query", word)
		}
	}
}
