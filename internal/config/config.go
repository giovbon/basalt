package config

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/crypto/bcrypt"
	"gopkg.in/yaml.v3"
)

type Config struct {
	ConfigFile     string               `yaml:"-"`
	SettingsMu     sync.RWMutex         `yaml:"-"`
	App            AppConfig            `yaml:"app"`
	Server         ServerConfig         `yaml:"server"`
	Storage        StorageConfig        `yaml:"storage"`
	Search         SearchConfig         `yaml:"search"`
	Todos          TodosConfig          `yaml:"todos"`
	UI             UIConfig             `yaml:"ui"`
	Authentication AuthenticationConfig `yaml:"authentication"`
	Ntfy           NtfyConfig           `yaml:"ntfy"`

	// Derived / runtime config
	DemoMode        bool  `yaml:"-"`
	AlreadyDonated  bool  `yaml:"-"`
	UploadMaxImage  int64 `yaml:"-"`
	UploadMaxAudio  int64 `yaml:"-"`
	UploadMaxVideo  int64 `yaml:"-"`
	UploadMaxPdf    int64 `yaml:"-"`
	UploadMaxNoteMb int   `yaml:"-"`
	ArchiveMaxMb    int   `yaml:"-"`
}

type AppConfig struct {
	Name    string `yaml:"name"`
	Version string `yaml:"version"`
}

type ServerConfig struct {
	Host           string   `yaml:"host"`
	Port           int      `yaml:"port"`
	Reload         bool     `yaml:"reload"`
	AllowedOrigins []string `yaml:"allowed_origins"`
	Debug          bool     `yaml:"debug"`
}

type StorageConfig struct {
	NotesDir string `yaml:"notes_dir"`
	// IndexFile is the gob cache of the note index (disposable; the .md files
	// remain the source of truth). Empty means "next to config.yaml".
	IndexFile string `yaml:"index_file"`
}

type SearchConfig struct {
	Enabled bool `yaml:"enabled"`
}

type TodosConfig struct {
	Keywords string `yaml:"keywords"`
}

type UIConfig struct {
	DefaultTheme    string `yaml:"default_theme"`
	AutosaveDelayMs int    `yaml:"autosave_delay_ms"`
}

type AuthenticationConfig struct {
	Enabled       bool   `yaml:"enabled"`
	SecretKey     string `yaml:"secret_key"`
	Password      string `yaml:"password"`
	PasswordHash  string `yaml:"password_hash"`
	SessionMaxAge int    `yaml:"session_max_age"`
	APIKey        string `yaml:"api_key"`
}

type NtfyConfig struct {
	Enabled    bool     `yaml:"enabled"`
	ServerURL  string   `yaml:"server_url"`
	Topic      string   `yaml:"topic"`
	Username   string   `yaml:"username"`
	Password   string   `yaml:"password"`
	CaptureDir string   `yaml:"capture_dir"`
	Tags       []string `yaml:"tags"`
}

func NormalizeNtfyTags(tags []string) []string {
	normalized := make([]string, 0, len(tags))
	seen := make(map[string]struct{}, len(tags))
	for _, tag := range tags {
		tag = strings.ToLower(strings.TrimSpace(tag))
		if tag == "" {
			continue
		}
		if _, exists := seen[tag]; exists {
			continue
		}
		seen[tag] = struct{}{}
		normalized = append(normalized, tag)
	}
	return normalized
}

func parseBoolEnv(val string) bool {
	v := strings.ToLower(strings.TrimSpace(val))
	return v == "true" || v == "1" || v == "yes"
}

func parseIntEnv(key string, fallback int) int {
	if val := os.Getenv(key); val != "" {
		if n, err := strconv.Atoi(strings.TrimSpace(val)); err == nil {
			return n
		}
	}
	return fallback
}

// Load reads config.yaml, merges VERSION, applies environment variables, and prepares bcrypt hash.
func Load(configPath, versionPath string) (*Config, error) {
	cfg := &Config{
		ConfigFile: configPath,
		App: AppConfig{
			Name: "Basalt",
		},
		Server: ServerConfig{
			Host:           "0.0.0.0",
			Port:           8000,
			AllowedOrigins: []string{"*"},
			Debug:          false,
		},
		Storage: StorageConfig{
			NotesDir: "./data",
		},
		Search: SearchConfig{
			Enabled: true,
		},
		Todos: TodosConfig{
			Keywords: "TODO, FIXME, LATER",
		},
		UI: UIConfig{
			DefaultTheme:    "light",
			AutosaveDelayMs: 1000,
		},
		Authentication: AuthenticationConfig{
			Enabled:       false,
			SecretKey:     "change_this_to_a_random_secret_key_in_production",
			Password:      "admin",
			SessionMaxAge: 604800, // 7 days
			APIKey:        "",
		},
		Ntfy: NtfyConfig{
			ServerURL:  "https://ntfy.sh",
			CaptureDir: "Captura",
			Tags:       []string{"ntfy"},
		},
	}

	if data, err := os.ReadFile(configPath); err == nil {
		if err := yaml.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("failed to parse %s: %w", configPath, err)
		}
	}

	// 1. VERSION file (single source of truth)
	if verData, err := os.ReadFile(versionPath); err == nil {
		cfg.App.Version = strings.TrimSpace(string(verData))
	} else {
		cfg.App.Version = "dev"
	}

	// 2. APP_NAME env var > app.name
	if appName := strings.TrimSpace(os.Getenv("APP_NAME")); appName != "" {
		cfg.App.Name = appName
		log.Printf("App name: %s (from APP_NAME env var)", cfg.App.Name)
	} else {
		log.Printf("App name: %s (from config.yaml)", cfg.App.Name)
	}

	// Server Port override
	if envPort := os.Getenv("PORT"); envPort != "" {
		if p, err := strconv.Atoi(strings.TrimSpace(envPort)); err == nil && p > 0 {
			cfg.Server.Port = p
		}
	}

	// 3. STORAGE: NOTES_DIR env var > storage.notes_dir
	if notesDir := strings.TrimSpace(os.Getenv("NOTES_DIR")); notesDir != "" {
		cfg.Storage.NotesDir = notesDir
		log.Printf("Notes directory: %s (from NOTES_DIR env var)", cfg.Storage.NotesDir)
	} else {
		log.Printf("Notes directory: %s (from config.yaml)", cfg.Storage.NotesDir)
	}

	// Index cache location: INDEX_FILE env var > storage.index_file > next to
	// config.yaml. The file is a disposable cache derived from the .md files;
	// in Docker point it at a mounted volume (e.g. INDEX_FILE=/app/data/.basalt-index.gob)
	// so the warm index survives container restarts.
	idxSource := "config.yaml"
	if idxFile := strings.TrimSpace(os.Getenv("INDEX_FILE")); idxFile != "" {
		cfg.Storage.IndexFile = idxFile
		idxSource = "INDEX_FILE env var"
	}
	if cfg.Storage.IndexFile == "" {
		cfg.Storage.IndexFile = filepath.Join(filepath.Dir(configPath), ".basalt-index.gob")
		idxSource = "default (next to config.yaml)"
	}
	log.Printf("Index cache: %s (from %s)", cfg.Storage.IndexFile, idxSource)

	// 4. UI: DEFAULT_THEME
	if t := strings.TrimSpace(os.Getenv("DEFAULT_THEME")); t != "" {
		cfg.UI.DefaultTheme = t
		log.Printf("Default theme: %s (from DEFAULT_THEME env var)", cfg.UI.DefaultTheme)
	} else {
		if strings.TrimSpace(cfg.UI.DefaultTheme) == "" {
			cfg.UI.DefaultTheme = "light"
		}
		log.Printf("Default theme: %s (from config.yaml)", cfg.UI.DefaultTheme)
	}

	// Autosave delay clamp 250 - 60000 ms
	autosaveRaw := cfg.UI.AutosaveDelayMs
	if envAutosave := os.Getenv("AUTOSAVE_DELAY_MS"); envAutosave != "" {
		if n, err := strconv.Atoi(strings.TrimSpace(envAutosave)); err == nil {
			autosaveRaw = n
		}
	}
	if autosaveRaw < 250 {
		autosaveRaw = 250
	} else if autosaveRaw > 60000 {
		autosaveRaw = 60000
	}
	cfg.UI.AutosaveDelayMs = autosaveRaw

	// 5. Authentication
	if envAuth := os.Getenv("AUTHENTICATION_ENABLED"); envAuth != "" {
		cfg.Authentication.Enabled = parseBoolEnv(envAuth)
		log.Printf("Authentication %s (from AUTHENTICATION_ENABLED env var)", boolStatus(cfg.Authentication.Enabled))
	} else {
		log.Printf("Authentication %s (from config.yaml)", boolStatus(cfg.Authentication.Enabled))
	}

	if secret := os.Getenv("AUTHENTICATION_SECRET_KEY"); secret != "" {
		cfg.Authentication.SecretKey = secret
		log.Printf("Secret key loaded from AUTHENTICATION_SECRET_KEY env var")
	}

	if envAPIKey := os.Getenv("AUTHENTICATION_API_KEY"); envAPIKey != "" {
		cfg.Authentication.APIKey = strings.TrimSpace(envAPIKey)
		log.Printf("API key loaded from AUTHENTICATION_API_KEY env var")
	}

	if enabled := os.Getenv("NTFY_ENABLED"); enabled != "" {
		cfg.Ntfy.Enabled = parseBoolEnv(enabled)
	}
	if serverURL := strings.TrimSpace(os.Getenv("NTFY_SERVER_URL")); serverURL != "" {
		cfg.Ntfy.ServerURL = serverURL
	}
	if topic := strings.TrimSpace(os.Getenv("NTFY_TOPIC")); topic != "" {
		cfg.Ntfy.Topic = topic
	}
	if username := strings.TrimSpace(os.Getenv("NTFY_USERNAME")); username != "" {
		cfg.Ntfy.Username = username
	}
	if password := os.Getenv("NTFY_PASSWORD"); password != "" {
		cfg.Ntfy.Password = password
	}
	if captureDir := strings.TrimSpace(os.Getenv("NTFY_CAPTURE_DIR")); captureDir != "" {
		cfg.Ntfy.CaptureDir = captureDir
	}
	if tags := strings.TrimSpace(os.Getenv("NTFY_TAGS")); tags != "" {
		cfg.Ntfy.Tags = strings.Split(tags, ",")
	}
	cfg.Ntfy.Tags = NormalizeNtfyTags(cfg.Ntfy.Tags)
	if len(cfg.Ntfy.Tags) == 0 {
		cfg.Ntfy.Tags = []string{"ntfy"}
	}
	if cfg.Ntfy.Enabled {
		if cfg.Ntfy.Topic == "" {
			return nil, fmt.Errorf("ntfy is enabled but no topic is configured")
		}
		if cfg.Ntfy.ServerURL == "" {
			return nil, fmt.Errorf("ntfy is enabled but no server_url is configured")
		}
		if (cfg.Ntfy.Username == "") != (cfg.Ntfy.Password == "") {
			return nil, fmt.Errorf("ntfy username and password must both be configured")
		}
		if cfg.Ntfy.CaptureDir == "" || filepath.IsAbs(cfg.Ntfy.CaptureDir) {
			return nil, fmt.Errorf("ntfy capture_dir must be a non-empty relative path")
		}
		captureDir := filepath.Clean(cfg.Ntfy.CaptureDir)
		if captureDir == ".." || strings.HasPrefix(captureDir, ".."+string(filepath.Separator)) {
			return nil, fmt.Errorf("ntfy capture_dir must stay inside the notes directory")
		}
		cfg.Ntfy.CaptureDir = captureDir
	}

	// Password priority: env var > config > default "admin"
	plainPassword := ""
	if envPw := os.Getenv("AUTHENTICATION_PASSWORD"); envPw != "" {
		plainPassword = strings.TrimSpace(envPw)
		log.Printf("Password loaded from AUTHENTICATION_PASSWORD env var")
	} else if cfg.Authentication.Password != "" {
		plainPassword = strings.TrimSpace(cfg.Authentication.Password)
		log.Printf("Password loaded from config.yaml")
	}

	if plainPassword != "" {
		hash, err := bcrypt.GenerateFromPassword([]byte(plainPassword), bcrypt.DefaultCost)
		if err != nil {
			return nil, fmt.Errorf("failed to hash password: %w", err)
		}
		cfg.Authentication.PasswordHash = string(hash)
		cfg.Authentication.Password = "" // clear plain password
	}

	// Security warnings
	if cfg.Authentication.Enabled {
		hasPw := cfg.Authentication.PasswordHash != ""
		hasKey := strings.TrimSpace(cfg.Authentication.APIKey) != ""
		isDefaultSec := cfg.Authentication.SecretKey == "" || cfg.Authentication.SecretKey == "change_this_to_a_random_secret_key_in_production"

		if !hasPw && !hasKey {
			log.Printf("CRITICAL: Authentication enabled but NO auth methods configured - ALL access will be denied!")
		} else {
			if !hasPw {
				log.Printf("WARNING: No password configured - web UI login will not work")
			}
			if !hasKey {
				log.Printf("WARNING: No API key configured - external integrations will require session cookies")
			}
		}
		if isDefaultSec {
			log.Printf("CRITICAL: Using default secret_key - sessions can be forged! Change it in config.yaml")
		}
	}

	// 6. Limits and runtime flags
	cfg.DemoMode = parseBoolEnv(os.Getenv("DEMO_MODE"))
	cfg.AlreadyDonated = parseBoolEnv(os.Getenv("ALREADY_DONATED"))
	cfg.UploadMaxImage = int64(parseIntEnv("UPLOAD_MAX_IMAGE_MB", 10)) * 1024 * 1024
	cfg.UploadMaxAudio = int64(parseIntEnv("UPLOAD_MAX_AUDIO_MB", 50)) * 1024 * 1024
	cfg.UploadMaxVideo = int64(parseIntEnv("UPLOAD_MAX_VIDEO_MB", 100)) * 1024 * 1024
	cfg.UploadMaxPdf = int64(parseIntEnv("UPLOAD_MAX_PDF_MB", 20)) * 1024 * 1024
	cfg.UploadMaxNoteMb = parseIntEnv("UPLOAD_MAX_NOTE_MB", 10)
	cfg.ArchiveMaxMb = parseIntEnv("ARCHIVE_MAX_FOLDER_MB", 500)

	return cfg, nil
}

func SaveNtfyConfig(configPath string, settings NtfyConfig) error {
	return saveConfigSection(configPath, "ntfy", settings, settings.Password != "")
}

func SaveTodoKeywords(configPath, keywords string) error {
	return saveConfigSection(configPath, "todos", TodosConfig{Keywords: keywords}, false)
}

func saveConfigSection(configPath, section string, settings any, protectSecrets bool) error {
	data, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("reading config file: %w", err)
	}

	var document yaml.Node
	if len(data) == 0 {
		document = yaml.Node{Kind: yaml.DocumentNode}
		document.Content = []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}
	} else if err := yaml.Unmarshal(data, &document); err != nil {
		return fmt.Errorf("parsing config file: %w", err)
	}
	if len(document.Content) == 0 || document.Content[0].Kind != yaml.MappingNode {
		return fmt.Errorf("config file root must be a mapping")
	}

	root := document.Content[0]
	encoded, err := yaml.Marshal(settings)
	if err != nil {
		return fmt.Errorf("encoding %s config: %w", section, err)
	}
	var value yaml.Node
	if err := yaml.Unmarshal(encoded, &value); err != nil {
		return fmt.Errorf("decoding %s config: %w", section, err)
	}
	encodedValue := value.Content[0]

	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value == section {
			encodedValue.HeadComment = root.Content[i+1].HeadComment
			encodedValue.LineComment = root.Content[i+1].LineComment
			encodedValue.FootComment = root.Content[i+1].FootComment
			root.Content[i+1] = encodedValue
			data, err = yaml.Marshal(&document)
			if err != nil {
				return fmt.Errorf("encoding config file: %w", err)
			}
			return writeConfigFile(configPath, data, protectSecrets)
		}
	}
	root.Content = append(root.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: section},
		encodedValue,
	)
	data, err = yaml.Marshal(&document)
	if err != nil {
		return fmt.Errorf("encoding config file: %w", err)
	}
	return writeConfigFile(configPath, data, protectSecrets)
}

func writeConfigFile(configPath string, data []byte, protectSecrets bool) error {
	mode := os.FileMode(0644)
	if info, err := os.Stat(configPath); err == nil {
		mode = info.Mode().Perm()
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("checking config file permissions: %w", err)
	}
	if protectSecrets {
		mode = 0600
	}
	tempFile, err := os.CreateTemp(filepath.Dir(configPath), ".config-*.yaml")
	if err != nil {
		return fmt.Errorf("creating temporary config file: %w", err)
	}
	tempPath := tempFile.Name()
	defer os.Remove(tempPath)
	if err := tempFile.Chmod(mode); err != nil {
		_ = tempFile.Close()
		return fmt.Errorf("setting config file permissions: %w", err)
	}
	if _, err := tempFile.Write(data); err != nil {
		_ = tempFile.Close()
		return fmt.Errorf("writing config file: %w", err)
	}
	if err := tempFile.Sync(); err != nil {
		_ = tempFile.Close()
		return fmt.Errorf("syncing config file: %w", err)
	}
	if err := tempFile.Close(); err != nil {
		return fmt.Errorf("closing config file: %w", err)
	}
	if err := os.Rename(tempPath, configPath); err != nil {
		return fmt.Errorf("replacing config file: %w", err)
	}
	return nil
}

func boolStatus(b bool) string {
	if b {
		return "ENABLED"
	}
	return "DISABLED"
}

// CleanPath makes sure path is absolute or relative cleaned
func CleanPath(p string) string {
	return filepath.Clean(p)
}
