// Package cursor is the commit-safe stream position of docs/adr/0009: the pair (txid, id) of the last
// delivered row. It is the SSE event id and the resume token, rendered as "<txid>.<id>".
package cursor

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Cursor is a position in appointment_events ordered by (txid, id). The zero value precedes
// every row.
type Cursor struct {
	Txid uint64
	ID   int64
}

// ErrInvalid is returned for anything that is not "<txid>.<id>" with both parts non-negative.
var ErrInvalid = errors.New("cursor must look like <txid>.<id>")

// Parse reads the text form. It never accepts signs, spaces or extra parts, so a value that
// parses always round-trips through String.
func Parse(s string) (Cursor, error) {
	left, right, ok := strings.Cut(s, ".")
	if !ok || left == "" || right == "" || strings.ContainsAny(left+right, "+- ._") {
		return Cursor{}, ErrInvalid
	}
	txid, err := strconv.ParseUint(left, 10, 64)
	if err != nil {
		return Cursor{}, fmt.Errorf("%w: txid: %w", ErrInvalid, err)
	}
	id, err := strconv.ParseInt(right, 10, 64)
	if err != nil || id < 0 {
		return Cursor{}, fmt.Errorf("%w: id", ErrInvalid)
	}
	return Cursor{Txid: txid, ID: id}, nil
}

// String is the SSE id and the cursor query parameter.
func (c Cursor) String() string {
	return strconv.FormatUint(c.Txid, 10) + "." + strconv.FormatInt(c.ID, 10)
}

// Less reports whether c sorts strictly before o in (txid, id) order.
func (c Cursor) Less(o Cursor) bool {
	if c.Txid != o.Txid {
		return c.Txid < o.Txid
	}
	return c.ID < o.ID
}
