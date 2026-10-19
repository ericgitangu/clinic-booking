package gateway

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

var uuidRE = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// problemBody is RFC 9457 in the same shape clinic-api returns (backend/app/schemas/problem.py),
// so the web handles gateway errors with the code path it already has. type points at the API's
// /problems catalogue.
type problemBody struct {
	Type      string  `json:"type"`
	Title     string  `json:"title"`
	Status    int     `json:"status"`
	Detail    string  `json:"detail"`
	Instance  string  `json:"instance"`
	Code      string  `json:"code"`
	RequestID string  `json:"request_id"`
	Errors    *string `json:"errors"`
}

func (g *Gateway) writeProblem(w http.ResponseWriter, r *http.Request, status int, code, title, detail string, extra map[string]string) {
	rid := r.Header.Get("X-Request-ID")
	if !uuidRE.MatchString(rid) {
		rid = newUUID()
	}
	body, err := json.Marshal(problemBody{
		Type:      g.cfg.ProblemsBaseURL + "/problems/" + strings.ToLower(strings.ReplaceAll(code, "_", "-")),
		Title:     title,
		Status:    status,
		Detail:    detail,
		Instance:  r.URL.Path,
		Code:      code,
		RequestID: rid,
	})
	if err != nil {
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/problem+json")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Request-ID", rid)
	for k, v := range extra {
		h.Set(k, v)
	}
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
