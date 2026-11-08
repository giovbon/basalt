package web

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"notediscovery/internal/config"
	"notediscovery/internal/session"
	"notediscovery/internal/vault"
)

func newTestRouter(t *testing.T, allowedOrigins []string, authEnabled bool) *Server {
	t.Helper()
	cfg := &config.Config{
		App: config.AppConfig{
			Name:    "Basalt",
			Version: "1.0.0",
		},
		Server: config.ServerConfig{
			AllowedOrigins: allowedOrigins,
		},
		Authentication: config.AuthenticationConfig{
			Enabled: authEnabled,
		},
	}
	v := vault.New(t.TempDir())
	sess := session.NewManager("test-secret", "", "", 3600, authEnabled)
	return NewServer(cfg, v, sess, fstest.MapFS{})
}

func TestCORSPresentsVaryOrigin(t *testing.T) {
	s := newTestRouter(t, []string{"*"}, false)

	req := httptest.NewRequest("GET", "/health", nil)
	req.Header.Set("Origin", "https://example.com")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Vary"); !strings.Contains(got, "Origin") {
		t.Errorf("Vary = %q, want it to contain Origin", got)
	}
}

func TestUpdateNtfyConfigSavesAndHidesPassword(t *testing.T) {
	s := newTestRouter(t, []string{"*"}, false)
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(configPath, []byte("app:\n  name: Keep me\n"), 0600); err != nil {
		t.Fatal(err)
	}
	s.cfg.ConfigFile = configPath
	s.cfg.Storage.NotesDir = t.TempDir()
	s.cfg.Ntfy.ServerURL = "https://ntfy.example"
	s.cfg.Ntfy.CaptureDir = "Captura"
	var updated bool
	systemHandler := NewSystemHandler(s.cfg, s.vault, nil, func(cfg config.NtfyConfig) error {
		updated = true
		if !cfg.Enabled || cfg.Topic != "inbox" || cfg.Username != "ntfy-user" || cfg.Password != "secret" ||
			strings.Join(cfg.Tags, ",") != "mobile,capture" {
			t.Errorf("updated ntfy config = %#v", cfg)
		}
		return nil
	})

	body := bytes.NewBufferString(`{"enabled":true,"serverUrl":"https://ntfy.example","topic":"inbox","username":"ntfy-user","password":"secret","captureDir":"Captura","tags":[" Mobile ","capture","mobile"]}`)
	req := httptest.NewRequest(http.MethodPost, "/api/ntfy/config", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	systemHandler.UpdateNtfyConfig(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if !updated {
		t.Fatal("ntfy updater was not called")
	}

	var saved NtfyStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if !saved.Enabled || !saved.PasswordConfigured || saved.Username != "ntfy-user" ||
		strings.Join(saved.Tags, ",") != "mobile,capture" {
		t.Errorf("saved status = %#v, want enabled and credentials configured", saved)
	}
	if strings.Contains(rec.Body.String(), "secret") {
		t.Fatal("response exposed the ntfy password")
	}

	body = bytes.NewBufferString(`{"enabled":true,"serverUrl":"https://ntfy.example","topic":"inbox","username":"ntfy-user","password":"","captureDir":"Captura","tags":["mobile","capture"]}`)
	req = httptest.NewRequest(http.MethodPost, "/api/ntfy/config", body)
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	systemHandler.UpdateNtfyConfig(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST with blank password status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"passwordConfigured":true`) {
		t.Errorf("blank password replaced the saved password: %s", rec.Body.String())
	}

	body = bytes.NewBufferString(`{"enabled":true,"serverUrl":"https://ntfy.example","topic":"inbox","username":"ntfy-user","password":"","captureDir":"Captura","tags":[]}`)
	req = httptest.NewRequest(http.MethodPost, "/api/ntfy/config", body)
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	systemHandler.UpdateNtfyConfig(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("POST without capture tags status = %d, want 400", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/config", nil)
	rec = httptest.NewRecorder()
	systemHandler.GetConfig(rec, req)
	if strings.Contains(rec.Body.String(), "secret") {
		t.Fatal("GET /api/config exposed the ntfy password")
	}
}

func TestUpdateTodoKeywordsRouteSharesServerConfig(t *testing.T) {
	s := newTestRouter(t, []string{"*"}, false)
	s.cfg.ConfigFile = filepath.Join(t.TempDir(), "config.yaml")

	req := httptest.NewRequest(http.MethodPost, "/api/todos/config", bytes.NewBufferString(`{"keywords":"IDEA, BLOCKED"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST status = %d, want 200: %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/config", nil)
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET config status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var response ConfigResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.TodoKeywords != "IDEA, BLOCKED" {
		t.Fatalf("API config TODO keywords = %q, want IDEA, BLOCKED", response.TodoKeywords)
	}
}

func TestCORSWildcard(t *testing.T) {
	s := newTestRouter(t, []string{"*"}, false)

	req := httptest.NewRequest("GET", "/health", nil)
	req.Header.Set("Origin", "https://evil.example")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
	}
	if rec.Header().Get("Access-Control-Allow-Credentials") != "" {
		t.Error("Access-Control-Allow-Credentials should not be set for wildcard origin")
	}
	if rec.Header().Get("Access-Control-Allow-Methods") == "" {
		t.Error("Access-Control-Allow-Methods is missing")
	}
}

func TestCORSExactOrigin(t *testing.T) {
	s := newTestRouter(t, []string{"https://app.example"}, false)

	// Allowed origin is reflected and credentials are allowed.
	req := httptest.NewRequest("GET", "/health", nil)
	req.Header.Set("Origin", "https://app.example")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example" {
		t.Errorf("Access-Control-Allow-Origin = %q, want reflected origin", got)
	}
	if rec.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Error("Access-Control-Allow-Credentials = missing, want true")
	}

	// Disallowed origin gets no Access-Control-Allow-Origin.
	req2 := httptest.NewRequest("GET", "/health", nil)
	req2.Header.Set("Origin", "https://evil.example")
	rec2 := httptest.NewRecorder()
	s.ServeHTTP(rec2, req2)

	if rec2.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec2.Code)
	}
	if rec2.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Error("Access-Control-Allow-Origin = non-empty, want empty for disallowed origin")
	}
}

func TestSecurityHeaders(t *testing.T) {
	s := newTestRouter(t, []string{"*"}, false)

	req := httptest.NewRequest("GET", "/health", nil)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if got := rec.Header().Get("X-Frame-Options"); got != "SAMEORIGIN" {
		t.Errorf("X-Frame-Options = %q, want SAMEORIGIN", got)
	}
	if got := rec.Header().Get("Referrer-Policy"); got != "strict-origin-when-cross-origin" {
		t.Errorf("Referrer-Policy = %q, want strict-origin-when-cross-origin", got)
	}
}

func TestHealthPublicWithAuthEnabled(t *testing.T) {
	for _, path := range []string{"/health", "/api/health"} {
		s := newTestRouter(t, []string{"*"}, true)

		req := httptest.NewRequest("GET", path, nil)
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("%s: status = %d, want 200", path, rec.Code)
		}
	}
}

func TestProtectedAPIReturns401WithoutSession(t *testing.T) {
	s := newTestRouter(t, []string{"*"}, true)

	req := httptest.NewRequest("GET", "/api/notes", nil)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}
