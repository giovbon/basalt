package vault

import (
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
)

// LinkResolver resolves note links against the paths in a scan snapshot.
type LinkResolver struct {
	notePaths      map[string]struct{}
	notePathsLower map[string]string
	noteNames      map[string]string
}

func NewLinkResolver(notes []string) *LinkResolver {
	r := &LinkResolver{
		notePaths:      make(map[string]struct{}, len(notes)),
		notePathsLower: make(map[string]string, len(notes)*2),
		noteNames:      make(map[string]string, len(notes)*2),
	}
	for _, p := range notes {
		r.notePaths[p] = struct{}{}
		pLower := strings.ToLower(p)
		r.notePathsLower[pLower] = p
		if strings.HasSuffix(pLower, ".md") {
			r.notePathsLower[strings.TrimSuffix(pLower, ".md")] = p
		}
		stem := strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))
		r.noteNames[strings.ToLower(stem)] = p
		r.noteNames[strings.ToLower(filepath.Base(p))] = p
	}
	return r
}

// ResolveWikilink resolves a wikilink relative to its source folder, then the
// vault root, and finally by note stem.
func (r *LinkResolver) ResolveWikilink(target string, sourceFolder string) string {
	target = strings.TrimSpace(target)
	if idx := strings.Index(target, "#"); idx != -1 {
		target = strings.TrimSpace(target[:idx])
	}
	if target == "" {
		return ""
	}
	targetLower := strings.ToLower(target)

	if sourceFolder != "" && !strings.Contains(target, "/") {
		rel := fmt.Sprintf("%s/%s", sourceFolder, target)
		relLower := strings.ToLower(rel)
		if _, ok := r.notePaths[rel]; ok {
			if strings.HasSuffix(rel, ".md") {
				return rel
			}
			return rel + ".md"
		}
		if _, ok := r.notePaths[rel+".md"]; ok {
			return rel + ".md"
		}
		if orig, ok := r.notePathsLower[relLower]; ok {
			return orig
		}
		if orig, ok := r.notePathsLower[relLower+".md"]; ok {
			return orig
		}
	}

	if _, ok := r.notePaths[target]; ok {
		if strings.HasSuffix(target, ".md") {
			return target
		}
		return target + ".md"
	}
	if _, ok := r.notePaths[target+".md"]; ok {
		return target + ".md"
	}
	if orig, ok := r.notePathsLower[targetLower]; ok {
		return orig
	}
	if orig, ok := r.notePathsLower[targetLower+".md"]; ok {
		return orig
	}
	if orig, ok := r.noteNames[targetLower]; ok {
		return orig
	}
	return ""
}

// ResolveMDLink resolves a Markdown link path relative to its source note.
func (r *LinkResolver) ResolveMDLink(linkPath string, sourceFolder string) string {
	if linkPath == "" {
		return ""
	}
	parts := strings.Split(linkPath, "#")
	linkPath = parts[0]
	if linkPath == "" {
		return ""
	}
	if u, err := url.PathUnescape(linkPath); err == nil {
		linkPath = u
	}
	if strings.HasPrefix(linkPath, "./") {
		linkPath = linkPath[2:]
	}
	linkPathWithMD := linkPath
	if !strings.HasSuffix(linkPathWithMD, ".md") {
		linkPathWithMD += ".md"
	}

	if sourceFolder != "" && !strings.HasPrefix(linkPath, "/") {
		rel := fmt.Sprintf("%s/%s", sourceFolder, linkPath)
		relMD := fmt.Sprintf("%s/%s", sourceFolder, linkPathWithMD)
		relLower := strings.ToLower(rel)
		relMDLower := strings.ToLower(relMD)

		if _, ok := r.notePaths[rel]; ok {
			if strings.HasSuffix(rel, ".md") {
				return rel
			}
			return rel + ".md"
		}
		if _, ok := r.notePaths[relMD]; ok {
			return relMD
		}
		if orig, ok := r.notePathsLower[relLower]; ok {
			return orig
		}
		if orig, ok := r.notePathsLower[relMDLower]; ok {
			return orig
		}
	}

	linkPathLower := strings.ToLower(linkPath)
	linkPathMDLower := strings.ToLower(linkPathWithMD)
	if _, ok := r.notePaths[linkPath]; ok {
		if strings.HasSuffix(linkPath, ".md") {
			return linkPath
		}
		return linkPath + ".md"
	}
	if _, ok := r.notePaths[linkPathWithMD]; ok {
		return linkPathWithMD
	}
	if orig, ok := r.notePathsLower[linkPathLower]; ok {
		return orig
	}
	if orig, ok := r.notePathsLower[linkPathMDLower]; ok {
		return orig
	}
	return ""
}
