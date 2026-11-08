package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"notediscovery/internal/config"
	"notediscovery/internal/vault"
)

func TestListTodosUsesConfiguredKeywordsAndWordBoundaries(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "projects"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "projects", "plan.md"), []byte(
		"TODO: first\ntodo: lowercase is ignored\nA LATER: item and TODO: again\nTODOLIST: unrelated\nTODO without colon\n",
	), 0644); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{Todos: config.TodosConfig{Keywords: "todo,LATER,TODO"}}
	h := NewTodosHandler(cfg, vault.New(dir))

	req := httptest.NewRequest(http.MethodGet, "/api/todos?keywords=IGNORED", nil)
	rec := httptest.NewRecorder()
	h.ListTodos(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}

	var response TodosResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Todos) != 3 {
		t.Fatalf("got %d todos, want 3: %#v", len(response.Todos), response.Todos)
	}
	want := []TodoItem{
		{Name: "plan", Path: "projects/plan.md", Keyword: "TODO", LineNumber: 1, Column: 1, Context: `<mark class="search-highlight">TODO:</mark> first`},
		{Name: "plan", Path: "projects/plan.md", Keyword: "LATER", LineNumber: 3, Column: 3},
		{Name: "plan", Path: "projects/plan.md", Keyword: "TODO", LineNumber: 3, Column: 19},
	}
	for i := range want {
		got := response.Todos[i]
		if got.Name != want[i].Name || got.Path != want[i].Path || got.Keyword != want[i].Keyword ||
			got.LineNumber != want[i].LineNumber || got.Column != want[i].Column {
			t.Errorf("todo[%d] = %#v, want %#v", i, response.Todos[i], want[i])
		}
	}
	if !strings.Contains(response.Todos[1].Context, `<mark class="search-highlight">LATER:</mark>`) ||
		!strings.Contains(response.Todos[2].Context, `<mark class="search-highlight">TODO:</mark>`) {
		t.Errorf("TODO contexts do not highlight their matched keyword: %#v", response.Todos)
	}
}

func TestUpdateTodoKeywordsValidatesLimits(t *testing.T) {
	h := NewTodosHandler(&config.Config{ConfigFile: filepath.Join(t.TempDir(), "config.yaml")}, vault.New(t.TempDir()))
	req := httptest.NewRequest(http.MethodPost, "/api/todos/config", strings.NewReader(
		`{"keywords":"`+strings.Repeat("x", 65)+`"}`,
	))
	rec := httptest.NewRecorder()
	h.UpdateKeywords(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestUpdateTodoKeywordsPersistsForTodoListing(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(configPath, []byte("app:\n  name: Keep me\n"), 0644); err != nil {
		t.Fatal(err)
	}
	notesDir := filepath.Join(dir, "notes")
	if err := os.Mkdir(notesDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(notesDir, "plan.md"), []byte("IDEA: saved\nTODO: old\n"), 0644); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{ConfigFile: configPath}
	h := NewTodosHandler(cfg, vault.New(notesDir))
	req := httptest.NewRequest(http.MethodPost, "/api/todos/config", strings.NewReader(`{"keywords":"idea, IDEA"}`))
	rec := httptest.NewRecorder()
	h.UpdateKeywords(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if cfg.Todos.Keywords != "IDEA" {
		t.Fatalf("configured keywords = %q, want IDEA", cfg.Todos.Keywords)
	}
	var response TodoKeywordsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Keywords != "IDEA" {
		t.Fatalf("response keywords = %q, want IDEA", response.Keywords)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/todos", nil)
	rec = httptest.NewRecorder()
	h.ListTodos(rec, req)
	var todos TodosResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &todos); err != nil {
		t.Fatal(err)
	}
	if len(todos.Todos) != 1 || todos.Todos[0].Keyword != "IDEA" {
		t.Fatalf("listed TODOs = %#v, want the configured IDEA marker only", todos.Todos)
	}

	saved, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(saved), `keywords: IDEA`) || !strings.Contains(string(saved), "name: Keep me") {
		t.Fatalf("saved config did not preserve unrelated settings and keywords: %s", saved)
	}
}
