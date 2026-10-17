package cursor_test

import (
	"math"
	"strconv"
	"testing"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/cursor"
)

func TestParseRoundTrip(t *testing.T) {
	for _, in := range []string{"0.0", "7.1", "18446744073709551615.9223372036854775807", "12345.1"} {
		c, err := cursor.Parse(in)
		if err != nil {
			t.Fatalf("Parse(%q): %v", in, err)
		}
		if got := c.String(); got != in {
			t.Fatalf("round trip %q -> %q", in, got)
		}
	}
}

func TestParseRejects(t *testing.T) {
	for _, in := range []string{
		"", ".", "1", "1.", ".1", "a.1", "1.b", "-1.1", "1.-1", "+1.1", "1.+1", "1.2.3", " 1.1",
		"1_0.1", "18446744073709551616.1", "1." + strconv.FormatUint(math.MaxUint64, 10),
	} {
		if _, err := cursor.Parse(in); err == nil {
			t.Errorf("Parse(%q) accepted", in)
		}
	}
}

func TestLess(t *testing.T) {
	a := cursor.Cursor{Txid: 5, ID: 9}
	b := cursor.Cursor{Txid: 6, ID: 1}
	c := cursor.Cursor{Txid: 6, ID: 2}
	if !a.Less(b) || !b.Less(c) || c.Less(b) || a.Less(a) {
		t.Fatal("ordering is not (txid, id)")
	}
}
