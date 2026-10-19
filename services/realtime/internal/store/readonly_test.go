package store_test

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The gateway never writes: this holds in the database (the role has SELECT only, tested against a
// real login in backend/tests/integration/test_realtime_role.py) and, as a second line, in the
// source. Every SQL statement the service can send is a SELECT, and nothing in it calls a driver
// method that exists to write.
func TestNoSourceFileWritesToTheDatabase(t *testing.T) {
	root := "../.."
	var sources []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, "_test.go") &&
			!strings.Contains(path, "internal/testenv") {
			sources = append(sources, path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(sources) < 8 {
		t.Fatalf("found only %d source files: the walk is looking in the wrong place", len(sources))
	}

	verbs := regexp.MustCompile(`(?i)\b(insert|update|delete|truncate|alter|create|drop|grant|revoke|copy|merge|call|lock)\b`)
	sql := regexp.MustCompile("(?s)`([^`]*)`")
	writers := regexp.MustCompile(`\.(Exec|CopyFrom|SendBatch|Begin|BeginTx)\(`)
	selects := 0
	for _, path := range sources {
		raw, err := os.ReadFile(path) // #nosec G304 -- walks this module's own source tree
		if err != nil {
			t.Fatal(err)
		}
		src := string(raw)
		if writers.MatchString(src) {
			t.Errorf("%s calls a driver method that writes or opens a transaction", path)
		}
		for _, m := range sql.FindAllStringSubmatch(src, -1) {
			stmt := strings.TrimSpace(m[1])
			up := strings.ToUpper(stmt)
			// WITH counts too: a data-modifying CTE would be a write hidden behind a read.
			if !strings.HasPrefix(up, "SELECT") && !strings.HasPrefix(up, "WITH") {
				continue // a raw string that is not SQL (a message, a pattern)
			}
			selects++
			if verbs.MatchString(stmt) {
				t.Errorf("%s: a statement names a write verb: %.80s", path, stmt)
			}
		}
	}
	if selects < 4 {
		t.Fatalf("found %d SELECT statements, want the 4 the store sends", selects)
	}
}
