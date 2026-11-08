package search

import (
	"html"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

var nfdTransformer = transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)))

// foldRuneCache memoizes the per-rune fold. Notes reuse the same accented
// characters thousands of times, and every NFD transform allocates; caching
// turns that into one transform per distinct rune.
var foldRuneCache sync.Map // rune -> string

func foldRune(r rune) string {
	if v, ok := foldRuneCache.Load(r); ok {
		return v.(string)
	}
	f := Fold(string(r))
	foldRuneCache.Store(r, f)
	return f
}

// Fold lowers the text and removes combining accents (NFD decomposition).
func Fold(text string) string {
	lowered := strings.ToLower(text)
	result, _, err := transform.String(nfdTransformer, lowered)
	if err != nil {
		return lowered
	}
	return result
}

// Span represents a match start and end index in the original string.
type Span struct {
	Start int
	End   int
}

// isASCIIContent reports whether every byte of s is a 7-bit ASCII byte. It is
// the same predicate FoldedMatchSpansWithCount uses to pick its fast path, so
// FoldContent and the span extractor always fold text the same way.
func isASCIIContent(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= unicode.MaxASCII {
			return false
		}
	}
	return true
}

// foldNonASCII folds content (lowercase + strip combining marks), handling
// maximal ASCII runs in bulk: NFD decomposition and mark stripping are no-ops
// on ASCII and strings.ToLower folds ASCII byte-wise, so folding a run at once
// is byte-identical to folding each of its runes — only the accented runes pay
// the full per-rune Fold pipeline.
//
// When origins is non-nil it receives one entry per byte of the folded output
// holding the content byte offset of the rune that byte came from — the
// mapping FoldedMatchSpansWithCount needs to report spans in the original
// content.
//
// FoldContent passes nil and FoldedMatchSpansWithCount passes a slice, so both
// callers are guaranteed to search in byte-identical folded text.
func foldNonASCII(content string, origins *[]int32) string {
	var foldedBuilder strings.Builder
	foldedBuilder.Grow(len(content))
	i := 0
	for i < len(content) {
		if content[i] < utf8.RuneSelf {
			// ASCII run: fold it in one ToLower call. Each ASCII byte is one
			// rune and ToLower preserves the length, so origins stays aligned.
			j := i + 1
			for j < len(content) && content[j] < utf8.RuneSelf {
				j++
			}
			run := strings.ToLower(content[i:j])
			foldedBuilder.WriteString(run)
			if origins != nil {
				for k := 0; k < len(run); k++ {
					*origins = append(*origins, int32(i+k))
				}
			}
			i = j
			continue
		}
		r, size := utf8.DecodeRuneInString(content[i:])
		f := foldRune(r)
		foldedBuilder.WriteString(f)
		if origins != nil {
			for k := 0; k < len(f); k++ {
				*origins = append(*origins, int32(i))
			}
		}
		i += size
	}
	return foldedBuilder.String()
}

// foldOrigins builds only the folded-byte -> content-byte map, letting search
// match against the already cached folded text instead of rebuilding it.
func foldOrigins(content string) []int32 {
	origins := make([]int32, 0, len(content))
	i := 0
	for i < len(content) {
		if content[i] < utf8.RuneSelf {
			j := i + 1
			for j < len(content) && content[j] < utf8.RuneSelf {
				j++
			}
			for k := i; k < j; k++ {
				origins = append(origins, int32(k))
			}
			i = j
			continue
		}
		r, size := utf8.DecodeRuneInString(content[i:])
		f := foldRune(r)
		for k := 0; k < len(f); k++ {
			origins = append(origins, int32(i))
		}
		i += size
	}
	return origins
}

// FoldContent returns the accent-folded, lowercased form of content: the exact
// text FoldedMatchSpansWithCount matches the folded query against. Callers
// cache it so a search only folds each note once instead of once per query.
func FoldContent(content string) string {
	if content == "" {
		return ""
	}
	if !isASCIIContent(content) {
		return foldNonASCII(content, nil)
	}
	return strings.ToLower(content)
}

// FoldedMatchSpans finds foldedQuery in content and returns up to limit (start, end)
// byte spans in the original content. A non-positive limit means "no limit".
func FoldedMatchSpans(content string, foldedQuery string, limit int) []Span {
	spans, _ := FoldedMatchSpansWithCount(content, foldedQuery, limit)
	return spans
}

// FoldedMatchSpansWithCount is FoldedMatchSpans plus the total number of
// occurrences in content. The total can be larger than len(spans) when limit
// is positive, which lets callers show "showing N of M" without collecting
// every snippet. If content is ASCII, it avoids per-character mapping.
func FoldedMatchSpansWithCount(content string, foldedQuery string, limit int) ([]Span, int) {
	return foldedMatchSpansWithCount(content, foldedQuery, limit, false)
}

// FoldedWordMatchSpansWithCount matches foldedQuery only when it is bounded by
// non-word characters (or the start/end of content).
func FoldedWordMatchSpansWithCount(content string, foldedQuery string, limit int) ([]Span, int) {
	return foldedMatchSpansWithCount(content, foldedQuery, limit, true)
}

// ContainsWholeWord reports whether foldedQuery occurs in foldedContent as a
// whole word. Both arguments must already be folded.
func ContainsWholeWord(foldedContent, foldedQuery string) bool {
	if foldedQuery == "" {
		return false
	}
	pos := strings.Index(foldedContent, foldedQuery)
	for pos != -1 {
		if hasWordBoundaries(foldedContent, pos, pos+len(foldedQuery)) {
			return true
		}
		next := pos + len(foldedQuery)
		pos = strings.Index(foldedContent[next:], foldedQuery)
		if pos != -1 {
			pos += next
		}
	}
	return false
}

func foldedMatchSpansWithCount(content string, foldedQuery string, limit int, wholeWord bool) ([]Span, int) {
	if foldedQuery == "" || len(content) == 0 {
		return nil, 0
	}

	if isASCIIContent(content) {
		return spansInFolded(content, strings.ToLower(content), foldedQuery, limit, nil, wholeWord)
	}

	// Fold with origins: folded byte -> content byte offset of its origin
	// rune. That mapping alone is enough to report spans, so no per-note rune
	// table has to be built (it used to cost two slices the size of content).
	var origins []int32
	folded := foldNonASCII(content, &origins)
	return spansInFolded(content, folded, foldedQuery, limit, origins, wholeWord)
}

// FoldedMatchSpansInFolded is FoldedMatchSpansWithCount for callers that
// already hold FoldContent(content). ASCII notes reuse the cached folded text
// directly; non-ASCII notes rebuild only the compact offset map. Either way the
// note is never folded twice for a single search request.
func FoldedMatchSpansInFolded(content, foldedContent, foldedQuery string, limit int) ([]Span, int) {
	return FoldedMatchSpansInFoldedWithOptions(content, foldedContent, foldedQuery, limit, false)
}

// FoldedMatchSpansInFoldedWithOptions optionally requires matches to occupy a
// whole word, reusing foldedContent when it matches content.
func FoldedMatchSpansInFoldedWithOptions(content, foldedContent, foldedQuery string, limit int, wholeWord bool) ([]Span, int) {
	if foldedQuery == "" || len(content) == 0 || len(foldedContent) == 0 {
		return nil, 0
	}

	if isASCIIContent(content) {
		if len(foldedContent) != len(content) {
			return foldedMatchSpansWithCount(content, foldedQuery, limit, wholeWord)
		}
		return spansInFolded(content, foldedContent, foldedQuery, limit, nil, wholeWord)
	}

	origins := foldOrigins(content)
	if len(origins) != len(foldedContent) {
		// The cached fold does not match this content (the note changed after
		// the scan). Fall back to a self-consistent fold rather than reporting
		// spans against the wrong bytes.
		return foldedMatchSpansWithCount(content, foldedQuery, limit, wholeWord)
	}
	return spansInFolded(content, foldedContent, foldedQuery, limit, origins, wholeWord)
}

// spansInFolded finds foldedQuery in folded. A nil origins slice means folded
// is 1:1 with content bytes (the ASCII fast path); otherwise each folded byte
// maps to the content byte offset of the rune it came from.
func spansInFolded(content, folded, foldedQuery string, limit int, origins []int32, wholeWord bool) ([]Span, int) {
	var spans []Span
	total := 0
	pos := strings.Index(folded, foldedQuery)
	for pos != -1 {
		endPos := pos + len(foldedQuery)
		if !wholeWord || hasWordBoundaries(folded, pos, endPos) {
			total++

			if limit <= 0 || len(spans) < limit {
				if origins == nil {
					spans = append(spans, Span{Start: pos, End: endPos})
				} else {
					startByte := int(origins[pos])
					// Step over the last matched rune, then keep any combining
					// accents attached to it in the span.
					lastByte := int(origins[endPos-1])
					_, size := utf8.DecodeRuneInString(content[lastByte:])
					endByte := lastByte + size
					for endByte < len(content) {
						r, sz := utf8.DecodeRuneInString(content[endByte:])
						if !unicode.Is(unicode.Mn, r) {
							break
						}
						endByte += sz
					}

					spans = append(spans, Span{Start: startByte, End: endByte})
				}
			}
		}

		pos = strings.Index(folded[endPos:], foldedQuery)
		if pos != -1 {
			pos += endPos
		}
	}

	return spans, total
}

func isWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_'
}

func hasWordBoundaries(text string, start, end int) bool {
	if start > 0 {
		r, _ := utf8.DecodeLastRuneInString(text[:start])
		if isWordRune(r) {
			return false
		}
	}
	if end < len(text) {
		r, _ := utf8.DecodeRuneInString(text[end:])
		if isWordRune(r) {
			return false
		}
	}
	return true
}

// EscapeHTML escapes special characters with Python html.escape parity (including &#x27;)
func EscapeHTML(s string) string {
	escaped := html.EscapeString(s)
	// Go html.EscapeString converts ' to &#39;, Python html.escape uses &#x27;
	return strings.ReplaceAll(escaped, "&#39;", "&#x27;")
}

type SearchMatch struct {
	LineNumber int    `json:"line_number"`
	Column     int    `json:"column"`
	Context    string `json:"context"`
}

type SearchResult struct {
	Name         string        `json:"name"`
	Path         string        `json:"path"`
	Folder       string        `json:"folder"`
	Matches      []SearchMatch `json:"matches"`
	TotalMatches int           `json:"total_matches"`
}

// LineIndex holds the byte offset at which each line of a note starts.
type LineIndex []int

// BuildLineIndex records every line start once, so locating many matches in
// the same note costs a binary search instead of a full scan per match.
func BuildLineIndex(content string) LineIndex {
	lines := make(LineIndex, 1, strings.Count(content, "\n")+1)
	lines[0] = 0
	for i := 0; i < len(content); i++ {
		if content[i] == '\n' {
			lines = append(lines, i+1)
		}
	}
	return lines
}

// locate returns the start offset and 1-based number of the line containing
// offset.
func (li LineIndex) locate(offset int) (lineStart, lineNum int) {
	if len(li) == 0 {
		return 0, 1
	}
	lo, hi := 0, len(li)-1
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if li[mid] <= offset {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	return li[lo], lo + 1
}

// ExtractSnippet builds the HTML snippet with <mark class="search-highlight">.
// It also returns the 1-based line and column (in runes) of the match start.
func ExtractSnippet(content string, span Span) (lineNum int, column int, snippet string) {
	return ExtractSnippetAt(content, span, BuildLineIndex(content))
}

// ExtractSnippetAt is ExtractSnippet for callers locating several spans in the
// same content: build the LineIndex once and pass it to every call.
func ExtractSnippetAt(content string, span Span, lines LineIndex) (lineNum int, column int, snippet string) {
	start := span.Start
	end := span.End

	contextStart := start - 15
	if contextStart < 0 {
		contextStart = 0
	}
	// Do not slice through the middle of a multi-byte rune.
	for contextStart > 0 && !utf8.RuneStart(content[contextStart]) {
		contextStart--
	}
	contextEnd := end + 15
	if contextEnd > len(content) {
		contextEnd = len(content)
	}
	for contextEnd < len(content) && !utf8.RuneStart(content[contextEnd]) {
		contextEnd++
	}

	before := EscapeHTML(strings.ReplaceAll(content[contextStart:start], "\n", " "))
	after := EscapeHTML(strings.ReplaceAll(content[end:contextEnd], "\n", " "))
	matchedClean := EscapeHTML(strings.ReplaceAll(content[start:end], "\n", " "))

	snippet = before + `<mark class="search-highlight">` + matchedClean + `</mark>` + after
	if contextStart > 0 {
		snippet = "..." + snippet
	}
	if contextEnd < len(content) {
		snippet = snippet + "..."
	}

	lineStart, lineNum := lines.locate(start)
	column = utf8.RuneCountInString(content[lineStart:start]) + 1
	return lineNum, column, snippet
}
