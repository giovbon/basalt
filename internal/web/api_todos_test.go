package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
	h := NewTodosHandler(vault.New(dir))

	req := httptest.NewRequest(http.MethodGet, "/api/todos?keywords=todo%2CLATER%2CTODO", nil)
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

func TestListTodosValidatesKeywordLimits(t *testing.T) {
	h := NewTodosHandler(vault.New(t.TempDir()))
	req := httptest.NewRequest(http.MethodGet, "/api/todos?keywords="+url.QueryEscape(strings.Repeat("x", 65)), nil)
	rec := httptest.NewRecorder()
	h.ListTodos(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}
