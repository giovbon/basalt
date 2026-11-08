package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"notediscovery/internal/vault"
)

func TestRunQueryFiltersFrontmatterAndReturnsTableRows(t *testing.T) {
	dir := t.TempDir()
	writeQueryNote(t, dir, "Projects/active.md", `---
status: active
due: 2026-12-01
tags: [work, current]
---
# Active
- [ ] Draft plan
- [x] Review plan
`)
	writeQueryNote(t, dir, "Projects/done.md", `---
status: done
due: 2026-01-01
---
# Done
`)
	writeQueryNote(t, dir, "Journal/today.md", `---
status: active
---
# Journal
`)

	handler := NewQueriesHandler(vault.New(dir))
	request := httptest.NewRequest(http.MethodPost, "/api/query", strings.NewReader(`{
		"query":"type: table\nfrom: Projects\nwhere:\n  status: active\nsort: due\ncolumns: [file.name, status, due]"
	}`))
	response := httptest.NewRecorder()
	handler.Run(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}

	var result QueryResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Type != "table" || len(result.Rows) != 1 {
		t.Fatalf("query result = %#v, want one matching table row", result)
	}
	row := result.Rows[0]
	if row.Path != "Projects/active.md" || row.Values["status"] != "active" || row.Values["due"] != "2026-12-01" {
		t.Fatalf("query row = %#v", row)
	}
}

func TestRunQueryFiltersByTagList(t *testing.T) {
	dir := t.TempDir()
	writeQueryNote(t, dir, "Tagged.md", "---\ntags: [impacta, projeto]\n---\n# Tagged\n")
	writeQueryNote(t, dir, "Other.md", "---\ntags: [pessoal]\n---\n# Other\n")

	handler := NewQueriesHandler(vault.New(dir))
	request := httptest.NewRequest(http.MethodPost, "/api/query", strings.NewReader(
		`{"query":"type: table\nwhere:\n  tags: [impacta]"}`,
	))
	response := httptest.NewRecorder()
	handler.Run(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}

	var result QueryResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 1 || result.Rows[0].Path != "Tagged.md" {
		t.Fatalf("tag query rows = %#v, want only Tagged.md", result.Rows)
	}
}

func TestRunTaskQueryReturnsTaskMetadata(t *testing.T) {
	dir := t.TempDir()
	writeQueryNote(t, dir, "Plan.md", `---
status: active
---
Frontmatter text - [ ] not a task
- [ ] Open task
- [x] Closed task
`)
	handler := NewQueriesHandler(vault.New(dir))
	request := httptest.NewRequest(http.MethodPost, "/api/query", strings.NewReader(
		`{"query":"type: task\nwhere:\n  status: active\ncolumns: [task.text, task.completed]"}`,
	))
	response := httptest.NewRecorder()
	handler.Run(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}

	var result QueryResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 2 || result.Rows[0].Values["task.text"] != "Open task" ||
		result.Rows[0].Values["task.completed"] != false || result.Rows[1].Values["task.completed"] != true {
		t.Fatalf("task rows = %#v", result.Rows)
	}
}

func TestRunQueryRejectsInvalidAndOversizedQueries(t *testing.T) {
	handler := NewQueriesHandler(vault.New(t.TempDir()))
	for _, body := range []string{
		`{"query":"type: javascript\nlimit: 5"}`,
		`{"query":"type: table\nlimit: 1000"}`,
		`{"query":"type: table\nunknown: true"}`,
		`{"query":"` + strings.Repeat("x", maxQueryBytes+1) + `"}`,
	} {
		request := httptest.NewRequest(http.MethodPost, "/api/query", strings.NewReader(body))
		response := httptest.NewRecorder()
		handler.Run(response, request)
		if response.Code != http.StatusBadRequest {
			t.Errorf("query status = %d, want 400 for %q", response.Code, body[:min(len(body), 80)])
		}
	}
}

func writeQueryNote(t *testing.T, dir, relPath, content string) {
	t.Helper()
	fullPath := filepath.Join(dir, filepath.FromSlash(relPath))
	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fullPath, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}
