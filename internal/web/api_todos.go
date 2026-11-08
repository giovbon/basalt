package web

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"notediscovery/internal/config"
	"notediscovery/internal/search"
	"notediscovery/internal/vault"
)

const (
	maxTodoKeywords    = 50
	maxTodoKeywordSize = 64
)

type TodoItem struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Keyword    string `json:"keyword"`
	LineNumber int    `json:"line_number"`
	Column     int    `json:"column"`
	Context    string `json:"context"`
}

type TodosResponse struct {
	Todos []TodoItem `json:"todos"`
}

type TodosHandler struct {
	vault *vault.Vault
	cfg   *config.Config
}

func NewTodosHandler(cfg *config.Config, v *vault.Vault) *TodosHandler {
	return &TodosHandler{vault: v, cfg: cfg}
}

func (h *TodosHandler) ListTodos(w http.ResponseWriter, r *http.Request) {
	h.cfg.SettingsMu.RLock()
	configuredKeywords := h.cfg.Todos.Keywords
	h.cfg.SettingsMu.RUnlock()
	keywords, err := parseTodoKeywords([]string{configuredKeywords})
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Invalid TODO keyword configuration")
		return
	}

	todos := []TodoItem{}
	if len(keywords) == 0 {
		RespondJSON(w, http.StatusOK, TodosResponse{Todos: todos})
		return
	}

	notes, _, err := h.vault.ScanNotes(false)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to scan TODOs")
		return
	}

	for _, note := range notes {
		if note.Type != "note" {
			continue
		}
		content, err := h.vault.GetNoteContent(note.Path)
		if err != nil {
			RespondError(w, http.StatusInternalServerError, "Failed to scan TODOs")
			return
		}

		for lineIndex, line := range strings.Split(content, "\n") {
			for _, keyword := range keywords {
				for _, match := range keyword.pattern.FindAllStringIndex(line, -1) {
					start, end := match[0], match[1]
					if !isTodoWordBoundary(line, start, end) {
						continue
					}
					_, _, snippet := search.ExtractSnippet(line, search.Span{Start: start, End: end})
					todos = append(todos, TodoItem{
						Name:       note.Name,
						Path:       note.Path,
						Keyword:    keyword.name,
						LineNumber: lineIndex + 1,
						Column:     utf8.RuneCountInString(line[:start]) + 1,
						Context:    snippet,
					})
				}
			}
		}
	}

	sort.Slice(todos, func(i, j int) bool {
		if todos[i].Path != todos[j].Path {
			return strings.ToLower(todos[i].Path) < strings.ToLower(todos[j].Path)
		}
		if todos[i].LineNumber != todos[j].LineNumber {
			return todos[i].LineNumber < todos[j].LineNumber
		}
		if todos[i].Column != todos[j].Column {
			return todos[i].Column < todos[j].Column
		}
		return strings.ToLower(todos[i].Keyword) < strings.ToLower(todos[j].Keyword)
	})

	RespondJSON(w, http.StatusOK, TodosResponse{Todos: todos})
}

type TodoKeywordsResponse struct {
	Keywords string `json:"keywords"`
}

func (h *TodosHandler) UpdateKeywords(w http.ResponseWriter, r *http.Request) {
	if h.cfg.ConfigFile == "" {
		RespondError(w, http.StatusInternalServerError, "Config file path is unavailable")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var payload TodoKeywordsResponse
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid TODO keywords")
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		RespondError(w, http.StatusBadRequest, "Invalid TODO keywords")
		return
	}

	keywords, err := parseTodoKeywords([]string{payload.Keywords})
	if err != nil {
		RespondError(w, http.StatusBadRequest, err.Error())
		return
	}
	names := make([]string, len(keywords))
	for i, keyword := range keywords {
		names[i] = keyword.name
	}
	normalized := strings.Join(names, ", ")

	h.cfg.SettingsMu.Lock()
	defer h.cfg.SettingsMu.Unlock()
	if err := config.SaveTodoKeywords(h.cfg.ConfigFile, normalized); err != nil {
		RespondError(w, http.StatusInternalServerError, SafeErrorMessage(err, "Failed to save TODO keywords", h.cfg.Server.Debug))
		return
	}
	h.cfg.Todos.Keywords = normalized
	RespondJSON(w, http.StatusOK, TodoKeywordsResponse{Keywords: normalized})
}

type todoKeyword struct {
	name    string
	pattern *regexp.Regexp
}

func parseTodoKeywords(values []string) ([]todoKeyword, error) {
	seen := make(map[string]bool)
	keywords := make([]todoKeyword, 0)
	for _, value := range values {
		for _, raw := range strings.Split(value, ",") {
			name := strings.TrimSpace(raw)
			if name == "" {
				continue
			}
			if utf8.RuneCountInString(name) > maxTodoKeywordSize {
				return nil, errors.New("TODO keywords must be at most 64 characters")
			}
			name = strings.TrimSuffix(name, ":")
			if name == "" {
				continue
			}
			name = strings.ToUpper(name)
			key := strings.ToLower(name)
			if seen[key] {
				continue
			}
			if len(keywords) >= maxTodoKeywords {
				return nil, errors.New("No more than 50 TODO keywords are allowed")
			}
			seen[key] = true
			keywords = append(keywords, todoKeyword{
				name:    name,
				pattern: regexp.MustCompile(regexp.QuoteMeta(name) + ":"),
			})
		}
	}
	return keywords, nil
}

func isTodoWordBoundary(line string, start, end int) bool {
	if start > 0 {
		r, _ := utf8.DecodeLastRuneInString(line[:start])
		if isTodoWordRune(r) {
			return false
		}
	}
	if end < len(line) {
		r, _ := utf8.DecodeRuneInString(line[end:])
		if isTodoWordRune(r) {
			return false
		}
	}
	return true
}

func isTodoWordRune(r rune) bool {
	return r == '_' || unicode.IsLetter(r) || unicode.IsNumber(r)
}
