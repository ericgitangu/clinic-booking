// Command realtime is the admin live-feed gateway (docs/adr/0021).
package main

import (
	"context"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/app"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/config"
)

func main() {
	os.Exit(run())
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
