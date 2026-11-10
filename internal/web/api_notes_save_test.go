package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"notediscovery/internal/config"
	"notediscovery/internal/vault"
)

func TestSaveNoteReportsDeletedBaseAsConflict(t *testing.T) {
	v := vault.New(t.TempDir())
	content := "original\n"
	if err := v.SaveNote("note.md", content); err != nil {
		t.Fatal(err)
	}
	if !v.DeleteNote("note.md") {
		t.Fatal("DeleteNote(note.md) failed")
	}

	handler := NewNotesHandler(&config.Config{}, v)
	req := httptest.NewRequest(http.MethodPost, "/api/notes/note.md", strings.NewReader(
		`{"content":"unsaved edits","base_hash":"`+vault.ContentHash(content)+`"}`,
	))
	req.SetPathValue("path", "note.md")
	rec := httptest.NewRecorder()

	handler.SaveNote(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusConflict, rec.Body.String())
	}
	var response ConflictHashResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if !response.Deleted || response.Hash != "" {
		t.Errorf("response = %+v, want Deleted true and no current hash", response)
	}
	if _, err := v.GetNoteContent("note.md"); err == nil {
		t.Error("conflicted save recreated the deleted note")
	}
}
