package web

import (
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

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
}

func NewTodosHandler(v *vault.Vault) *TodosHandler {
	return &TodosHandler{vault: v}
}

func (h *TodosHandler) ListTodos(w http.ResponseWriter, r *http.Request) {
	keywords, err := parseTodoKeywords(r.URL.Query()["keywords"])
	if err != nil {
		RespondError(w, http.StatusBadRequest, err.Error())
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
				pattern: regexp.MustCompile("(?i)" + regexp.QuoteMeta(name) + ":"),
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
