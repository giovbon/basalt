package vault

import (
	"path/filepath"
	"strings"
)

func IsUnderSystemFolder(path string) bool {
	parent := ""
	if strings.Contains(path, "/") {
		idx := strings.LastIndex(path, "/")
		parent = path[:idx]
	}
	if parent == "" || parent == "." {
		return false
	}
	for _, segment := range strings.Split(parent, "/") {
		if strings.HasPrefix(segment, "_") {
			return true
		}
	}
	return false
}

func (v *Vault) GetGraphData(includeSystemFolders bool) (GraphData, error) {
	snap, err := v.scanNotesSnapshot()
	if err != nil {
		return GraphData{}, err
	}

	resolver := snap.resolver
	if resolver == nil {
		resolver = NewLinkResolver(scanNotePaths(snap.notes))
	}

	type edgeKey struct {
		s, t string
	}
	edgeMap := make(map[edgeKey]GraphEdge)
	nodes := make([]GraphNode, 0, len(snap.notes))

	for _, note := range snap.notes {
		path := note.Path
		if !includeSystemFolders && IsUnderSystemFolder(path) {
			continue
		}
		nodes = append(nodes, GraphNode{
			ID:    path,
			Label: strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)),
		})

		wikiLinks, mdLinks := v.idx.links(path)
		sourceFolder := strings.ReplaceAll(filepath.Dir(path), "\\", "/")
		if sourceFolder == "." {
			sourceFolder = ""
		}

		for _, occ := range wikiLinks {
			resolved := resolver.ResolveWikilink(occ.Target, sourceFolder)
			if resolved == "" || resolved == path || (!includeSystemFolders && IsUnderSystemFolder(resolved)) {
				continue
			}
			key := edgeKey{s: path, t: resolved}
			if _, exists := edgeMap[key]; !exists {
				edgeMap[key] = GraphEdge{Source: path, Target: resolved, Type: "wikilink"}
			}
		}

		for _, occ := range mdLinks {
			resolved := resolver.ResolveMDLink(occ.Target, sourceFolder)
			if resolved == "" || resolved == path || (!includeSystemFolders && IsUnderSystemFolder(resolved)) {
				continue
			}
			key := edgeKey{s: path, t: resolved}
			if _, exists := edgeMap[key]; !exists {
				edgeMap[key] = GraphEdge{Source: path, Target: resolved, Type: "markdown"}
			}
		}
	}

	edges := make([]GraphEdge, 0, len(edgeMap))
	for _, edge := range edgeMap {
		edges = append(edges, edge)
	}
	return GraphData{Nodes: nodes, Edges: edges}, nil
}
