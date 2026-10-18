// Command realtime is the admin live-feed gateway (/decisions#go).
package main

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/app"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/config"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	os.Exit(run())
}

// healthcheck is for `docker compose` only (the image has no shell or curl). Cloud Run does not
// use it: nothing probes the service, so nothing can wake it.
func healthcheck() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+port+"/health", nil) // #nosec G704 -- loopback only, the port is validated as a number
	if err != nil {
		return 1
	}
	resp, err := http.DefaultClient.Do(req) // #nosec G704 -- loopback only, the port is validated as a number
	if err != nil {
		return 1
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func run() int {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
		// Cloud Logging reads "severity" and "message".
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			switch a.Key {
			case slog.LevelKey:
				a.Key = "severity"
			case slog.MessageKey:
				a.Key = "message"
			}
			return a
		},
	}))

	cfg, err := config.Load(os.LookupEnv)
	if err != nil {
		log.Error("invalid configuration", slog.String("error", err.Error()))
		return 2
	}

	lc := net.ListenConfig{}
	ln, err := lc.Listen(context.Background(), "tcp", ":"+cfg.Port) // #nosec G102 -- Cloud Run requires all interfaces
	if err != nil {
		log.Error("listen failed", slog.String("error", err.Error()))
		return 1
	}

	// Cloud Run sends SIGTERM and allows 10 s; the shutdown timeout is shorter.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	a := app.New(cfg, log)
	log.Info("listening", slog.String("port", cfg.Port),
		slog.Int("max_streams", cfg.MaxStreamsPerInstance))
	if err := a.Serve(ctx, ln); err != nil {
		log.Error("stopped with error", slog.String("error", err.Error()))
		return 1
	}
	log.Info("stopped")
	return 0
}
