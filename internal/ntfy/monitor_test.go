package ntfy

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"notediscovery/internal/config"
	"notediscovery/internal/vault"
)

func TestCaptureEventSavesNoteAndAttachmentIdempotently(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username, password, ok := r.BasicAuth()
		if !ok || username != "ntfy-user" || password != "test-password" {
			t.Errorf("BasicAuth() = (%q, %q, %t), want configured ntfy credentials", username, password, ok)
		}
		_, _ = w.Write([]byte("image bytes"))
	}))
	defer server.Close()

	notesDir := t.TempDir()
	monitor, err := NewMonitor(config.NtfyConfig{
		ServerURL:  server.URL,
		Topic:      "inbox",
		Username:   "ntfy-user",
		Password:   "test-password",
		CaptureDir: "Captura",
		Tags:       []string{" Mobile ", "ntfy", "mobile"},
	}, notesDir)
	if err != nil {
		t.Fatal(err)
	}
	event := Event{
		ID:      "Ab12",
		Time:    1700000000,
		Event:   "message",
		Topic:   "inbox",
		Title:   "Foto",
		Message: "Veja esta imagem",
		Attachment: Attachment{
			Name: "photo.png",
			Type: "image/png",
			URL:  server.URL + "/file",
			Size: 11,
		},
	}

	if err := monitor.captureEvent(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	if err := monitor.captureEvent(context.Background(), event); err != nil {
		t.Fatal(err)
	}

	captureDir := filepath.Join(notesDir, "Captura")
	notePath := filepath.Join(captureDir, "20231114-221320-Ab12.md")
	note, err := os.ReadFile(notePath)
	if err != nil {
		t.Fatal(err)
	}
	capturedAt := time.Unix(event.Time, 0).UTC().Format("02/01/2006 às 15:04")
	if !strings.Contains(string(note), "Veja esta imagem") ||
		!strings.Contains(string(note), "![[20231114-221320-Ab12-photo.png]]") ||
		!strings.Contains(string(note), "Capturado em "+capturedAt+" UTC") {
		t.Errorf("capture note missing message or attachment link: %s", note)
	}
	if got := vault.ParseTags(string(note)); strings.Join(got, ",") != "mobile,ntfy" {
		t.Errorf("captured note tags = %v, want [mobile ntfy]", got)
	}
	attachment, err := os.ReadFile(filepath.Join(captureDir, "20231114-221320-Ab12-photo.png"))
	if err != nil {
		t.Fatal(err)
	}
	if string(attachment) != "image bytes" {
		t.Errorf("attachment = %q, want image bytes", attachment)
	}

	entries, err := os.ReadDir(captureDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Errorf("capture directory has %d files, want note and one attachment", len(entries))
	}
}

func TestCaptureEventUsesWikilinksForNonImageAttachments(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("pdf bytes"))
	}))
	defer server.Close()

	notesDir := t.TempDir()
	monitor, err := NewMonitor(config.NtfyConfig{
		ServerURL:  server.URL,
		Topic:      "inbox",
		CaptureDir: "Captura",
	}, notesDir)
	if err != nil {
		t.Fatal(err)
	}
	event := Event{
		ID:      "Pdf1",
		Time:    1700000000,
		Event:   "message",
		Topic:   "inbox",
		Title:   "Documento",
		Message: "Segue o arquivo",
		Attachment: Attachment{
			Name: "report.pdf",
			Type: "application/pdf",
			URL:  server.URL + "/file",
			Size: 9,
		},
	}
	if err := monitor.captureEvent(context.Background(), event); err != nil {
		t.Fatal(err)
	}

	note, err := os.ReadFile(filepath.Join(notesDir, "Captura", "20231114-221320-Pdf1.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(note), "[[20231114-221320-Pdf1-report.pdf]]") {
		t.Errorf("non-image attachment is not a wikilink: %s", note)
	}
	if strings.Contains(string(note), "](") {
		t.Errorf("capture note contains a Markdown link instead of wikilink: %s", note)
	}
}

func TestCaptureEventRejectsAttachmentFromAnotherOrigin(t *testing.T) {
	monitor, err := NewMonitor(config.NtfyConfig{
		ServerURL:  "https://ntfy.example",
		Topic:      "inbox",
		CaptureDir: "Captura",
	}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	err = monitor.captureEvent(context.Background(), Event{
		ID:    "Ab12",
		Time:  1700000000,
		Event: "message",
		Attachment: Attachment{
			Name: "payload.txt",
			URL:  "https://other.example/payload",
		},
	})
	if err == nil || !strings.Contains(err.Error(), "not on the configured ntfy server") {
		t.Fatalf("captureEvent error = %v, want cross-origin attachment rejection", err)
	}
}

func TestListenSubscribesAndCapturesTextMessage(t *testing.T) {
	eventTime := time.Now().Add(time.Minute).Unix()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/inbox/json" || r.URL.Query().Get("since") != "all" {
			t.Errorf("request = %s?%s, want /inbox/json?since=all", r.URL.Path, r.URL.RawQuery)
		}
		username, password, ok := r.BasicAuth()
		if !ok || username != "ntfy-user" || password != "test-password" {
			t.Errorf("BasicAuth() = (%q, %q, %t), want configured ntfy credentials", username, password, ok)
		}
		_, _ = fmt.Fprintf(w, `{"id":"Msg1","time":%d,"event":"message","topic":"inbox","message":"captured text"}`+"\n", eventTime)
	}))
	defer server.Close()

	notesDir := t.TempDir()
	monitor, err := NewMonitor(config.NtfyConfig{
		ServerURL:  server.URL,
		Topic:      "inbox",
		Username:   "ntfy-user",
		Password:   "test-password",
		CaptureDir: "Captura",
	}, notesDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := monitor.listen(context.Background()); err == nil {
		t.Fatal("listen returned nil after stream ended, want EOF")
	}

	noteName := time.Unix(eventTime, 0).UTC().Format("20060102-150405") + "-Msg1.md"
	note, err := os.ReadFile(filepath.Join(notesDir, "Captura", noteName))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(note), "captured text") {
		t.Errorf("captured note = %q, want message text", note)
	}
	if got := vault.ParseTags(string(note)); strings.Join(got, ",") != "ntfy" {
		t.Errorf("captured note tags = %v, want default [ntfy]", got)
	}
}

func TestListenDoesNotRecreateDeletedCapturesAfterRestart(t *testing.T) {
	eventTime := time.Now().Add(time.Minute).Unix()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintln(w, `{"id":"Old1","time":1700000000,"event":"message","topic":"inbox","message":"old message"}`)
		_, _ = fmt.Fprintf(w, `{"id":"New1","time":%d,"event":"message","topic":"inbox","message":"new message"}`+"\n", eventTime)
	}))
	defer server.Close()

	notesDir := t.TempDir()
	settings := config.NtfyConfig{
		ServerURL:  server.URL,
		Topic:      "inbox",
		CaptureDir: "Captura",
	}
	noteName := time.Unix(eventTime, 0).UTC().Format("20060102-150405") + "-New1.md"
	notePath := filepath.Join(notesDir, "Captura", noteName)

	monitor, err := NewMonitor(settings, notesDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := monitor.listen(context.Background()); err == nil {
		t.Fatal("listen returned nil after stream ended, want EOF")
	}
	if _, err := os.Stat(filepath.Join(notesDir, "Captura", "20231114-221320-Old1.md")); !os.IsNotExist(err) {
		t.Fatalf("historical message was captured, stat error = %v", err)
	}
	if err := os.Remove(notePath); err != nil {
		t.Fatal(err)
	}

	monitor, err = NewMonitor(settings, notesDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := monitor.listen(context.Background()); err == nil {
		t.Fatal("listen returned nil after stream ended, want EOF")
	}
	if _, err := os.Stat(notePath); !os.IsNotExist(err) {
		t.Fatalf("deleted capture was recreated, stat error = %v", err)
	}
}

func TestNewMonitorRejectsUnsafeConfiguration(t *testing.T) {
	tests := []struct {
		name string
		cfg  config.NtfyConfig
	}{
		{
			name: "invalid server scheme",
			cfg:  config.NtfyConfig{ServerURL: "file:///tmp", Topic: "inbox", CaptureDir: "Captura"},
		},
		{
			name: "topic path traversal",
			cfg:  config.NtfyConfig{ServerURL: "https://ntfy.example", Topic: "../inbox", CaptureDir: "Captura"},
		},
		{
			name: "capture path traversal",
			cfg:  config.NtfyConfig{ServerURL: "https://ntfy.example", Topic: "inbox", CaptureDir: "../outside"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := NewMonitor(tt.cfg, t.TempDir()); err == nil {
				t.Fatal("NewMonitor succeeded, want invalid configuration error")
			}
		})
	}
}
