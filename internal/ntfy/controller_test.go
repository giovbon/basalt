package ntfy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"notediscovery/internal/config"
)

func TestControllerAppliesSettingsUpdatesWithoutRestart(t *testing.T) {
	requests := make(chan string, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- r.URL.Path
		<-r.Context().Done()
	}))
	defer server.Close()

	controller, err := NewController(config.NtfyConfig{
		Enabled:    true,
		ServerURL:  server.URL,
		Topic:      "first",
		CaptureDir: "Captura",
	}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- controller.Run(ctx)
	}()
	awaitRequest := func(want string) {
		t.Helper()
		select {
		case got := <-requests:
			if got != want {
				t.Fatalf("ntfy request path = %q, want %q", got, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for ntfy request %q", want)
		}
	}
	awaitRequest("/first/json")

	if err := controller.Update(config.NtfyConfig{
		Enabled:    true,
		ServerURL:  server.URL,
		Topic:      "second",
		CaptureDir: "Captura",
	}); err != nil {
		cancel()
		t.Fatal(err)
	}
	awaitRequest("/second/json")

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("controller.Run: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("controller did not stop after cancellation")
	}

}
