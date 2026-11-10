package vault

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ScanNotes traverses the vault skipping dot directories/files and symlinks.
//
// The walk result itself is cached (see scanCache), so listings, tags, search,
// stats and the graph do not re-walk the tree on every request: the snapshot
// is served until an app write invalidates it, a watcher event patches it, or
// it expires after the scan TTL — whichever comes first. The TTL is the safety
// net for changes no event reported (no watcher, or a filesystem without
// inotify). When a walk does run, note contents are only re-read for files
// whose (mtime, size) changed since the last scan — see Index. The only stale
// window without a watcher is an external rewrite that preserves both mtime
// and size (same-second, same-length edit), which the app's own writes never
// produce because SaveNote refreshes the entry with the content it wrote; a
// watcher event closes even that window by forcing the re-read.
//
// The stored snapshot always contains media records; includeMedia decides
// whether this caller receives them. The returned slices are read-only views
// of an immutable snapshot: callers may keep iterating them after releasing the
// vault lock, but must clone before sorting or otherwise mutating them.
func (v *Vault) ScanNotes(includeMedia bool) ([]NoteRecord, []string, error) {
	snap, err := v.scanNotesSnapshot()
	if err != nil {
		return nil, nil, err
	}
	if includeMedia {
		return snap.all, snap.folders, nil
	}
	return snap.notes, snap.folders, nil
}

// scanNotesSnapshot returns the current walk snapshot, refreshing it when the
// cache is missing, stale or past its TTL. Callers that need several derived
// views (notes, resolver, tag counts, backlinks) reuse the same snapshot so
// they all describe the same directory state.
func (v *Vault) scanNotesSnapshot() (*scanSnapshot, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()

	ttl := v.scanTTL()
	if snap := v.scanCache.current(ttl); snap != nil {
		return snap, nil
	}

	var notes []NoteRecord = []NoteRecord{}
	folderSet := make(map[string]struct{})
	seen := make(map[string]struct{})

	err := v.walkDir(v.notesDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}

		relPath, err := filepath.Rel(v.notesDir, path)
		if err != nil {
			return err
		}
		relStr := strings.ReplaceAll(relPath, "\\", "/")

		if d.IsDir() {
			if relStr != "." && relStr != "" {
				folderSet[relStr] = struct{}{}
			}
			return nil
		}

		mediaType := GetMediaType(name)
		isMarkdown := strings.ToLower(filepath.Ext(name)) == ".md"
		if !isMarkdown && mediaType == "" {
			return nil
		}

		seen[relStr] = struct{}{}

		parentFolder := filepath.Dir(relStr)
		if parentFolder == "." {
			parentFolder = ""
		} else {
			parentFolder = strings.ReplaceAll(parentFolder, "\\", "/")
		}
		stem := strings.TrimSuffix(name, filepath.Ext(name))

		if isMarkdown {
			var tags []string
			if e, ok := v.idx.get(relStr, info.ModTime(), info.Size()); ok {
				tags = e.tags
			} else if data, err := os.ReadFile(path); err == nil {
				content := strings.ReplaceAll(string(data), "\r\n", "\n")
				tags = v.idx.putNote(relStr, info.ModTime(), info.Size(), content)
			} else {
				return err
			}

			notes = append(notes, NoteRecord{
				Name:     stem,
				Path:     relStr,
				Folder:   parentFolder,
				Modified: FormatTime(info.ModTime()),
				Size:     info.Size(),
				Type:     "note",
				Tags:     tags,
				MTime:    float64(info.ModTime().UnixNano()) / 1e9,
				modTime:  info.ModTime(),
			})
			return nil
		}

		if _, ok := v.idx.get(relStr, info.ModTime(), info.Size()); !ok {
			v.idx.putMedia(relStr, stem, parentFolder, mediaType, info.ModTime(), info.Size())
		}
		notes = append(notes, NoteRecord{
			Name:     stem,
			Path:     relStr,
			Folder:   parentFolder,
			Modified: FormatTime(info.ModTime()),
			Size:     info.Size(),
			Type:     mediaType,
			Tags:     nil,
			MTime:    float64(info.ModTime().UnixNano()) / 1e9,
			modTime:  info.ModTime(),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}

	v.idx.prune(seen)
	folders := make([]string, 0, len(folderSet))
	for folder := range folderSet {
		folders = append(folders, folder)
	}
	sort.Strings(folders)
	return v.scanCache.store(notes, folders), nil
}

// TagCounts returns the tag histogram for the current snapshot.
func (v *Vault) TagCounts() (map[string]int, error) {
	snap, err := v.scanNotesSnapshot()
	if err != nil {
		return nil, err
	}
	return snap.tagCounts(), nil
}
