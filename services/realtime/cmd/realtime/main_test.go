package main_test

import (
	"bufio"
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/assertion"
)

// Runs the real binary, as Cloud Run does: configuration from the environment, a stream open,
// then SIGTERM. The process must tell the client to reconnect and exit 0 inside the grace period.
const signingKey = "binary-test-signing-key-0123456789abcdef"

func TestBinaryExitsCleanlyOnSIGTERM(t *testing.T) {
	dsn := os.Getenv("TEST_REALTIME_DSN")
	if dsn == "" {
		t.Fatal("TEST_REALTIME_DSN is not set: use `make -C services/realtime test`")
	}
	lc := net.ListenConfig{}
	ln, err := lc.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()

	bin := buildBinary(t)
	cmd := exec.CommandContext(t.Context(), bin) // #nosec G204 -- runs the binary this test just built
	cmd.Env = append(os.Environ(), "PORT="+strconv.Itoa(port), "DATABASE_URL="+dsn, "POLL_INTERVAL=100ms",
		"INTERNAL_SIGNING_KEY="+signingKey, "ADMIN_EMAILS=owner@binary-test.org")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	t.Cleanup(func() { _ = cmd.Process.Kill() })

	base := "http://127.0.0.1:" + strconv.Itoa(port)
	waitUp(t, base+"/health")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, base+"/stream", nil)
	now := time.Now().Unix()
	hdr, err := assertion.Sign(map[string]any{
		"aud": assertion.Audience, "sub": "s", "email": "owner@binary-test.org", "role": "owner",
		"iat": now, "exp": now + 60, "m": "GET", "p": "/stream", "bh": assertion.BodyHash(nil),
	}, []byte(signingKey))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(assertion.Header, hdr)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	sc := bufio.NewScanner(resp.Body)
	if !sc.Scan() || !strings.HasPrefix(sc.Text(), "id: ") {
		t.Fatalf("no hello frame: %q", sc.Text())
	}

	begin := time.Now()
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	var sawShutdown bool
	for sc.Scan() {
		if strings.Contains(sc.Text(), `"shutdown"`) {
			sawShutdown = true
		}
	}
	if !sawShutdown {
		t.Fatal("stream ended without a shutdown reconnect event")
	}
	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("exit: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("process did not exit after SIGTERM")
	}
	if d := time.Since(begin); d > 8*time.Second {
		t.Fatalf("shutdown took %v, Cloud Run allows 10 s", d)
	}
}

func TestBinaryRefusesBadConfig(t *testing.T) {
	bin := buildBinary(t)
	cmd := exec.CommandContext(t.Context(), bin) // #nosec G204 -- runs the binary this test just built
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "DATABASE_URL=postgres://x", "INTERNAL_SIGNING_KEY=too-short"}
	err := cmd.Run()
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 2 {
		t.Fatalf("want exit code 2 for a short signing key, got %v", err)
	}
}

func waitUp(t *testing.T, url string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(url) //nolint:gosec,noctx // loopback test helper
		if err == nil {
			_ = resp.Body.Close()
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s did not come up", url)
}

func buildBinary(t *testing.T) string {
	t.Helper()
	bin := t.TempDir() + "/realtime"
	cmd := exec.CommandContext(t.Context(), "go", "build", "-o", bin, ".") // #nosec G204 -- fixed arguments, temp output path
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	return bin
}
