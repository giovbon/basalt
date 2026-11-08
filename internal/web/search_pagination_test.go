package web

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"notediscovery/internal/config"
	"notediscovery/internal/session"
	"notediscovery/internal/vault"
)

// newSearchTestRouter is newTestRouter with search enabled (the shared helper
// leaves it off, which is the default config).
func newSearchTestRouter(t *testing.T) *Server {
	t.Helper()
	cfg := &config.Config{
		App:    config.AppConfig{Name: "Basalt", Version: "1.0.0"},
		Server: config.ServerConfig{AllowedOrigins: []string{"*"}},
		Search: config.SearchConfig{Enabled: true},
	}
	v := vault.New(t.TempDir())
	sess := session.NewManager("test-secret", "", "", 3600, false)
	return NewServer(cfg, v, sess, fstest.MapFS{})
}

// TestSearchPaginationKeepsTotals guards the early-exit path: notes outside the
// requested page are counted but must not change the page contents, and
// "total"/"has_more" must describe the whole result set.
func TestSearchPaginationKeepsTotals(t *testing.T) {
	s := newSearchTestRouter(t)

	const total = 5
	for i := 0; i < total; i++ {
		body, err := json.Marshal(SaveNotePayload{
			Content: fmt.Sprintf("# Nota %d\n\ntermo alfa em todas as notas.\n", i),
		})
		if err != nil {
			t.Fatal(err)
		}

		req := httptest.NewRequest("POST", fmt.Sprintf("/api/notes/nota-%d.md", i), bytes.NewBuffer(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("create %d: status = %d: %s", i, rec.Code, rec.Body.String())
		}
	}

	search := func(query string) SearchResponse {
		t.Helper()
		req := httptest.NewRequest("GET", "/api/search?"+query, nil)
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("search %q: status = %d: %s", query, rec.Code, rec.Body.String())
		}
		var resp SearchResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("search %q: %v", query, err)
		}
		return resp
	}

	all := search("q=alfa")
	if len(all.Results) != total {
		t.Errorf("sem limit: results = %d, want %d", len(all.Results), total)
	}
	if all.Pagination != nil {
		t.Errorf("sem limit: pagination = %+v, want nil", all.Pagination)
	}

	first := search("q=alfa&limit=2")
	if len(first.Results) != 2 {
		t.Errorf("limit=2: results = %d, want 2", len(first.Results))
	}
	if first.Pagination == nil {
		t.Fatal("limit=2: pagination missing")
	}
	if first.Pagination.Total != total {
		t.Errorf("limit=2: total = %d, want %d", first.Pagination.Total, total)
	}
	if !first.Pagination.HasMore {
		t.Error("limit=2: has_more = false, want true")
	}

	last := search("q=alfa&limit=2&offset=4")
	if len(last.Results) != 1 {
		t.Errorf("offset=4: results = %d, want 1", len(last.Results))
	}
	if last.Pagination == nil || last.Pagination.HasMore {
		t.Errorf("offset=4: has_more = %+v, want false", last.Pagination)
	}

	// Every matched note is counted even when the first page fills up early.
	if first.Results[0].TotalMatches != 1 {
		t.Errorf("total_matches = %d, want 1", first.Results[0].TotalMatches)
	}
}

func TestSearchWholeWordIsDefaultAndCanBeDisabled(t *testing.T) {
	s := newSearchTestRouter(t)
	for path, content := range map[string]string{
		"match.md":     "# ESM\n",
		"substring.md": "# mesma\n",
	} {
		body, err := json.Marshal(SaveNotePayload{Content: content})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest("POST", "/api/notes/"+path, bytes.NewBuffer(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("create %s: status = %d: %s", path, rec.Code, rec.Body.String())
		}
	}

	search := func(query string) SearchResponse {
		t.Helper()
		req := httptest.NewRequest("GET", "/api/search?q=ESM"+query, nil)
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("search: status = %d: %s", rec.Code, rec.Body.String())
		}
		var resp SearchResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode search response: %v", err)
		}
		return resp
	}

	exact := search("")
	if len(exact.Results) != 1 || exact.Results[0].Path != "match.md" {
		t.Errorf("default exact results = %#v, want only match.md", exact.Results)
	}
	partial := search("&whole_word=false")
	if len(partial.Results) != 2 {
		t.Errorf("substring result count = %d, want 2", len(partial.Results))
	}
}
