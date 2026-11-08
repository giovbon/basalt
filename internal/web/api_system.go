package web

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"notediscovery/internal/config"
	"notediscovery/internal/ntfy"
	"notediscovery/internal/themes"
	"notediscovery/internal/vault"
)

type SystemHandler struct {
	cfg        *config.Config
	vault      *vault.Vault
	assetsFS   fs.FS
	ntfyMu     sync.RWMutex
	ntfyUpdate func(config.NtfyConfig) error
}

func NewSystemHandler(cfg *config.Config, v *vault.Vault, assetsFS fs.FS, ntfyUpdater ...func(config.NtfyConfig) error) *SystemHandler {
	handler := &SystemHandler{
		cfg:      cfg,
		vault:    v,
		assetsFS: assetsFS,
	}
	if len(ntfyUpdater) > 0 {
		handler.ntfyUpdate = ntfyUpdater[0]
	}
	return handler
}

type AuthStatus struct {
	Enabled bool `json:"enabled"`
}

type ConfigResponse struct {
	Name            string     `json:"name"`
	Version         string     `json:"version"`
	SearchEnabled   bool       `json:"searchEnabled"`
	DemoMode        bool       `json:"demoMode"`
	AlreadyDonated  bool       `json:"alreadyDonated"`
	AutosaveDelayMs int        `json:"autosaveDelayMs"`
	DefaultTheme    string     `json:"defaultTheme"`
	UploadMaxNoteMb int        `json:"uploadMaxNoteMb"`
	Authentication  AuthStatus `json:"authentication"`
	Ntfy            NtfyStatus `json:"ntfy"`
}

type NtfyStatus struct {
	Enabled            bool   `json:"enabled"`
	ServerURL          string `json:"serverUrl"`
	Topic              string `json:"topic"`
	CaptureDir         string `json:"captureDir"`
	Username           string `json:"username"`
	PasswordConfigured bool   `json:"passwordConfigured"`
}

func (h *SystemHandler) GetConfig(w http.ResponseWriter, r *http.Request) {
	h.ntfyMu.RLock()
	ntfySettings := h.cfg.Ntfy
	h.ntfyMu.RUnlock()
	resp := ConfigResponse{
		Name:            h.cfg.App.Name,
		Version:         h.cfg.App.Version,
		SearchEnabled:   h.cfg.Search.Enabled,
		DemoMode:        h.cfg.DemoMode,
		AlreadyDonated:  h.cfg.AlreadyDonated,
		AutosaveDelayMs: h.cfg.UI.AutosaveDelayMs,
		DefaultTheme:    h.cfg.UI.DefaultTheme,
		UploadMaxNoteMb: h.cfg.UploadMaxNoteMb,
		Authentication: AuthStatus{
			Enabled: h.cfg.Authentication.Enabled,
		},
		Ntfy: NtfyStatus{
			Enabled:            ntfySettings.Enabled,
			ServerURL:          ntfySettings.ServerURL,
			Topic:              ntfySettings.Topic,
			CaptureDir:         ntfySettings.CaptureDir,
			Username:           ntfySettings.Username,
			PasswordConfigured: ntfySettings.Password != "",
		},
	}
	RespondJSON(w, http.StatusOK, resp)
}

func (h *SystemHandler) UpdateNtfyConfig(w http.ResponseWriter, r *http.Request) {
	if h.cfg.ConfigFile == "" {
		RespondError(w, http.StatusInternalServerError, "Config file path is unavailable")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var payload struct {
		Enabled       bool   `json:"enabled"`
		ServerURL     string `json:"serverUrl"`
		Topic         string `json:"topic"`
		Username      string `json:"username"`
		Password      string `json:"password"`
		ClearPassword bool   `json:"clearPassword"`
		CaptureDir    string `json:"captureDir"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid ntfy settings")
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		RespondError(w, http.StatusBadRequest, "Invalid ntfy settings")
		return
	}
	password := payload.Password
	if payload.ClearPassword && password != "" {
		RespondError(w, http.StatusBadRequest, "Password cannot be set and cleared at the same time")
		return
	}

	h.ntfyMu.Lock()
	settings := h.cfg.Ntfy
	settings.Enabled = payload.Enabled
	settings.ServerURL = strings.TrimSpace(payload.ServerURL)
	settings.Topic = strings.TrimSpace(payload.Topic)
	settings.Username = strings.TrimSpace(payload.Username)
	settings.CaptureDir = strings.TrimSpace(payload.CaptureDir)
	if payload.ClearPassword {
		settings.Password = ""
	} else if password != "" {
		settings.Password = password
	}
	if settings.Enabled {
		if _, err := ntfy.NewMonitor(settings, h.cfg.Storage.NotesDir); err != nil {
			h.ntfyMu.Unlock()
			RespondError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if (settings.Username == "") != (settings.Password == "") {
		h.ntfyMu.Unlock()
		RespondError(w, http.StatusBadRequest, "ntfy username and password must both be configured")
		return
	}
	if err := config.SaveNtfyConfig(h.cfg.ConfigFile, settings); err != nil {
		h.ntfyMu.Unlock()
		RespondError(w, http.StatusInternalServerError, SafeErrorMessage(err, "Failed to save ntfy settings", h.cfg.Server.Debug))
		return
	}
	if h.ntfyUpdate != nil {
		if err := h.ntfyUpdate(settings); err != nil {
			h.ntfyMu.Unlock()
			RespondError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	h.cfg.Ntfy = settings
	h.ntfyMu.Unlock()

	RespondJSON(w, http.StatusOK, NtfyStatus{
		Enabled:            settings.Enabled,
		ServerURL:          settings.ServerURL,
		Topic:              settings.Topic,
		CaptureDir:         settings.CaptureDir,
		Username:           settings.Username,
		PasswordConfigured: settings.Password != "",
	})
}

func (h *SystemHandler) GetHealth(w http.ResponseWriter, r *http.Request) {
	RespondJSON(w, http.StatusOK, map[string]any{
		"status":  "healthy",
		"app":     h.cfg.App.Name,
		"version": h.cfg.App.Version,
	})
}

func (h *SystemHandler) GetStats(w http.ResponseWriter, r *http.Request) {
	notes, folders, err := h.vault.ScanNotes(true)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to load stats")
		return
	}

	noteCount := 0
	mediaCount := 0
	var totalSize int64
	var latestMtime float64
	var latestTimeStr *string
	tagSet := make(map[string]struct{})

	for _, n := range notes {
		if n.Type == "note" {
			noteCount++
			for _, t := range n.Tags {
				tagSet[t] = struct{}{}
			}
		} else {
			mediaCount++
		}
		totalSize += n.Size
		if n.MTime > latestMtime {
			latestMtime = n.MTime
			mod := n.Modified
			latestTimeStr = &mod
		}
	}

	RespondJSON(w, http.StatusOK, map[string]any{
		"notes_count":      noteCount,
		"folders_count":    len(folders),
		"tags_count":       len(tagSet),
		"media_count":      mediaCount,
		"total_size_bytes": totalSize,
		"last_modified":    latestTimeStr,
		"version":          h.cfg.App.Version,
	})
}

func (h *SystemHandler) GetGraph(w http.ResponseWriter, r *http.Request) {
	includeSys := true
	if val := r.URL.Query().Get("include_system_folders"); val == "false" || val == "0" {
		includeSys = false
	}

	data, err := h.vault.GetGraphData(includeSys)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to build graph")
		return
	}

	RespondJSON(w, http.StatusOK, data)
}

func (h *SystemHandler) ListThemes(w http.ResponseWriter, r *http.Request) {
	allThemes, err := themes.ListThemes(h.assetsFS)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to list themes")
		return
	}
	RespondJSON(w, http.StatusOK, map[string]any{
		"themes": allThemes,
	})
}

func (h *SystemHandler) GetThemeCSS(w http.ResponseWriter, r *http.Request) {
	themeID := r.PathValue("id")
	css, err := themes.GetThemeCSS(h.assetsFS, themeID)
	if err != nil {
		RespondError(w, http.StatusNotFound, "Theme not found")
		return
	}

	raw := r.URL.Query().Get("raw") == "1"
	acceptCSS := strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/css")
	// The response representation depends on Accept whether or not it is CSS.
	addVary(w, "Accept")
	if raw || acceptCSS {
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(css))
		return
	}

	RespondJSON(w, http.StatusOK, map[string]any{
		"css":      css,
		"theme_id": themeID,
	})
}

type LocaleMeta struct {
	Code string `json:"code"`
	Name string `json:"name"`
	Flag string `json:"flag"`
}

func (h *SystemHandler) ListLocales(w http.ResponseWriter, r *http.Request) {
	entries, err := fs.ReadDir(h.assetsFS, "locales")
	if err != nil {
		RespondJSON(w, http.StatusOK, map[string]any{"locales": []LocaleMeta{}})
		return
	}

	var locales []LocaleMeta
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := fs.ReadFile(h.assetsFS, path.Join("locales", entry.Name()))
		if err != nil {
			continue
		}
		var parsed map[string]any
		if err := json.Unmarshal(data, &parsed); err != nil {
			continue
		}

		code := strings.TrimSuffix(entry.Name(), ".json")
		name := code
		flag := "🌐"

		if metaRaw, ok := parsed["_meta"].(map[string]any); ok {
			if c, ok := metaRaw["code"].(string); ok && c != "" {
				code = c
			}
			if n, ok := metaRaw["name"].(string); ok && n != "" {
				name = n
			}
			if f, ok := metaRaw["flag"].(string); ok && f != "" {
				flag = f
			}
		}

		locales = append(locales, LocaleMeta{
			Code: code,
			Name: name,
			Flag: flag,
		})
	}

	RespondJSON(w, http.StatusOK, map[string]any{"locales": locales})
}

var localeRegex = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

func (h *SystemHandler) GetLocale(w http.ResponseWriter, r *http.Request) {
	localeCode := r.PathValue("code")
	if !localeRegex.MatchString(localeCode) {
		RespondError(w, http.StatusBadRequest, "Invalid locale code")
		return
	}

	fileName := path.Join("locales", localeCode+".json")
	data, err := fs.ReadFile(h.assetsFS, fileName)
	if err != nil {
		RespondError(w, http.StatusNotFound, "Locale not found")
		return
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		RespondError(w, http.StatusInternalServerError, SafeErrorMessage(err, "Failed to load locale", h.cfg.Server.Debug))
		return
	}

	RespondJSON(w, http.StatusOK, parsed)
}

// Export Note as HTML
func (h *SystemHandler) ExportNote(w http.ResponseWriter, r *http.Request) {
	notePath := r.PathValue("path")
	content, err := h.vault.GetNoteContent(notePath)
	if err != nil {
		RespondError(w, http.StatusNotFound, "Note not found")
		return
	}

	// Resolve wikilinks/media against the whole vault, same as the graph does.
	notes, _, err := h.vault.ScanNotes(true)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to scan notes")
		return
	}
	var notePaths []string
	media := make(map[string]string)
	for _, n := range notes {
		if n.Type == "note" {
			notePaths = append(notePaths, n.Path)
			continue
		}
		// Lowercase filename -> vault path, first match wins (mirrors the
		// frontend's media lookup). Full path and extension-less stems are
		// indexed too, so [[folder/report.pdf]] and [[report]] resolve the
		// same way they do in the app.
		filename := n.Path
		if i := strings.LastIndex(filename, "/"); i >= 0 {
			filename = filename[i+1:]
		}
		filename = strings.ToLower(filename)
		pathLower := strings.ToLower(n.Path)
		stem := strings.TrimSuffix(filename, filepath.Ext(filename))
		pathStem := strings.TrimSuffix(pathLower, filepath.Ext(pathLower))
		for _, key := range []string{filename, pathLower, stem, pathStem} {
			if key == "" {
				continue
			}
			if _, exists := media[key]; !exists {
				media[key] = n.Path
			}
		}
	}
	resolver := vault.NewLinkResolver(notePaths)

	rendered, err := exportNoteHTML(content, vault.NormalizedRelPath(notePath), resolver, media)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to render note")
		return
	}

	themeID := r.URL.Query().Get("theme")
	if themeID == "" {
		themeID = h.cfg.UI.DefaultTheme
	}
	css, _ := themes.GetThemeCSS(h.assetsFS, themeID)

	isDownload := r.URL.Query().Get("download") != "false"
	stem := strings.TrimSuffix(filepath.Base(notePath), filepath.Ext(notePath))

	htmlTemplate := `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>%s</title>
  <style>%s</style>
</head>
<body class="markdown-body">
  <article>%s</article>
</body>
</html>`

	body := fmt.Sprintf(htmlTemplate, htmlEscape(stem), css, rendered)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if isDownload {
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": stem + ".html"}))
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(body))
}

var storedArchiveExts = map[string]struct{}{
	".png": {}, ".jpg": {}, ".jpeg": {}, ".gif": {}, ".webp": {}, ".avif": {},
	".mp3": {}, ".m4a": {}, ".ogg": {}, ".oga": {}, ".opus": {}, ".flac": {},
	".mp4": {}, ".webm": {}, ".mov": {}, ".mkv": {}, ".avi": {},
	".pdf": {}, ".zip": {}, ".gz": {}, ".bz2": {}, ".xz": {}, ".7z": {}, ".rar": {},
}

func (h *SystemHandler) ArchiveFolder(w http.ResponseWriter, r *http.Request) {
	folderParam := r.URL.Query().Get("folder")
	targetFolder, err := h.vault.ResolveVaultFolder(folderParam)
	if err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid folder path")
		return
	}

	files, totalBytes, err := h.vault.CollectFolderFiles(targetFolder)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to collect folder files")
		return
	}

	maxBytes := int64(h.cfg.ArchiveMaxMb) * 1024 * 1024
	if totalBytes > maxBytes {
		RespondError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("Folder is %d MB, which exceeds the %d MB archive limit", totalBytes/(1024*1024), h.cfg.ArchiveMaxMb))
		return
	}

	archiveName := "vault"
	if folderParam != "" {
		archiveName = filepath.Base(folderParam)
	}
	timestamp := time.Now().UTC().Format("2006-01-02-150405")
	downloadFilename := fmt.Sprintf("%s-%s.zip", archiveName, timestamp)

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": downloadFilename}))

	zipWriter := zip.NewWriter(w)
	defer zipWriter.Close()

	for _, file := range files {
		rel, err := filepath.Rel(targetFolder, file)
		if err != nil {
			continue
		}
		rel = strings.ReplaceAll(rel, "\\", "/")

		ext := strings.ToLower(filepath.Ext(file))
		method := zip.Deflate
		if _, stored := storedArchiveExts[ext]; stored {
			method = zip.Store
		}

		info, err := os.Stat(file)
		if err != nil {
			continue
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			continue
		}
		header.Name = rel
		header.Method = method

		entryWriter, err := zipWriter.CreateHeader(header)
		if err != nil {
			continue
		}

		f, err := os.Open(file)
		if err != nil {
			continue
		}
		_, _ = io.Copy(entryWriter, f)
		f.Close()
	}
}

func htmlEscape(s string) string {
	return strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&#x27;",
	).Replace(s)
}
