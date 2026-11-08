package ntfy

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"notediscovery/internal/config"
)

type Controller struct {
	notesDir string
	mu       sync.RWMutex
	settings config.NtfyConfig
	updates  chan struct{}
}

func NewController(settings config.NtfyConfig, notesDir string) (*Controller, error) {
	if settings.Enabled {
		if _, err := NewMonitor(settings, notesDir); err != nil {
			return nil, err
		}
	}
	return &Controller{
		notesDir: notesDir,
		settings: settings,
		updates:  make(chan struct{}, 1),
	}, nil
}

func (c *Controller) Update(settings config.NtfyConfig) error {
	if settings.Enabled {
		if _, err := NewMonitor(settings, c.notesDir); err != nil {
			return err
		}
	}
	c.mu.Lock()
	c.settings = settings
	c.mu.Unlock()
	select {
	case c.updates <- struct{}{}:
	default:
	}
	return nil
}

func (c *Controller) Settings() config.NtfyConfig {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.settings
}

func (c *Controller) Run(ctx context.Context) error {
	for {
		settings := c.Settings()
		if !settings.Enabled {
			select {
			case <-ctx.Done():
				return nil
			case <-c.updates:
				continue
			}
		}

		monitor, err := NewMonitor(settings, c.notesDir)
		if err != nil {
			return fmt.Errorf("configuring ntfy monitor: %w", err)
		}
		runCtx, cancel := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func() {
			done <- monitor.Run(runCtx)
		}()
		select {
		case <-ctx.Done():
			cancel()
			<-done
			return nil
		case <-c.updates:
			cancel()
			<-done
		case err := <-done:
			cancel()
			if err != nil {
				log.Printf("ntfy monitor stopped: %v", err)
			}
			select {
			case <-ctx.Done():
				return nil
			case <-c.updates:
			case <-time.After(5 * time.Second):
			}
		}
	}
}
