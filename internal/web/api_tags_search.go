package web

import (
	"net/http"
	"path/filepath"
	"sort"
	"strings"

	"notediscovery/internal/config"
	"notediscovery/internal/search"
	"notediscovery/internal/vault"
)

type TagsSearchHandler struct {
	cfg   *config.Config
	vault *vault.Vault
}

func NewTagsSearchHandler(cfg *config.Config, v *vault.Vault) *TagsSearchHandler {
	return &TagsSearchHandler{
		cfg:   cfg,
		vault: v,
	}
}

func (h *TagsSearchHandler) GetAllTags(w http.ResponseWriter, r *http.Request) {
	tagCounts, err := h.vault.TagCounts()
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to load tags")
		return
	}

	RespondJSON(w, http.StatusOK, map[string]any{
		"tags": tagCounts,
	})
}

// tagMatches compares a note tag with an already-lowercased query tag. The
// equality fast path avoids an allocation for the common already-lowercase tag.
func tagMatches(tag, tagLower string) bool {
	if tag == tagLower {
		return true
	}
	return strings.ToLower(tag) == tagLower
}

type TagNoteItem struct {
	Name     string   `json:"name"`
	Path     string   `json:"path"`
	Folder   string   `json:"folder"`
	Modified string   `json:"modified"`
	Size     int64    `json:"size"`
	Tags     []string `json:"tags"`

	// pathLower is the sort key, computed once when the item is built instead
	// of on every comparison.
	pathLower string
}

type GetTagResponse struct {
	Tag        string          `json:"tag"`
	Count      int             `json:"count"`
	Notes      []TagNoteItem   `json:"notes"`
	Pagination *PaginationInfo `json:"pagination,omitempty"`
}

func (h *TagsSearchHandler) GetNotesByTag(w http.ResponseWriter, r *http.Request) {
	tagName := r.PathValue("tag")
	tagLower := strings.ToLower(tagName)

	notes, _, err := h.vault.ScanNotes(false)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to load tags")
		return
	}

	var matched []TagNoteItem
	for _, n := range notes {
		hasTag := false
		for _, t := range n.Tags {
			if tagMatches(t, tagLower) {
				hasTag = true
				break
			}
		}
		if hasTag {
			matched = append(matched, TagNoteItem{
				Name:      n.Name,
				Path:      n.Path,
				Folder:    n.Folder,
				Modified:  n.Modified,
				Size:      n.Size,
				Tags:      n.Tags,
				pathLower: strings.ToLower(n.Path),
			})
		}
	}

	// Python: sorted by path.lower()
	sort.Slice(matched, func(i, j int) bool {
		return matched[i].pathLower < matched[j].pathLower
	})

	limit, offset := ParsePaginationParams(r)
	paginated := Paginate(matched, limit, offset)

	if paginated.Items == nil {
		paginated.Items = []TagNoteItem{}
	}

	resp := GetTagResponse{
		Tag:        tagName,
		Count:      len(matched),
		Notes:      paginated.Items,
		Pagination: paginated.Pagination,
	}

	RespondJSON(w, http.StatusOK, resp)
}

type SearchResponse struct {
	Results    []search.SearchResult `json:"results"`
	Query      string                `json:"query"`
	Message    string                `json:"message,omitempty"`
	Pagination *PaginationInfo       `json:"pagination,omitempty"`
}

// maxSearchMatchesPerNote bounds the snippets returned for one note. The total
// occurrence count is still reported so the sidebar can show "N of M" when a
// note contains more matches than this.
const maxSearchMatchesPerNote = 100

func (h *TagsSearchHandler) SearchNotes(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.Search.Enabled {
		RespondError(w, http.StatusForbidden, "Search is disabled")
		return
	}

	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		RespondJSON(w, http.StatusOK, SearchResponse{
			Results: []search.SearchResult{},
			Query:   "",
			Message: "No search term provided",
		})
		return
	}

	if len([]rune(query)) < 2 {
		RespondJSON(w, http.StatusOK, SearchResponse{
			Results: []search.SearchResult{},
			Query:   query,
		})
		return
	}

	foldedQuery := search.Fold(query)
	if foldedQuery == "" {
		RespondJSON(w, http.StatusOK, SearchResponse{
			Results: []search.SearchResult{},
			Query:   query,
		})
		return
	}
	wholeWord := r.URL.Query().Get("whole_word") != "false"

	notes, _, err := h.vault.ScanNotes(false)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to perform search")
		return
	}

	// The snapshot is already ordered by MTime descending, so no per-request
	// sort of the whole vault is needed here.

	limit, offset := ParsePaginationParams(r)

	// Notes outside the requested page are still counted (so "total" and
	// "has_more" stay exact) but never read or snippet-extracted: with a big
	// vault the cost is one pass over the folded text, not N file reads.
	pageStart, pageEnd := pageWindow(limit, offset)

	results := []search.SearchResult{}
	matched := 0
	for _, n := range notes {
		if n.Type != "note" {
			continue
		}

		// Cheap reject first: the accent-folded text is cached per note in the
		// index and keyed by the stat the scan already took, so a query that
		// matches nothing never reads or stats a single file.
		folded, err := h.vault.FoldedContentForRecord(n)
		if err != nil {
			continue
		}
		if wholeWord {
			if !search.ContainsWholeWord(folded, foldedQuery) {
				continue
			}
		} else if !strings.Contains(folded, foldedQuery) {
			continue
		}

		matched++
		if matched <= pageStart || matched > pageEnd {
			continue
		}

		// Only notes on the requested page pay for content and snippet
		// extraction. The content and folded text come from one stat so the
		// spans can be mapped without re-folding the note.
		content, folded, err := h.vault.NoteContentAndFolded(n.Path)
		if err != nil {
			continue
		}

		spans, totalMatches := search.FoldedMatchSpansInFoldedWithOptions(content, folded, foldedQuery, maxSearchMatchesPerNote, wholeWord)
		if totalMatches == 0 {
			continue
		}

		// Line starts are computed once per note; locating each match then
		// costs a binary search instead of two full scans of the content.
		lineIndex := search.BuildLineIndex(content)
		var matches []search.SearchMatch
		for _, sp := range spans {
			lineNum, column, snippet := search.ExtractSnippetAt(content, sp, lineIndex)
			matches = append(matches, search.SearchMatch{
				LineNumber: lineNum,
				Column:     column,
				Context:    snippet,
			})
		}

		folder := filepath.Dir(n.Path)
		if folder == "." {
			folder = ""
		}

		results = append(results, search.SearchResult{
			Name:         n.Name,
			Path:         n.Path,
			Folder:       folder,
			Matches:      matches,
			TotalMatches: totalMatches,
		})
	}

	var pagination *PaginationInfo
	if limit != nil {
		lim := *limit
		if lim < 0 {
			lim = 0
		}
		off := offset
		if off < 0 {
			off = 0
		}
		if off > matched {
			off = matched
		}
		pagination = &PaginationInfo{
			Limit:   &lim,
			Offset:  off,
			Total:   matched,
			HasMore: off+lim < matched,
		}
	}

	resp := SearchResponse{
		Results:    results,
		Query:      query,
		Pagination: pagination,
	}

	RespondJSON(w, http.StatusOK, resp)
}
