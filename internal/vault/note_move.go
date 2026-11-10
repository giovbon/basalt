package vault

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// MoveNote holds the vault write lock across the move and wikilink updates so
// scans and other in-process mutations cannot observe an intermediate state.
func (v *Vault) MoveNote(oldPath, newPath string) error {
	v.mu.Lock()
	defer v.mu.Unlock()

	oldFull := v.FullPath(oldPath)
	newFull := v.FullPath(newPath)

	if !v.ValidatePathSecurity(oldFull) {
		return invalidPathError("Invalid source path")
	}
	if !v.ValidatePathSecurity(newFull) {
		return invalidPathError("Invalid destination path")
	}
	if _, err := os.Stat(oldFull); err != nil {
		return sourceNotFoundError(fmt.Sprintf("Source note does not exist: %s", oldPath))
	}
	if _, err := os.Stat(newFull); err == nil {
		return destinationExistsError(fmt.Sprintf("A note already exists at: %s", newPath))
	}

	conflict := v.NoteNameConflict(newPath)
	if conflict != "" && strings.ToLower(NormalizedRelPath(conflict)) != strings.ToLower(NormalizedRelPath(oldPath)) {
		return destinationExistsError(fmt.Sprintf("A note already exists at: %s", conflict))
	}

	var linkUpdates map[string]wikilinkUpdate
	if strings.EqualFold(filepath.Ext(oldPath), ".md") {
		var err error
		linkUpdates, err = v.wikilinkUpdatesForMoveLocked(oldPath, newPath)
		if err != nil {
			return operationFailedError(fmt.Sprintf("Failed to update note links: %s", err.Error()))
		}
	}

	if err := os.MkdirAll(filepath.Dir(newFull), 0755); err != nil {
		return operationFailedError(fmt.Sprintf("Failed to move file: %s", err.Error()))
	}

	if err := os.Rename(oldFull, newFull); err != nil {
		return operationFailedError(fmt.Sprintf("Failed to move file: %s", err.Error()))
	}
	v.idx.drop(NormalizedRelPath(oldPath))
	v.idx.drop(NormalizedRelPath(newPath))
	v.scanCache.invalidate()

	writeLink := v.saveNoteLocked
	if v.moveLinkWrite != nil {
		writeLink = v.moveLinkWrite
	}
	if err := applyMoveLinkUpdates(linkUpdates, oldPath, newPath, writeLink); err != nil {
		if rollbackErr := os.Rename(newFull, oldFull); rollbackErr != nil {
			v.dropMoveLinkIndex(oldPath, newPath, linkUpdates)
			return operationFailedError(fmt.Sprintf("Note remains at %s: updating wikilinks failed (%v), and rolling the move back failed: %s", newPath, err, rollbackErr))
		}
		v.dropMoveLinkIndex(oldPath, newPath, linkUpdates)
		return operationFailedError(fmt.Sprintf("Move was rolled back after updating wikilinks failed: %v", err))
	}
	return nil
}

func (v *Vault) dropMoveLinkIndex(oldPath, newPath string, updates map[string]wikilinkUpdate) {
	v.idx.drop(NormalizedRelPath(oldPath))
	v.idx.drop(NormalizedRelPath(newPath))
	for sourcePath := range updates {
		v.idx.drop(NormalizedRelPath(sourcePath))
	}
	v.scanCache.invalidate()
}

type wikilinkUpdate struct {
	before string
	after  string
}

func applyMoveLinkUpdates(updates map[string]wikilinkUpdate, oldPath, newPath string, write func(string, string) error) error {
	paths := make([]string, 0, len(updates))
	for path := range updates {
		paths = append(paths, path)
	}
	sort.Strings(paths)

	written := make([]string, 0, len(paths))
	for _, path := range paths {
		writePath := path
		if NormalizedRelPath(path) == NormalizedRelPath(oldPath) {
			writePath = newPath
		}
		if err := write(writePath, updates[path].after); err != nil {
			var rollbackErrs []string
			for i := len(written) - 1; i >= 0; i-- {
				rollbackPath := written[i]
				if NormalizedRelPath(rollbackPath) == NormalizedRelPath(oldPath) {
					rollbackPath = newPath
				}
				if rollbackErr := write(rollbackPath, updates[written[i]].before); rollbackErr != nil {
					rollbackErrs = append(rollbackErrs, fmt.Sprintf("%s: %v", rollbackPath, rollbackErr))
				}
			}
			if len(rollbackErrs) > 0 {
				return fmt.Errorf("writing links in %s failed: %w; restoring previous link contents also failed for %s", writePath, err, strings.Join(rollbackErrs, "; "))
			}
			return fmt.Errorf("writing links in %s failed: %w; previous link updates were restored", writePath, err)
		}
		written = append(written, path)
	}
	return nil
}

// wikilinkUpdatesForMoveLocked plans link changes while the caller holds v.mu.
func (v *Vault) wikilinkUpdatesForMoveLocked(oldPath, newPath string) (map[string]wikilinkUpdate, error) {
	var notePaths []string
	err := filepath.WalkDir(v.notesDir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() && path != v.notesDir && strings.HasPrefix(entry.Name(), ".") {
			return filepath.SkipDir
		}
		if entry.Type()&os.ModeSymlink != 0 || entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".md") {
			return nil
		}
		rel, err := filepath.Rel(v.notesDir, path)
		if err != nil {
			return err
		}
		notePaths = append(notePaths, NormalizedRelPath(rel))
		return nil
	})
	if err != nil {
		return nil, err
	}

	resolver := NewLinkResolver(notePaths)
	updates := make(map[string]wikilinkUpdate)
	for _, sourcePath := range notePaths {
		fullPath := v.FullPath(sourcePath)
		data, err := os.ReadFile(fullPath)
		if err != nil {
			return nil, err
		}
		sourceFolder := filepath.ToSlash(filepath.Dir(sourcePath))
		if sourceFolder == "." {
			sourceFolder = ""
		}
		if NormalizedRelPath(sourcePath) == NormalizedRelPath(oldPath) {
			sourceFolder = filepath.ToSlash(filepath.Dir(newPath))
			if sourceFolder == "." {
				sourceFolder = ""
			}
		}
		updated := rewriteWikilinkTargets(string(data), sourceFolder, resolver, oldPath, newPath)
		if updated != string(data) {
			updates[sourcePath] = wikilinkUpdate{before: string(data), after: updated}
		}
	}
	return updates, nil
}

func rewriteWikilinkTargets(content, sourceFolder string, resolver *LinkResolver, oldPath, newPath string) string {
	newFolder := filepath.ToSlash(filepath.Dir(newPath))
	if newFolder == "." {
		newFolder = ""
	}

	var result strings.Builder
	for _, line := range strings.SplitAfter(content, "\n") {
		lineEnd := ""
		if strings.HasSuffix(line, "\n") {
			line, lineEnd = strings.TrimSuffix(line, "\n"), "\n"
		}
		matches := wikilinkRe.FindAllStringSubmatchIndex(line, -1)
		if len(matches) == 0 {
			result.WriteString(line)
			result.WriteString(lineEnd)
			continue
		}

		var rewritten strings.Builder
		last := 0
		for _, match := range matches {
			rewritten.WriteString(line[last:match[0]])
			rawTarget := line[match[2]:match[3]]
			trimmed := strings.TrimSpace(rawTarget)
			replacement := rawTarget
			if trimmed != "" && NormalizedRelPath(resolver.ResolveWikilink(trimmed, sourceFolder)) == NormalizedRelPath(oldPath) {
				left := len(rawTarget) - len(strings.TrimLeftFunc(rawTarget, func(r rune) bool { return strings.TrimSpace(string(r)) == "" }))
				right := len(rawTarget) - len(strings.TrimRightFunc(rawTarget, func(r rune) bool { return strings.TrimSpace(string(r)) == "" }))
				core := trimmed
				anchor := ""
				if i := strings.Index(core, "#"); i >= 0 {
					core, anchor = core[:i], core[i:]
				}
				targetPath := strings.TrimSuffix(newPath, filepath.Ext(newPath))
				if !strings.Contains(core, "/") && sourceFolder == newFolder {
					targetPath = strings.TrimSuffix(filepath.Base(newPath), filepath.Ext(newPath))
				}
				if strings.EqualFold(filepath.Ext(core), ".md") {
					targetPath += filepath.Ext(newPath)
				}
				replacement = rawTarget[:left] + targetPath + anchor + rawTarget[len(rawTarget)-right:]
			}
			rewritten.WriteString(line[match[0]:match[2]])
			rewritten.WriteString(replacement)
			rewritten.WriteString(line[match[3]:match[1]])
			last = match[1]
		}
		rewritten.WriteString(line[last:])
		result.WriteString(rewritten.String())
		result.WriteString(lineEnd)
	}
	return result.String()
}
