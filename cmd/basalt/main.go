// Command basalt starts the Basalt HTTP server.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"notediscovery"
	"notediscovery/internal/config"
	"notediscovery/internal/ntfy"
	"notediscovery/internal/session"
	"notediscovery/internal/vault"
	"notediscovery/internal/web"
)

const (
	configFile  = "config.yaml"
	versionFile = "VERSION"

	shutdownTimeout = 10 * time.Second
)

func main() {
	if err := run(); err != nil {
		log.Printf("FATAL: %v", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load(configFile, versionFile)
	if err != nil {
		return fmt.Errorf("loading config: %w", err)
	}

	v := vault.New(cfg.Storage.NotesDir)
	if err := v.EnsureDirectories(); err != nil {
		return fmt.Errorf("creating notes directory %q: %w", cfg.Storage.NotesDir, err)
	}
	defer v.Close() // stops watcher/persistence and flushes the index cache

	if !isWritable(cfg.Storage.NotesDir) {
		log.Printf("WARNING: notes directory %q is not writable by the current user - "+
			"notes and uploads will fail (check ownership/permissions, e.g. "+
			"'chown -R 10001:10001 %s' when running in Docker)", cfg.Storage.NotesDir, cfg.Storage.NotesDir)
	}

	// Best effort: without change events (drvfs under WSL, some Docker Desktop
	// binds) the vault keeps working on the plain scan TTL, which is exactly
	// how it behaved before watchers existed.
	if err := v.StartWatching(); err != nil {
		log.Printf("WARNING: file watcher disabled: %v (external edits may take up to %s to appear)",
			err, 2*time.Second)
	}

	// The index cache lives next to config.yaml by default (override with
	// INDEX_FILE), never polluting the vault: the .md files stay the only
	// source of truth. In Docker point it at a mounted volume to keep the
	// warm index across restarts.
	if err := v.StartIndexPersistence(cfg.Storage.IndexFile); err != nil {
		log.Printf("WARNING: index cache not loaded: %v (it will be rebuilt from the notes)", err)
	}

	sess := session.NewManager(
		cfg.Authentication.SecretKey,
		cfg.Authentication.PasswordHash,
		cfg.Authentication.APIKey,
		cfg.Authentication.SessionMaxAge,
		cfg.Authentication.Enabled,
	)

	ntfyController, err := ntfy.NewController(cfg.Ntfy, cfg.Storage.NotesDir)
	if err != nil {
		return fmt.Errorf("configuring ntfy monitor: %w", err)
	}
	handler := web.NewServer(cfg, v, sess, notediscovery.AssetFS(), ntfyController.Update)

	addr := net.JoinHostPort(cfg.Server.Host, strconv.Itoa(cfg.Server.Port))
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadTimeout:       5 * time.Minute,
		WriteTimeout:      15 * time.Minute,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		if err := ntfyController.Run(ctx); err != nil {
			log.Printf("ntfy monitor stopped: %v", err)
		}
	}()

	errCh := make(chan error, 1)
	go func() {
		log.Printf("%s v%s listening on http://%s (notes: %s)",
			cfg.App.Name, cfg.App.Version, displayAddr(cfg.Server.Host, cfg.Server.Port), cfg.Storage.NotesDir)
		errCh <- httpSrv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("http server: %w", err)
		}
		return nil
	case <-ctx.Done():
		log.Println("Shutdown signal received, stopping server...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := httpSrv.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("graceful shutdown: %w", err)
		}
		log.Println("Server stopped")
		return nil
	}
}

// displayAddr returns a human friendly address for startup logs.
func displayAddr(host string, port int) string {
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		host = "localhost"
	}
	return net.JoinHostPort(host, strconv.Itoa(port))
}

// isWritable reports whether new files can be created in dir.
func isWritable(dir string) bool {
	f, err := os.CreateTemp(dir, ".writetest-*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}
