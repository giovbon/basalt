package vault

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var mediaExtensions = map[string][]string{
	"image":    {".jpg", ".jpeg", ".png", ".gif", ".webp"},
	"audio":    {".mp3", ".wav", ".ogg", ".m4a"},
	"video":    {".mp4", ".webm", ".mov", ".avi"},
	"document": {".pdf"},
}

func GetMediaType(filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))
	for mediaType, exts := range mediaExtensions {
		for _, e := range exts {
			if ext == e {
				return mediaType
			}
		}
	}
	return ""
}

func AllMediaExtensions() map[string]struct{} {
	all := make(map[string]struct{})
	for _, exts := range mediaExtensions {
		for _, e := range exts {
			all[e] = struct{}{}
		}
	}
	return all
}

var sanitizeRe = regexp.MustCompile(`[\\/:*?"<>|\x00-\x1f]`)
var multiUnderscores = regexp.MustCompile(`_+`)

func SanitizeFilename(filename string) string {
	if filename == "" {
		return filename
	}
	ext := filepath.Ext(filename)
	stem := strings.TrimSuffix(filename, ext)

	name := sanitizeRe.ReplaceAllString(stem, "_")
	name = multiUnderscores.ReplaceAllString(name, "_")
	name = strings.Trim(name, "_ ")
	if name == "" {
		name = "unnamed"
	}
	return name + ext
}

// GetAttachmentDir places uploads beside notes while avoiding nested
// _attachments directories when the source already lives under one.
func (v *Vault) GetAttachmentDir(notePath string) string {
	if notePath == "" {
		return filepath.Join(v.notesDir, "_attachments")
	}
	clean := strings.ReplaceAll(notePath, "\\", "/")
	dir := filepath.ToSlash(filepath.Dir(clean))
	if dir == "." || dir == "" {
		return filepath.Join(v.notesDir, "_attachments")
	}
	for _, segment := range strings.Split(dir, "/") {
		if segment == "_attachments" {
			return filepath.Join(v.notesDir, dir)
		}
	}
	return filepath.Join(v.notesDir, dir, "_attachments")
}

func (v *Vault) SaveUploadedImage(notePath string, filename string, data []byte) (string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	timestamp := time.Now().Format("20060102150405")
	sanitized := SanitizeFilename(filename)
	ext := filepath.Ext(sanitized)
	stem := strings.TrimSuffix(sanitized, ext)
	finalFilename := fmt.Sprintf("%s-%s%s", stem, timestamp, ext)

	attachDir := v.GetAttachmentDir(notePath)
	if err := os.MkdirAll(attachDir, 0755); err != nil {
		return "", err
	}
	fullPath := filepath.Join(attachDir, finalFilename)
	if !v.ValidatePathSecurity(fullPath) {
		return "", fmt.Errorf("security validation failed")
	}
	if err := os.WriteFile(fullPath, data, 0644); err != nil {
		return "", err
	}
	rel, _ := filepath.Rel(v.notesDir, fullPath)
	v.scanCache.invalidate()
	return strings.ReplaceAll(rel, "\\", "/"), nil
}
