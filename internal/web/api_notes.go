package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"notediscovery/internal/config"
	"notediscovery/internal/vault"
)

type NotesHandler struct {
	cfg   *config.Config
	vault *vault.Vault
}

func NewNotesHandler(cfg *config.Config, v *vault.Vault) *NotesHandler {
	return &NotesHandler{
		cfg:   cfg,
		vault: v,
	}
}

type ListNotesResponse struct {
	Notes      []vault.NoteRecord `json:"notes"`
	Folders    []string           `json:"folders"`
	Pagination *PaginationInfo    `json:"pagination,omitempty"`
}

func (h *NotesHandler) ListNotes(w http.ResponseWriter, r *http.Request) {
	notes, folders, err := h.vault.ScanNotes(true)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, SafeErrorMessage(err, "Failed to scan notes", h.cfg.Server.Debug))
		return
	}

	// Always sort notes by path.lower(). ScanNotes returns a read-only view of
	// the cached snapshot, so clone before sorting in place.
	notes = slices.Clone(notes)
	sort.Slice(notes, func(i, j int) bool {
		return strings.ToLower(notes[i].Path) < strings.ToLower(notes[j].Path)
	})

	limit, offset := ParsePaginationParams(r)
	paginated := Paginate(notes, limit, offset)

	if paginated.Items == nil {
		paginated.Items = []vault.NoteRecord{}
	}
	if folders == nil {
		folders = []string{}
	}

	resp := ListNotesResponse{
		Notes:      paginated.Items,
		Folders:    folders,
		Pagination: paginated.Pagination,
	}
	RespondJSON(w, http.StatusOK, resp)
}

type GetNoteResponse struct {
	Path        string               `json:"path"`
	Content     string               `json:"content"`
	Hash        string               `json:"hash"`
	Metadata    vault.NoteMetadata   `json:"metadata"`
	Frontmatter vault.Frontmatter    `json:"frontmatter"`
	Outline     []vault.OutlineItem  `json:"outline"`
	Tags        []string             `json:"tags"`
	Backlinks   []vault.BacklinkItem `json:"backlinks,omitempty"`
}

func (h *NotesHandler) GetNote(w http.ResponseWriter, r *http.Request) {
	notePath := r.PathValue("path")
	if notePath == "" {
		RespondError(w, http.StatusBadRequest, "Note path required")
		return
	}

	content, err := h.vault.GetNoteContent(notePath)
	if err != nil {
		if os.IsNotExist(err) {
			RespondError(w, http.StatusNotFound, "Note not found")
			return
		}
		RespondError(w, http.StatusInternalServerError, SafeErrorMessage(err, "Failed to load note", h.cfg.Server.Debug))
		return
	}

	storedHash := vault.ContentHash(content)
	meta := h.vault.CreateNoteMetadata(notePath)
	parsed := vault.ParseNote(content)

	resp := GetNoteResponse{
		Path:        notePath,
		Content:     content,
		Hash:        storedHash,
		Metadata:    meta,
		Frontmatter: parsed.Frontmatter,
		Outline:     parsed.Outline,
		Tags:        parsed.Tags,
	}

	if r.URL.Query().Get("include_backlinks") == "true" {
		resp.Backlinks = h.vault.GetBacklinks(notePath)
	}

	RespondJSON(w, http.StatusOK, resp)
}

type SaveNotePayload struct {
	Content  string `json:"content"`
	BaseHash string `json:"base_hash"`
}

type SaveNoteResponse struct {
	Success     bool                `json:"success"`
	Path        string              `json:"path"`
	Message     string              `json:"message"`
	Content     string              `json:"content"`
	Hash        string              `json:"hash"`
	Frontmatter vault.Frontmatter   `json:"frontmatter"`
	Outline     []vault.OutlineItem `json:"outline"`
	Tags        []string            `json:"tags"`
}

type ConflictHashResponse struct {
	Detail  string `json:"detail"`
	Hash    string `json:"hash,omitempty"`
	Deleted bool   `json:"deleted,omitempty"`
}

func (h *NotesHandler) SaveNote(w http.ResponseWriter, r *http.Request) {
	notePath := r.PathValue("path")
	if notePath == "" {
		RespondError(w, http.StatusBadRequest, "Note path required")
		return
	}

	// Append .md (case-insensitive) when the path does not already end in .md
	if !strings.EqualFold(filepath.Ext(notePath), ".md") {
		notePath = notePath + ".md"
	}

	// Refuse clashes
	conflict := h.vault.NoteNameConflict(notePath)
	if conflict != "" && strings.ToLower(vault.NormalizedRelPath(conflict)) != strings.ToLower(vault.NormalizedRelPath(notePath)) {
		RespondError(w, http.StatusConflict, fmt.Sprintf("A note already exists at: %s", notePath))
		return
	}
	if vault.PathHasHash(notePath) && !h.vault.NoteExistsExact(notePath) {
		RespondError(w, http.StatusBadRequest, "Note name cannot contain '#'")
		return
	}

	var payload SaveNotePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	result, err := h.vault.SaveNoteIfHash(notePath, payload.Content, payload.BaseHash)
	if err != nil {
		status := http.StatusInternalServerError
		msg := "Failed to save note"
		if strings.Contains(strings.ToLower(err.Error()), "invalid path") {
			status = http.StatusBadRequest
			msg = "Invalid note path"
		}
		RespondError(w, status, msg)
		return
	}

	if !result.Saved {
		if result.Deleted {
			RespondJSON(w, http.StatusConflict, ConflictHashResponse{
				Detail:  "Note was deleted from disk since it was loaded",
				Deleted: true,
			})
			return
		}
		RespondJSON(w, http.StatusConflict, ConflictHashResponse{
			Detail: "Note changed on disk since it was loaded",
			Hash:   result.CurrentHash,
		})
		return
	}

	msg := "Note saved successfully"
	if result.Created {
		msg = "Note created successfully"
	}

	parsed := vault.ParseNote(payload.Content)
	RespondJSON(w, http.StatusOK, SaveNoteResponse{
		Success:     true,
		Path:        notePath,
		Message:     msg,
		Content:     payload.Content,
		Hash:        result.CurrentHash,
		Frontmatter: parsed.Frontmatter,
		Outline:     parsed.Outline,
		Tags:        parsed.Tags,
	})
}

func (h *NotesHandler) DeleteNote(w http.ResponseWriter, r *http.Request) {
	notePath := r.PathValue("path")
	if notePath == "" {
		RespondError(w, http.StatusBadRequest, "Note path required")
		return
	}

	if !h.vault.DeleteNote(notePath) {
		RespondError(w, http.StatusNotFound, "Note not found")
		return
	}

	RespondJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"path":    notePath,
		"message": "Note deleted successfully",
	})
}

type ReplacePayload struct {
	Path   string  `json:"path"`
	OldStr *string `json:"old_str"`
	NewStr *string `json:"new_str"`
}

func (h *NotesHandler) ReplaceInNote(w http.ResponseWriter, r *http.Request) {
	var payload ReplacePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if payload.Path == "" {
		RespondError(w, http.StatusBadRequest, "path is required")
		return
	}
	if payload.OldStr == nil || *payload.OldStr == "" {
		RespondError(w, http.StatusBadRequest, "old_str is required")
		return
	}
	if payload.NewStr == nil {
		RespondError(w, http.StatusBadRequest, "new_str is required (use an empty string to delete)")
		return
	}

	content, err := h.vault.GetNoteContent(payload.Path)
	if err != nil {
		RespondError(w, http.StatusNotFound, "Note not found")
		return
	}

	oldStr := *payload.OldStr
	newStr := *payload.NewStr

	occurrences := strings.Count(content, oldStr)
	if occurrences == 0 {
		RespondError(w, http.StatusConflict, "old_str not found in note")
		return
	}
	if occurrences > 1 {
		RespondError(w, http.StatusConflict, fmt.Sprintf("old_str found %d times; include more surrounding text to make it unique", occurrences))
		return
	}

	baseHash := vault.ContentHash(content)
	newContent := strings.Replace(content, oldStr, newStr, 1)

	result, err := h.vault.SaveNoteIfHash(payload.Path, newContent, baseHash)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to update note")
		return
	}
	if !result.Saved {
		RespondJSON(w, http.StatusConflict, ConflictHashResponse{
			Detail: "Note changed on disk since it was loaded",
			Hash:   result.CurrentHash,
		})
		return
	}

	parsed := vault.ParseNote(newContent)
	RespondJSON(w, http.StatusOK, map[string]any{
		"success":     true,
		"path":        payload.Path,
		"message":     "Note updated successfully",
		"hash":        result.CurrentHash,
		"frontmatter": parsed.Frontmatter,
		"outline":     parsed.Outline,
		"tags":        parsed.Tags,
	})
}

type MoveNotePayload struct {
	OldPath string `json:"oldPath"`
	NewPath string `json:"newPath"`
}

func (h *NotesHandler) MoveNote(w http.ResponseWriter, r *http.Request) {
	var payload MoveNotePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if payload.OldPath == "" || payload.NewPath == "" {
		RespondError(w, http.StatusBadRequest, "Both oldPath and newPath required")
		return
	}

	// Suffix with .md if missing (case-insensitive)
	newPath := payload.NewPath
	if !strings.EqualFold(filepath.Ext(newPath), ".md") {
		newPath += ".md"
	}

	if vault.PathHasHash(newPath) && !h.vault.NoteExistsExact(newPath) {
		RespondError(w, http.StatusBadRequest, "Note name cannot contain '#'")
		return
	}

	if err := h.vault.MoveNote(payload.OldPath, newPath); err != nil {
		RespondError(w, statusForVaultError(err), err.Error())
		return
	}

	RespondJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"oldPath": payload.OldPath,
		"newPath": newPath,
		"message": "Note moved successfully",
	})
}
