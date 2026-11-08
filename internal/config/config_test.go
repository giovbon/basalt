package config

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func writeConfigAndVersion(t *testing.T, dir, configContent, version string) (configPath, versionPath string) {
	t.Helper()
	configPath = filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(configPath, []byte(configContent), 0644); err != nil {
		t.Fatal(err)
	}
	versionPath = filepath.Join(dir, "VERSION")
	if err := os.WriteFile(versionPath, []byte(version), 0644); err != nil {
		t.Fatal(err)
	}
	return
}

func TestLoadReadsVersionFile(t *testing.T) {
	dir := t.TempDir()
	configPath, versionPath := writeConfigAndVersion(t, dir, "app:\n  name: MyApp\n", "1.2.3\n")

	cfg, err := Load(configPath, versionPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.App.Version != "1.2.3" {
		t.Errorf("App.Version = %q, want 1.2.3", cfg.App.Version)
	}
	if cfg.App.Name != "MyApp" {
		t.Errorf("App.Name = %q, want MyApp", cfg.App.Name)
	}
}

func TestLoadVersionMissingDefaultsToDev(t *testing.T) {
	dir := t.TempDir()
	configPath, _ := writeConfigAndVersion(t, dir, "", "")

	// Point the version path at a missing file.
	cfg, err := Load(configPath, filepath.Join(dir, "does-not-exist"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.App.Version != "dev" {
		t.Errorf("App.Version = %q, want dev", cfg.App.Version)
	}
}

func TestLoadEnvOverrides(t *testing.T) {
	dir := t.TempDir()
	configPath, versionPath := writeConfigAndVersion(t, dir, "", "2.0.0")

	t.Setenv("APP_NAME", "My App")
	t.Setenv("NOTES_DIR", "/tmp/basalt-notes")
	t.Setenv("PORT", "9000")
	t.Setenv("DEFAULT_THEME", "dark")
	t.Setenv("AUTOSAVE_DELAY_MS", "5000")
	t.Setenv("INDEX_FILE", "/tmp/basalt-index.gob")
	t.Setenv("AUTHENTICATION_ENABLED", "true")
	t.Setenv("AUTHENTICATION_PASSWORD", "env-password")

	cfg, err := Load(configPath, versionPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.App.Name != "My App" {
		t.Errorf("App.Name = %q, want My App", cfg.App.Name)
	}
	if cfg.Storage.NotesDir != "/tmp/basalt-notes" {
		t.Errorf("NotesDir = %q, want /tmp/basalt-notes", cfg.Storage.NotesDir)
	}
	if cfg.Server.Port != 9000 {
		t.Errorf("Port = %d, want 9000", cfg.Server.Port)
	}
	if cfg.UI.DefaultTheme != "dark" {
		t.Errorf("DefaultTheme = %q, want dark", cfg.UI.DefaultTheme)
	}
	if cfg.UI.AutosaveDelayMs != 5000 {
		t.Errorf("AutosaveDelayMs = %d, want 5000", cfg.UI.AutosaveDelayMs)
	}
	if cfg.Storage.IndexFile != "/tmp/basalt-index.gob" {
		t.Errorf("IndexFile = %q, want /tmp/basalt-index.gob", cfg.Storage.IndexFile)
	}
	if !cfg.Authentication.Enabled {
		t.Error("Authentication.Enabled = false, want true")
	}
	if cfg.Authentication.Password != "" {
		t.Error("Password was not cleared after hashing")
	}
	if cfg.Authentication.PasswordHash == "" {
		t.Error("PasswordHash is empty, want bcrypt hash")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(cfg.Authentication.PasswordHash), []byte("env-password")); err != nil {
		t.Errorf("PasswordHash does not match env password: %v", err)
	}
}

func TestLoadAutosaveClamp(t *testing.T) {
	dir := t.TempDir()
	configPath, versionPath := writeConfigAndVersion(t, dir, "", "1.0.0")

	setAutosave := func(t *testing.T, val string) int {
		t.Helper()
		t.Setenv("AUTOSAVE_DELAY_MS", val)
		cfg, err := Load(configPath, versionPath)
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		return cfg.UI.AutosaveDelayMs
	}

	if got := setAutosave(t, "100"); got != 250 {
		t.Errorf("AutosaveDelayMs = %d, want clamped 250", got)
	}
	if got := setAutosave(t, "90000"); got != 60000 {
		t.Errorf("AutosaveDelayMs = %d, want clamped 60000", got)
	}
	if got := setAutosave(t, "5000"); got != 5000 {
		t.Errorf("AutosaveDelayMs = %d, want 5000", got)
	}
	// Non-numeric env falls back to the config/default value.
	t.Setenv("AUTOSAVE_DELAY_MS", "not-a-number")
	cfg, err := Load(configPath, versionPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.UI.AutosaveDelayMs != 1000 {
		t.Errorf("AutosaveDelayMs = %d, want default 1000", cfg.UI.AutosaveDelayMs)
	}
}

func TestLoadDefaultIndexPath(t *testing.T) {
	dir := t.TempDir()
	configPath, versionPath := writeConfigAndVersion(t, dir, "", "1.0.0")

	cfg, err := Load(configPath, versionPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := filepath.Join(dir, ".basalt-index.gob")
	if cfg.Storage.IndexFile != want {
		t.Errorf("IndexFile = %q, want %q", cfg.Storage.IndexFile, want)
	}
}

func TestLoadPasswordClearedAndBcryptHashed(t *testing.T) {
	dir := t.TempDir()
	configPath, versionPath := writeConfigAndVersion(t, dir, "authentication:\n  password: config-password\n", "1.0.0")

	t.Setenv("AUTHENTICATION_PASSWORD", "") // ensure env does not interfere

	cfg, err := Load(configPath, versionPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Authentication.Password != "" {
		t.Error("plain Password was not cleared")
	}
	if cfg.Authentication.PasswordHash == "" {
		t.Fatal("PasswordHash is empty, want bcrypt hash")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(cfg.Authentication.PasswordHash), []byte("config-password")); err != nil {
		t.Errorf("PasswordHash does not match config password: %v", err)
	}
}

func TestLoadDefaultAppNameBasalt(t *testing.T) {
	dir := t.TempDir()
	configPath, versionPath := writeConfigAndVersion(t, dir, "", "1.0.0")

	cfg, err := Load(configPath, versionPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.App.Name != "Basalt" {
		t.Errorf("App.Name = %q, want Basalt", cfg.App.Name)
	}
}

func TestLoadTodoKeywordsDefaultAndSavedValue(t *testing.T) {
	dir := t.TempDir()
	configPath, versionPath := writeConfigAndVersion(t, dir, "", "1.0.0")

	cfg, err := Load(configPath, versionPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Todos.Keywords != "TODO, FIXME, LATER" {
		t.Fatalf("default TODO keywords = %q", cfg.Todos.Keywords)
	}

	if err := SaveTodoKeywords(configPath, "IDEA, BLOCKED"); err != nil {
		t.Fatal(err)
	}
	cfg, err = Load(configPath, versionPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Todos.Keywords != "IDEA, BLOCKED" {
		t.Fatalf("saved TODO keywords = %q, want IDEA, BLOCKED", cfg.Todos.Keywords)
	}
	if cfg.App.Name != "Basalt" {
		t.Fatalf("unrelated config changed, App.Name = %q", cfg.App.Name)
	}
}

func TestLoadNtfySettings(t *testing.T) {
	dir := t.TempDir()
	configPath, versionPath := writeConfigAndVersion(t, dir, `ntfy:
  enabled: true
  server_url: "https://ntfy.example"
  topic: "my-inbox"
  username: "ntfy-user"
  password: "secret"
  capture_dir: "Capturas/ntfy"
  tags: [mobile, quick-capture]
`, "1.0.0")

	cfg, err := Load(configPath, versionPath)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Ntfy.Enabled || cfg.Ntfy.ServerURL != "https://ntfy.example" ||
		cfg.Ntfy.Topic != "my-inbox" || cfg.Ntfy.Username != "ntfy-user" || cfg.Ntfy.Password != "secret" ||
		cfg.Ntfy.CaptureDir != filepath.Join("Capturas", "ntfy") ||
		!slices.Equal(cfg.Ntfy.Tags, []string{"mobile", "quick-capture"}) {
		t.Errorf("Ntfy config = %#v", cfg.Ntfy)
	}
}

func TestLoadNtfyEnvironmentOverrides(t *testing.T) {
	dir := t.TempDir()
	configPath, versionPath := writeConfigAndVersion(t, dir, "", "1.0.0")
	t.Setenv("NTFY_ENABLED", "true")
	t.Setenv("NTFY_SERVER_URL", "https://ntfy.example")
	t.Setenv("NTFY_TOPIC", "env-inbox")
	t.Setenv("NTFY_USERNAME", "env-user")
	t.Setenv("NTFY_PASSWORD", "env-password")
	t.Setenv("NTFY_CAPTURE_DIR", "Captured")
	t.Setenv("NTFY_TAGS", " Phone, capture, phone ")

	cfg, err := Load(configPath, versionPath)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Ntfy.Enabled || cfg.Ntfy.ServerURL != "https://ntfy.example" ||
		cfg.Ntfy.Topic != "env-inbox" || cfg.Ntfy.Username != "env-user" || cfg.Ntfy.Password != "env-password" ||
		cfg.Ntfy.CaptureDir != "Captured" ||
		!slices.Equal(cfg.Ntfy.Tags, []string{"phone", "capture"}) {
		t.Errorf("Ntfy config = %#v", cfg.Ntfy)
	}
}

func TestLoadNtfyDefaultsCaptureTag(t *testing.T) {
	dir := t.TempDir()
	configPath, versionPath := writeConfigAndVersion(t, dir, `ntfy:
  enabled: true
  server_url: "https://ntfy.example"
  topic: "inbox"
`, "1.0.0")

	cfg, err := Load(configPath, versionPath)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(cfg.Ntfy.Tags, []string{"ntfy"}) {
		t.Fatalf("Ntfy tags = %#v, want default ntfy tag", cfg.Ntfy.Tags)
	}
}

func TestLoadEnabledNtfyRequiresTopic(t *testing.T) {
	dir := t.TempDir()
	configPath, versionPath := writeConfigAndVersion(t, dir, "ntfy:\n  enabled: true\n", "1.0.0")
	if _, err := Load(configPath, versionPath); err == nil {
		t.Fatal("Load succeeded, want error for missing ntfy topic")
	}
}

func TestLoadEnabledNtfyRequiresUsernameAndPasswordTogether(t *testing.T) {
	dir := t.TempDir()
	configPath, versionPath := writeConfigAndVersion(t, dir, `ntfy:
  enabled: true
  server_url: "https://ntfy.example"
  topic: "inbox"
  username: "ntfy-user"
`, "1.0.0")
	if _, err := Load(configPath, versionPath); err == nil {
		t.Fatal("Load succeeded, want error for incomplete ntfy credentials")
	}
}

func TestSaveNtfyConfigPreservesOtherSettings(t *testing.T) {
	dir := t.TempDir()
	configPath, _ := writeConfigAndVersion(t, dir, "app:\n  name: Keep me\nsearch:\n  enabled: true\n", "1.0.0")
	if err := os.Chmod(configPath, 0644); err != nil {
		t.Fatal(err)
	}
	settings := NtfyConfig{
		Enabled:    true,
		ServerURL:  "https://ntfy.example",
		Topic:      "inbox",
		Username:   "ntfy-user",
		Password:   "secret",
		CaptureDir: "Captura",
		Tags:       []string{"ntfy", "inbox"},
	}

	if err := SaveNtfyConfig(configPath, settings); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(configPath, filepath.Join(dir, "VERSION"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.App.Name != "Keep me" || !cfg.Search.Enabled {
		t.Errorf("unrelated config was changed: app=%#v search=%#v", cfg.App, cfg.Search)
	}
	if cfg.Ntfy.Enabled != settings.Enabled || cfg.Ntfy.ServerURL != settings.ServerURL ||
		cfg.Ntfy.Topic != settings.Topic || cfg.Ntfy.Username != settings.Username ||
		cfg.Ntfy.Password != settings.Password || cfg.Ntfy.CaptureDir != settings.CaptureDir ||
		!slices.Equal(cfg.Ntfy.Tags, settings.Tags) {
		t.Errorf("Ntfy config = %#v, want %#v", cfg.Ntfy, settings)
	}
	info, err := os.Stat(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0600 {
		t.Errorf("config file mode = %04o, want 0600 when ntfy password is stored", got)
	}
}
