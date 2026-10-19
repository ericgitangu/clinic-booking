// Package app wires the gateway to an HTTP server and owns graceful shutdown. cmd/realtime and
// the integration tests both run this exact code.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/ericgitangu/clinic-booking/services/realtime/internal/config"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/gateway"
	"github.com/ericgitangu/clinic-booking/services/realtime/internal/store"
)

// App is one gateway process.
type App struct {
	Gateway *gateway.Gateway
	Store   *store.Store

	cfg   config.Config
	log   *slog.Logger
	drain context.CancelFunc
}

// New builds the app. Nothing connects until the first stream.
func New(cfg config.Config, log *slog.Logger) *App {
	drainCtx, drain := context.WithCancel(context.Background())
	st := store.New(cfg.DatabaseURL, cfg.DBMaxConns)
	return &App{Gateway: gateway.New(drainCtx, cfg, st, log), Store: st, cfg: cfg, log: log, drain: drain}
}

// Serve accepts on ln until ctx is cancelled, then shuts down gracefully: open streams are told
// to reconnect and finish, then the server stops. It returns nil on a clean shutdown.
func (a *App) Serve(ctx context.Context, ln net.Listener) error {
	srv := &http.Server{
		Handler:           a.Gateway.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
		// No WriteTimeout: it would cut every stream. Each write sets its own deadline.
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()

	select {
	case err := <-errc:
		a.drain()
		return fmt.Errorf("serve: %w", err)
	case <-ctx.Done():
	}

	a.log.Info("shutting down", slog.Int("open_streams", a.Gateway.Active()))
	a.drain()
	shutCtx, cancel := context.WithTimeout(context.Background(), a.cfg.ShutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		_ = srv.Close()
		return fmt.Errorf("shutdown: %w", err)
	}
	if err := <-errc; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve: %w", err)
	}
	return nil
}
