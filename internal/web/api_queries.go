package web

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path"
	"reflect"
	"sort"
	"strings"

	"notediscovery/internal/vault"

	"gopkg.in/yaml.v3"
)

const (
	maxQueryBytes = 8 << 10
	maxQueryRows  = 100
)

type querySpec struct {
	Type    string         `yaml:"type"`
	From    string         `yaml:"from"`
	Where   map[string]any `yaml:"where"`
	Sort    string         `yaml:"sort"`
	Order   string         `yaml:"order"`
	Columns []string       `yaml:"columns"`
	Limit   int            `yaml:"limit"`
}

type QueryRequest struct {
	Query string `json:"query"`
}

type QueryRow struct {
	Values map[string]any `json:"values"`
	Path   string         `json:"path"`
	Name   string         `json:"name"`
	sort   any
}

type QueryResponse struct {
	Type    string     `json:"type"`
	Columns []string   `json:"columns"`
	Rows    []QueryRow `json:"rows"`
}

type QueriesHandler struct {
	vault *vault.Vault
}

func NewQueriesHandler(v *vault.Vault) *QueriesHandler {
	return &QueriesHandler{vault: v}
}

func (h *QueriesHandler) Run(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxQueryBytes+1024)
	var request QueryRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid query request")
		return
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		RespondError(w, http.StatusBadRequest, "Invalid query request")
		return
	}
	if len(request.Query) == 0 || len(request.Query) > maxQueryBytes {
		RespondError(w, http.StatusBadRequest, "Query must be between 1 and 8192 bytes")
		return
	}
	spec, err := parseQuery(request.Query)
	if err != nil {
		RespondError(w, http.StatusBadRequest, err.Error())
		return
	}

	notes, _, err := h.vault.ScanNotes(false)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to scan notes for query")
		return
	}

	columns := queryColumns(spec)
	sortKey := spec.Sort
	if sortKey == "" {
		sortKey = "file.path"
	}
	rows := make([]QueryRow, 0)
	for _, note := range notes {
		if note.Type != "note" || !inQueryFolder(note.Folder, spec.From) {
			continue
		}
		content, err := h.vault.GetNoteContent(note.Path)
		if err != nil {
			RespondError(w, http.StatusInternalServerError, "Failed to read note for query")
			return
		}
		fields := queryFields(note, vault.ParseFrontmatter(content))
		if !matchesQueryWhere(fields, note.Tags, spec.Where) {
			continue
		}
		if spec.Type == "task" {
			for _, task := range queryTasks(content) {
				rowFields := make(map[string]any, len(fields)+2)
				for key, value := range fields {
					rowFields[key] = value
				}
				rowFields["task.text"] = task.text
				rowFields["task.completed"] = task.completed
				rows = append(rows, QueryRow{
					Values: selectQueryFields(rowFields, columns),
					Path:   note.Path,
					Name:   note.Name,
					sort:   rowFields[sortKey],
				})
			}
			continue
		}
		rows = append(rows, QueryRow{
			Values: selectQueryFields(fields, columns),
			Path:   note.Path,
			Name:   note.Name,
			sort:   fields[sortKey],
		})
	}

	sort.SliceStable(rows, func(i, j int) bool {
		comparison := compareQueryValues(rows[i].sort, rows[j].sort)
		if spec.Order == "desc" {
			return comparison > 0
		}
		return comparison < 0
	})
	if len(rows) > spec.Limit {
		rows = rows[:spec.Limit]
	}
	RespondJSON(w, http.StatusOK, QueryResponse{
		Type:    spec.Type,
		Columns: columns,
		Rows:    rows,
	})
}

func parseQuery(source string) (querySpec, error) {
	var spec querySpec
	decoder := yaml.NewDecoder(bytes.NewBufferString(source))
	decoder.KnownFields(true)
	if err := decoder.Decode(&spec); err != nil {
		return spec, fmt.Errorf("Invalid query YAML: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return spec, fmt.Errorf("Query must contain one YAML document")
	}

	spec.Type = strings.ToLower(strings.TrimSpace(spec.Type))
	if spec.Type != "list" && spec.Type != "table" && spec.Type != "task" {
		return spec, fmt.Errorf("Query type must be list, table, or task")
	}
	spec.From = strings.Trim(strings.ReplaceAll(strings.TrimSpace(spec.From), "\\", "/"), "/")
	if spec.From == "." || spec.From == ".." || strings.HasPrefix(spec.From, "../") {
		return spec, fmt.Errorf("Invalid query folder")
	}
	if spec.From != "" && path.Clean(spec.From) != spec.From {
		return spec, fmt.Errorf("Invalid query folder")
	}
	spec.Sort = strings.TrimSpace(spec.Sort)
	if spec.Sort != "" && !validQueryField(spec.Sort) {
		return spec, fmt.Errorf("Invalid sort field %q", spec.Sort)
	}
	spec.Order = strings.ToLower(strings.TrimSpace(spec.Order))
	if spec.Order == "" {
		spec.Order = "asc"
	}
	if spec.Order != "asc" && spec.Order != "desc" {
		return spec, fmt.Errorf("Query order must be asc or desc")
	}
	if spec.Limit == 0 {
		spec.Limit = 50
	}
	if spec.Limit < 1 || spec.Limit > maxQueryRows {
		return spec, fmt.Errorf("Query limit must be between 1 and %d", maxQueryRows)
	}
	if len(spec.Columns) > 20 {
		return spec, fmt.Errorf("Query supports at most 20 columns")
	}
	for _, column := range spec.Columns {
		if !validQueryField(column) {
			return spec, fmt.Errorf("Invalid query column %q", column)
		}
	}
	for key, value := range spec.Where {
		if !validQueryField(key) || !validQueryValue(value) {
			return spec, fmt.Errorf("Invalid query filter for %q", key)
		}
	}
	return spec, nil
}

func validQueryField(field string) bool {
	switch field {
	case "file.name", "file.path", "file.folder", "file.modified", "file.size", "file.tags",
		"task.text", "task.completed":
		return true
	}
	return strings.TrimSpace(field) != "" && !strings.ContainsAny(field, " \t\r\n")
}

func validQueryValue(value any) bool {
	switch typed := value.(type) {
	case nil, string, bool, int, int64, uint64, float64:
		return true
	case []any:
		for _, item := range typed {
			if _, isList := item.([]any); isList {
				return false
			}
			if !validQueryValue(item) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func queryColumns(spec querySpec) []string {
	if len(spec.Columns) > 0 {
		return spec.Columns
	}
	switch spec.Type {
	case "list":
		return []string{"file.name"}
	case "task":
		return []string{"task.text", "file.name"}
	default:
		return []string{"file.name", "file.modified"}
	}
}

func inQueryFolder(folder, source string) bool {
	if source == "" {
		return true
	}
	folder = strings.ToLower(folder)
	source = strings.ToLower(source)
	return folder == source || strings.HasPrefix(folder, source+"/")
}

func queryFields(note vault.NoteRecord, frontmatter vault.Frontmatter) map[string]any {
	fields := map[string]any{
		"file.name":     note.Name,
		"file.path":     note.Path,
		"file.folder":   note.Folder,
		"file.modified": note.Modified,
		"file.size":     note.Size,
		"file.tags":     note.Tags,
	}
	for _, field := range frontmatter {
		fields[field.Key] = field.Value
	}
	return fields
}

func matchesQueryWhere(fields map[string]any, tags []string, where map[string]any) bool {
	for key, expected := range where {
		actual, found := queryField(fields, key)
		if strings.EqualFold(key, "tags") || strings.EqualFold(key, "file.tags") {
			actual, found = tags, true
		}
		if !found || !queryValuesMatch(actual, expected) {
			return false
		}
	}
	return true
}

func queryField(fields map[string]any, key string) (any, bool) {
	if value, ok := fields[key]; ok {
		return value, true
	}
	for field, value := range fields {
		if strings.EqualFold(field, key) {
			return value, true
		}
	}
	parts := strings.Split(key, ".")
	value, found := queryFieldPart(fields, parts[0])
	for _, part := range parts[1:] {
		if !found {
			return nil, false
		}
		object, ok := value.(map[string]any)
		if !ok {
			return nil, false
		}
		value, found = queryFieldPart(object, part)
	}
	if found {
		return value, true
	}
	return nil, false
}

func queryFieldPart(fields map[string]any, key string) (any, bool) {
	value, found := fields[key]
	if found {
		return value, true
	}
	for field, value := range fields {
		if strings.EqualFold(field, key) {
			return value, true
		}
	}
	return nil, false
}

func compareQueryValues(left, right any) int {
	leftNumber, leftIsNumber := numericQueryValue(left)
	rightNumber, rightIsNumber := numericQueryValue(right)
	if leftIsNumber && rightIsNumber {
		switch {
		case leftNumber < rightNumber:
			return -1
		case leftNumber > rightNumber:
			return 1
		default:
			return 0
		}
	}
	if leftBool, ok := left.(bool); ok {
		if rightBool, ok := right.(bool); ok {
			if leftBool == rightBool {
				return 0
			}
			if leftBool {
				return 1
			}
			return -1
		}
	}
	return strings.Compare(strings.ToLower(displayQueryValue(left)), strings.ToLower(displayQueryValue(right)))
}

func numericQueryValue(value any) (float64, bool) {
	if value == nil {
		return 0, false
	}
	ref := reflect.ValueOf(value)
	switch ref.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return float64(ref.Int()), true
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return float64(ref.Uint()), true
	case reflect.Float32, reflect.Float64:
		return ref.Float(), true
	default:
		return 0, false
	}
}

func queryValuesMatch(actual, expected any) bool {
	actualValues, actualIsList := actual.([]any)
	if !actualIsList {
		if values, ok := actual.([]string); ok {
			actualValues = make([]any, len(values))
			for i, value := range values {
				actualValues[i] = value
			}
			actualIsList = true
		}
	}
	expectedValues, expectedIsList := expected.([]any)
	if !expectedIsList {
		expectedValues = []any{expected}
	}
	if actualIsList {
		for _, actualValue := range actualValues {
			for _, expectedValue := range expectedValues {
				if queryScalarEqual(actualValue, expectedValue) {
					return true
				}
			}
		}
		return false
	}
	for _, expectedValue := range expectedValues {
		if queryScalarEqual(actual, expectedValue) {
			return true
		}
	}
	return false
}

func queryScalarEqual(left, right any) bool {
	if leftString, ok := left.(string); ok {
		if rightString, ok := right.(string); ok {
			return strings.EqualFold(leftString, rightString)
		}
	}
	return reflect.DeepEqual(left, right)
}

func selectQueryFields(fields map[string]any, columns []string) map[string]any {
	selected := make(map[string]any, len(columns))
	for _, column := range columns {
		value, found := queryField(fields, column)
		if found {
			selected[column] = value
		} else {
			selected[column] = nil
		}
	}
	return selected
}

func displayQueryValue(value any) string {
	if value == nil {
		return ""
	}
	switch typed := value.(type) {
	case []string:
		return strings.Join(typed, ", ")
	case []any:
		values := make([]string, len(typed))
		for i, item := range typed {
			values[i] = displayQueryValue(item)
		}
		return strings.Join(values, ", ")
	default:
		return fmt.Sprint(value)
	}
}

type queryTask struct {
	text      string
	completed bool
}

func queryTasks(content string) []queryTask {
	body := vault.StripFrontmatter(content)
	var tasks []queryTask
	var fence byte
	fenceLength := 0
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if fence != 0 {
			if len(trimmed) >= fenceLength && strings.Trim(trimmed, string(fence)) == "" {
				fence = 0
				fenceLength = 0
			}
			continue
		}
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			fence = trimmed[0]
			fenceLength = len(trimmed) - len(strings.TrimLeft(trimmed, string(fence)))
			continue
		}
		if len(trimmed) < 6 || (trimmed[0] != '-' && trimmed[0] != '*' && trimmed[0] != '+') {
			continue
		}
		item := strings.TrimSpace(trimmed[1:])
		if len(item) < 4 || item[0] != '[' || item[2] != ']' || (item[1] != ' ' && item[1] != 'x' && item[1] != 'X') {
			continue
		}
		tasks = append(tasks, queryTask{
			text:      strings.TrimSpace(item[3:]),
			completed: item[1] == 'x' || item[1] == 'X',
		})
	}
	return tasks
}
