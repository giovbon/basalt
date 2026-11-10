package vault

import (
	"net/url"
	"path/filepath"
	"sort"
	"strings"
)

// backlinkOcc is one link occurrence stored in the reverse index. Line,
// context and type mirror LinkOcc so GetBacklinks can answer from the index
// instead of walking every note.
type backlinkOcc struct {
	source  string
	line    int
	typ     string
	context string
}

// backlinkIndex maps every normalized link target to the occurrences that
// mention it. It is built once per scan snapshot and then read-only, so a
// backlinks request costs a few map lookups instead of a pass over the vault.
type backlinkIndex struct {
	occs  []backlinkOcc
	wiki  map[string][]int32
	md    map[string][]int32
	order map[string]int    // source path -> position in the MTime-sorted snapshot
	name  map[string]string // source path -> note name
}

// GetBacklinks returns every note linking to targetNotePath. The scan snapshot
// carries a reverse link index, so the request is a handful of map lookups
// (proportional to the number of backlinks) instead of a pass over the vault.
func (v *Vault) GetBacklinks(targetNotePath string) []BacklinkItem {
	snap, err := v.scanNotesSnapshot()
	if err != nil {
		return []BacklinkItem{}
	}
	return snap.backlinks(v.idx.links).find(targetNotePath)
}

func linkContext(line string, matchStart, matchEnd int) string {
	start := matchStart - 30
	if start < 0 {
		start = 0
	}
	end := matchEnd + 30
	if end > len(line) {
		end = len(line)
	}
	ctx := line[start:end]
	if start > 0 {
		ctx = "..." + ctx
	}
	if end < len(line) {
		ctx = ctx + "..."
	}
	return ctx
}

func extractOutLinks(content string) (wiki, md []LinkOcc) {
	lines := strings.Split(content, "\n")
	for lineNum, line := range lines {
		num := lineNum + 1
		for _, match := range wikilinkRe.FindAllStringSubmatchIndex(line, -1) {
			target := strings.TrimSpace(line[match[2]:match[3]])
			if idx := strings.Index(target, "#"); idx != -1 {
				target = strings.TrimSpace(target[:idx])
			}
			if target == "" {
				continue
			}
			wiki = append(wiki, LinkOcc{
				Target:  target,
				Line:    num,
				Type:    "wikilink",
				Context: linkContext(line, match[0], match[1]),
			})
		}

		for _, match := range mdlinkRe.FindAllStringSubmatchIndex(line, -1) {
			rawTarget := strings.TrimSpace(line[match[4]:match[5]])
			if isExternalOrFragmentLink(rawTarget) || strings.Split(rawTarget, "#")[0] == "" {
				continue
			}
			md = append(md, LinkOcc{
				Target:  rawTarget,
				Line:    num,
				Type:    "markdown",
				Context: linkContext(line, match[0], match[1]),
			})
		}
	}
	return wiki, md
}

func buildBacklinkIndex(notes []NoteRecord, links func(string) ([]LinkOcc, []LinkOcc)) *backlinkIndex {
	idx := &backlinkIndex{
		wiki:  make(map[string][]int32),
		md:    make(map[string][]int32),
		order: make(map[string]int, len(notes)),
		name:  make(map[string]string, len(notes)),
	}

	for i, n := range notes {
		idx.order[n.Path] = i
		idx.name[n.Path] = n.Name

		wikiLinks, mdLinks := links(n.Path)
		for _, occ := range wikiLinks {
			id := int32(len(idx.occs))
			idx.occs = append(idx.occs, backlinkOcc{
				source:  n.Path,
				line:    occ.Line,
				typ:     "wikilink",
				context: occ.Context,
			})
			// GetBacklinks matches a wikilink by full path or by path without
			// the ".md" suffix; indexing both forms keeps that exact rule.
			raw := strings.ToLower(occ.Target)
			addPosting(idx.wiki, raw, id)
			addPosting(idx.wiki, strings.TrimSuffix(raw, ".md"), id)
		}

		for _, occ := range mdLinks {
			keys := mdLinkKeys(occ.Target, n.Folder)
			if len(keys) == 0 {
				continue
			}
			id := int32(len(idx.occs))
			idx.occs = append(idx.occs, backlinkOcc{
				source:  n.Path,
				line:    occ.Line,
				typ:     "markdown",
				context: occ.Context,
			})
			for _, key := range keys {
				addPosting(idx.md, key, id)
			}
		}
	}
	return idx
}

// addPosting appends id under key, skipping the immediately repeated id that
// occurs when both normalized forms of the same link are identical.
func addPosting(postings map[string][]int32, key string, id int32) {
	if key == "" {
		return
	}
	if n := len(postings[key]); n > 0 && postings[key][n-1] == id {
		return
	}
	postings[key] = append(postings[key], id)
}

// mdLinkKeys returns the lowercase targets a markdown link can match, relative
// to the note's folder and to the vault root, with and without ".md". It
// reproduces the normalization mdLinkMatchesTarget used to apply per request.
func mdLinkKeys(rawTarget, sourceFolder string) []string {
	if isExternalOrFragmentLink(rawTarget) {
		return nil
	}
	linkPath := strings.Split(rawTarget, "#")[0]
	if linkPath == "" {
		return nil
	}
	if u, err := url.PathUnescape(linkPath); err == nil {
		linkPath = u
	}
	if strings.HasPrefix(linkPath, "./") {
		linkPath = linkPath[2:]
	}
	if linkPath == "" {
		return nil
	}

	withMD := linkPath
	if !strings.HasSuffix(withMD, ".md") {
		withMD += ".md"
	}

	keys := make([]string, 0, 4)
	keys = append(keys, strings.ToLower(withMD), strings.ToLower(linkPath))
	if sourceFolder != "" && !strings.HasPrefix(linkPath, "/") {
		keys = append(keys,
			strings.ToLower(sourceFolder+"/"+withMD),
			strings.ToLower(sourceFolder+"/"+linkPath),
		)
	}
	return keys
}

// find returns the backlinks of targetPath in the same order the previous
// scan-based implementation produced: notes newest first, references in line
// order (wikilink before markdown on the same line), capped at three per note.
func (b *backlinkIndex) find(targetPath string) []BacklinkItem {
	targetLower := strings.ToLower(targetPath)
	targetNoExtLower := strings.TrimSuffix(targetLower, ".md")
	stemLower := strings.ToLower(strings.TrimSuffix(filepath.Base(targetPath), filepath.Ext(targetPath)))

	seen := make(map[int32]struct{})
	bySource := make(map[string][]int32)
	collect := func(postings map[string][]int32, keys ...string) {
		for _, key := range keys {
			for _, id := range postings[key] {
				if _, dup := seen[id]; dup {
					continue
				}
				seen[id] = struct{}{}
				occ := b.occs[id]
				if occ.source == targetPath {
					continue
				}
				bySource[occ.source] = append(bySource[occ.source], id)
			}
		}
	}
	collect(b.wiki, targetLower, targetNoExtLower, stemLower)
	collect(b.md, targetLower, targetNoExtLower)

	if len(bySource) == 0 {
		return nil
	}

	sources := make([]string, 0, len(bySource))
	for source := range bySource {
		sources = append(sources, source)
	}
	sort.Slice(sources, func(i, j int) bool {
		return b.order[sources[i]] < b.order[sources[j]]
	})

	out := make([]BacklinkItem, 0, len(sources))
	for _, source := range sources {
		ids := bySource[source]
		sort.Slice(ids, func(i, j int) bool {
			a, c := b.occs[ids[i]], b.occs[ids[j]]
			if a.line != c.line {
				return a.line < c.line
			}
			// Build order already puts wikilinks before markdown links for the
			// same note, preserving the old stable-sort tie-break.
			return ids[i] < ids[j]
		})

		refs := make([]BacklinkRef, 0, 3)
		for _, id := range ids {
			occ := b.occs[id]
			refs = append(refs, BacklinkRef{
				LineNumber: occ.line,
				Context:    occ.context,
				Type:       occ.typ,
			})
			if len(refs) == 3 {
				break
			}
		}

		out = append(out, BacklinkItem{
			Path:       source,
			Name:       strings.TrimSuffix(b.name[source], ".md"),
			References: refs,
		})
	}
	return out
}
