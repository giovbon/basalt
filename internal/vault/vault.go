package vault

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"notediscovery/internal/search"
)

var (
	wikilinkRe = regexp.MustCompile(`\[\[([^\]|]+)(?:\|[^\]]+)?\]\]`)
	mdlinkRe   = regexp.MustCompile(`\[([^\]]+)\]\(([^\)]+)\)`)
)

func isExternalOrFragmentLink(target string) bool {
	t := strings.TrimSpace(strings.ToLower(target))
	return strings.HasPrefix(t, "http://") ||
		strings.HasPrefix(t, "https://") ||
		strings.HasPrefix(t, "mailto:") ||
		strings.HasPrefix(t, "#") ||
		strings.HasPrefix(t, "data:")
}

type NoteRecord struct {
	Name     string   `json:"name"`
	Path     string   `json:"path"`
	Folder   string   `json:"folder"`
	Modified string   `json:"modified"`
	Size     int64    `json:"size"`
	Type     string   `json:"type"`
	Tags     []string `json:"tags"`
	MTime    float64  `json:"-"`

	// modTime is the exact filesystem timestamp observed by the walk. It is
	// kept unexported (and out of JSON) so index lookups can reuse the scan's
	// stat instead of issuing one Lstat per note on every search.
	modTime time.Time
}

type NoteMetadata struct {
	Created  string `json:"created"`
	Modified string `json:"modified"`
	Size     int64  `json:"size"`
	Lines    int    `json:"lines"`
}

type BacklinkRef struct {
	LineNumber int    `json:"line_number"`
	Context    string `json:"context"`
	Type       string `json:"type"`
}

type BacklinkItem struct {
	Path       string        `json:"path"`
	Name       string        `json:"name"`
	References []BacklinkRef `json:"references"`
}

type GraphNode struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type GraphEdge struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Type   string `json:"type"`
}

type GraphData struct {
	Nodes []GraphNode `json:"nodes"`
	Edges []GraphEdge `json:"edges"`
}

type Vault struct {
	notesDir  string
	mu        sync.RWMutex
	idx       *Index
	scanCache *scanCache

	// watch mirrors external filesystem changes into the caches (nil until
	// StartWatching succeeds); persist writes the index back to disk (nil
	// until StartIndexPersistence). Both are torn down by Close.
	watch     *vaultWatcher
	persist   *indexPersistence
	closeOnce sync.Once
}

func New(notesDir string) *Vault {
	return &Vault{
		notesDir:  filepath.Clean(notesDir),
		idx:       newIndex(),
		scanCache: &scanCache{},
	}
}

func (v *Vault) NotesDir() string {
	return v.notesDir
}

// EnsureDirectories creates the root notesDir if it does not exist
func (v *Vault) EnsureDirectories() error {
	return os.MkdirAll(v.notesDir, 0755)
}

// Close tears down the background services (file watcher, index persistence)
// and flushes any pending index state to disk. Safe to call more than once.
//
// It must not run while holding v.mu: the watcher's event loop takes v.mu
// (read) per event and stop() waits for that loop to exit.
func (v *Vault) Close() {
	v.closeOnce.Do(func() {
		v.mu.Lock()
		w := v.watch
		v.watch = nil
		p := v.persist
		v.persist = nil
		v.mu.Unlock()

		if w != nil {
			w.stop()
		}
		if p != nil {
			p.halt() // no save can be running after this line
			if v.idx.dirty.Swap(false) {
				if err := p.save(v); err != nil {
					v.idx.dirty.Store(true) // lost only the final flush attempt
					log.Printf("WARNING: saving index cache: %v", err)
				}
			}
		}
	})
}

// ValidatePathSecurity checks that resolved path is safely inside notesDir
func (v *Vault) ValidatePathSecurity(targetPath string) bool {
	absBase, err := filepath.Abs(v.notesDir)
	if err != nil {
		return false
	}
	absTarget, err := filepath.Abs(targetPath)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(absBase, absTarget)
	if err != nil {
		return false
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	return true
}

func (v *Vault) FullPath(relPath string) string {
	cleanRel := filepath.Clean(strings.ReplaceAll(relPath, "\\", "/"))
	cleanRel = strings.TrimPrefix(cleanRel, "/")
	return filepath.Join(v.notesDir, cleanRel)
}

func NormalizedRelPath(p string) string {
	return strings.Trim(strings.ReplaceAll(p, "\\", "/"), "/")
}

func PathHasHash(p string) bool {
	return strings.Contains(p, "#")
}

func ContentHash(content string) string {
	// Normalize CRLF to LF
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	hasher := sha256.New()
	hasher.Write([]byte(normalized))
	return hex.EncodeToString(hasher.Sum(nil))
}

// FormatTime formats timestamp to Python isoformat UTC with microsecond parity
func FormatTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.999999+00:00")
}

// MatchingChild checks case-insensitively for an existing child file or directory
func (v *Vault) MatchingChild(parent string, name string, wantDir bool) string {
	entries, err := os.ReadDir(parent)
	if err != nil {
		return ""
	}
	folded := strings.ToLower(name)
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || (info.Mode()&os.ModeSymlink != 0) {
			continue
		}
		isDir := entry.IsDir()
		if isDir != wantDir {
			continue
		}
		if entry.Name() == name {
			return entry.Name()
		}
		if strings.ToLower(entry.Name()) == folded {
			return entry.Name()
		}
	}
	return ""
}

func (v *Vault) NoteExistsExact(notePath string) bool {
	full := v.FullPath(notePath)
	st, err := os.Lstat(full)
	if err != nil {
		return false
	}
	return !st.IsDir() && (st.Mode()&os.ModeSymlink == 0)
}

func (v *Vault) FolderExistsExact(folderPath string) bool {
	if folderPath == "" || folderPath == "." {
		return true
	}
	full := v.FullPath(folderPath)
	st, err := os.Lstat(full)
	if err != nil {
		return false
	}
	return st.IsDir() && (st.Mode()&os.ModeSymlink == 0)
}

func (v *Vault) NoteNameConflict(notePath string) string {
	clean := NormalizedRelPath(notePath)
	if clean == "" {
		return ""
	}
	parts := strings.Split(clean, "/")
	currentDir := v.notesDir
	var resolved []string

	for i, segment := range parts {
		isLast := (i == len(parts)-1)
		child := v.MatchingChild(currentDir, segment, !isLast)
		if child == "" {
			return ""
		}
		resolved = append(resolved, child)
		currentDir = filepath.Join(currentDir, child)
	}

	found := strings.Join(resolved, "/")
	if found != clean {
		return found
	}
	return ""
}

func (v *Vault) FolderNameConflict(folderPath string) string {
	clean := NormalizedRelPath(folderPath)
	if clean == "" {
		return ""
	}
	parts := strings.Split(clean, "/")
	currentDir := v.notesDir
	var resolved []string

	for _, segment := range parts {
		child := v.MatchingChild(currentDir, segment, true)
		if child == "" {
			return ""
		}
		resolved = append(resolved, child)
		currentDir = filepath.Join(currentDir, child)
	}

	found := strings.Join(resolved, "/")
	if found != clean {
		return found
	}
	return ""
}

func (v *Vault) GetNoteContent(notePath string) (string, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()

	fullPath := v.FullPath(notePath)
	if !v.ValidatePathSecurity(fullPath) {
		return "", os.ErrNotExist
	}
	// Lstat so a symlink masquerading as a note is rejected instead of being
	// followed to a file that may sit outside the vault.
	info, err := os.Lstat(fullPath)
	if err != nil || !info.Mode().IsRegular() {
		return "", os.ErrNotExist
	}

	// Serve from the index when the file has not changed since it was last
	// read; otherwise read once and warm the cache for the next caller
	// (search, graph and backlinks all re-read every note per request).
	rel := NormalizedRelPath(notePath)
	if content, ok := v.idx.cachedContent(rel, info.ModTime(), info.Size()); ok {
		return content, nil
	}

	data, err := os.ReadFile(fullPath)
	if err != nil {
		return "", err
	}
	// Normalize CRLF to LF
	content := strings.ReplaceAll(string(data), "\r\n", "\n")
	v.idx.cacheContent(rel, info.ModTime(), info.Size(), content)
	return content, nil
}

// GetFoldedContent returns the accent-folded, lowercased text that search
// matches against. The fold is computed once per note version and kept in the
// index (bounded by foldCacheBudget and invalidated together with the entry),
// so a query over a large vault folds each note exactly once instead of once
// per keystroke.
func (v *Vault) GetFoldedContent(notePath string) (string, error) {
	v.mu.RLock()
	fullPath := v.FullPath(notePath)
	if !v.ValidatePathSecurity(fullPath) {
		v.mu.RUnlock()
		return "", os.ErrNotExist
	}
	// The fold is keyed by the stat taken *before* the read below: an edit in
	// between can then only cause a redundant refold later, never a stale fold
	// being served as valid. Lstat so a symlink is rejected rather than
	// followed.
	info, err := os.Lstat(fullPath)
	if err != nil || !info.Mode().IsRegular() {
		v.mu.RUnlock()
		return "", os.ErrNotExist
	}
	rel := NormalizedRelPath(notePath)
	folded, ok := v.idx.cachedFold(rel, info.ModTime(), info.Size())
	v.mu.RUnlock()
	if ok {
		return folded, nil
	}

	content, err := v.GetNoteContent(notePath)
	if err != nil {
		return "", err
	}
	folded = search.FoldContent(content)
	v.idx.putFold(rel, info.ModTime(), info.Size(), folded)
	return folded, nil
}

// FoldedContentForRecord is GetFoldedContent for a note already returned by
// ScanNotes. It reuses the (mtime, size) observed by the walk, so a vault-wide
// search does not issue one Lstat per note on every query. A miss (the index
// entry changed after the scan) falls back to the regular filesystem path.
func (v *Vault) FoldedContentForRecord(n NoteRecord) (string, error) {
	v.mu.RLock()
	folded, ok := v.idx.cachedFold(NormalizedRelPath(n.Path), n.modTime, n.Size)
	v.mu.RUnlock()
	if ok {
		return folded, nil
	}
	return v.GetFoldedContent(n.Path)
}

// NoteContentAndFolded returns a note's content together with its folded form
// from the same filesystem observation. Search uses it after the cheap
// folded-text reject so span extraction does not re-fold the note (and never
// mixes a cached fold with a newer content revision).
func (v *Vault) NoteContentAndFolded(notePath string) (string, string, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()

	fullPath := v.FullPath(notePath)
	if !v.ValidatePathSecurity(fullPath) {
		return "", "", os.ErrNotExist
	}
	info, err := os.Lstat(fullPath)
	if err != nil || !info.Mode().IsRegular() {
		return "", "", os.ErrNotExist
	}

	rel := NormalizedRelPath(notePath)
	content, haveContent := v.idx.cachedContent(rel, info.ModTime(), info.Size())
	folded, haveFold := v.idx.cachedFold(rel, info.ModTime(), info.Size())
	if haveContent && haveFold {
		return content, folded, nil
	}

	if !haveContent {
		data, err := os.ReadFile(fullPath)
		if err != nil {
			return "", "", err
		}
		content = strings.ReplaceAll(string(data), "\r\n", "\n")
		v.idx.cacheContent(rel, info.ModTime(), info.Size(), content)
	}
	if !haveFold {
		folded = search.FoldContent(content)
		v.idx.putFold(rel, info.ModTime(), info.Size(), folded)
	}
	return content, folded, nil
}

func (v *Vault) SaveNote(notePath string, content string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.saveNoteLocked(notePath, content)
}

// saveNoteLocked writes a note and refreshes the index with what was written.
// The caller must hold v.mu for the whole call: SaveNote wraps it with the
// lock, and SaveNoteIfHash keeps it across its read-check-write sequence so a
// concurrent save cannot slip between the two.
func (v *Vault) saveNoteLocked(notePath string, content string) error {
	fullPath := v.FullPath(notePath)
	if !v.ValidatePathSecurity(fullPath) {
		return fmt.Errorf("invalid path security")
	}

	// Lstat so an existing symlink is refused instead of being followed (or
	// silently replaced by the rename that publishes the new content).
	if info, err := os.Lstat(fullPath); err == nil {
		if err := saveTargetRefusal(info); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	dir := filepath.Dir(fullPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	// Python writes UTF-8 string directly
	if err := writeFileAtomic(fullPath, []byte(content), 0644); err != nil {
		return err
	}
	// Refresh the index with what we just wrote so the next scan/search does
	// not re-read the file, and patch the cached listing in place so the next
	// request does not have to walk the tree again.
	if info, err := os.Lstat(fullPath); err == nil {
		rel := NormalizedRelPath(notePath)
		tags := v.idx.putNote(rel, info.ModTime(), info.Size(), content)
		v.scanCache.noteSaved(makeNoteRecord(rel, info, tags))
	}
	return nil
}

// SaveNoteResult reports the outcome of a SaveNoteIfHash call.
type SaveNoteResult struct {
	// Saved is true when the note was written during this call.
	Saved bool
	// Created is true only when the note did not exist before the write.
	Created bool
	// CurrentHash is ContentHash of the note's content after the call: the
	// content just written when Saved, otherwise the on-disk content that did
	// not match baseHash (so the caller can rebase and retry).
	CurrentHash string
}

// SaveNoteIfHash writes content to notePath only while the on-disk note still
// matches baseHash, holding v.mu for the whole read-check-write sequence.
//
// An empty baseHash keeps the legacy behavior of SaveNote: always save. With a
// non-empty baseHash the call is compare-and-swap: the caller last read the
// note as baseHash, and if another writer changed it since, nothing is
// written and the fresh hash comes back with Saved false.
func (v *Vault) SaveNoteIfHash(notePath, content, baseHash string) (SaveNoteResult, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	fullPath := v.FullPath(notePath)
	if !v.ValidatePathSecurity(fullPath) {
		return SaveNoteResult{}, fmt.Errorf("invalid path security")
	}

	// Lstat (never Stat) so an existing symlink is refused below instead of
	// being followed by the read or the later write.
	info, err := os.Lstat(fullPath)
	if err != nil && !os.IsNotExist(err) {
		return SaveNoteResult{}, err
	}
	exists := err == nil
	if err := saveTargetRefusal(info); err != nil {
		return SaveNoteResult{}, err
	}

	created := !exists
	if baseHash != "" && exists {
		data, err := os.ReadFile(fullPath)
		if err != nil {
			return SaveNoteResult{}, err
		}
		currentHash := ContentHash(string(data))
		if currentHash != baseHash {
			return SaveNoteResult{Saved: false, CurrentHash: currentHash}, nil
		}
	}

	if err := v.saveNoteLocked(notePath, content); err != nil {
		return SaveNoteResult{}, err
	}
	return SaveNoteResult{
		Saved:       true,
		Created:     created,
		CurrentHash: ContentHash(content),
	}, nil
}

// saveTargetRefusal rejects targets a save must never overwrite: a symlink
// (writes must not follow it or silently replace it) and anything that is not
// a plain regular file. A nil info means the target does not exist yet, which
// is fine for a save.
func saveTargetRefusal(info os.FileInfo) error {
	if info == nil {
		return nil
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing to save over a symlink")
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("refusing to save over a non-regular file")
	}
	return nil
}

// writeFileAtomic publishes data at path without ever leaving a partial or
// empty file behind: the content lands in a temp file in the same directory,
// is flushed, and is then renamed over the target. On any failure the temp
// file is removed and the target keeps its previous bytes.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	// removeTmp removes the partially written temp file; Close can already
	// have succeeded, and a second Close on it is harmless.
	removeTmp := func() error {
		if err := tmp.Close(); err != nil {
			log.Printf("WARNING: closing temp note file %s: %v", tmpName, err)
		}
		return os.Remove(tmpName)
	}

	if err := tmp.Chmod(perm); err != nil {
		if rmErr := removeTmp(); rmErr != nil {
			log.Printf("WARNING: removing temp note file %s: %v", tmpName, rmErr)
		}
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		if rmErr := removeTmp(); rmErr != nil {
			log.Printf("WARNING: removing temp note file %s: %v", tmpName, rmErr)
		}
		return err
	}
	// Close has to succeed before the rename: the content has to be flushed
	// to the name that ends up at the target.
	if err := tmp.Close(); err != nil {
		if rmErr := os.Remove(tmpName); rmErr != nil {
			log.Printf("WARNING: removing temp note file %s: %v", tmpName, rmErr)
		}
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		if rmErr := os.Remove(tmpName); rmErr != nil {
			log.Printf("WARNING: removing temp note file %s: %v", tmpName, rmErr)
		}
		return err
	}
	return nil
}

func (v *Vault) DeleteNote(notePath string) bool {
	v.mu.Lock()
	defer v.mu.Unlock()

	fullPath := v.FullPath(notePath)
	if !v.ValidatePathSecurity(fullPath) {
		return false
	}
	if err := os.Remove(fullPath); err != nil {
		return false
	}
	rel := NormalizedRelPath(notePath)
	v.idx.drop(rel)
	v.scanCache.noteDeleted(rel)
	return true
}

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

	var linkUpdates map[string]string
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
	// Paths changed everywhere under the folder: cheaper to walk once than to
	// rewrite the snapshot.
	v.scanCache.invalidate()

	for sourcePath, content := range linkUpdates {
		if NormalizedRelPath(sourcePath) == NormalizedRelPath(oldPath) {
			sourcePath = newPath
		}
		if err := v.saveNoteLocked(sourcePath, content); err != nil {
			return operationFailedError(fmt.Sprintf("Note moved, but failed to update links in %s: %s", sourcePath, err.Error()))
		}
	}
	return nil
}

// wikilinkUpdatesForMoveLocked finds links that currently resolve to oldPath
// and updates only their target text. The caller must hold v.mu.
func (v *Vault) wikilinkUpdatesForMoveLocked(oldPath, newPath string) (map[string]string, error) {
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
	updates := make(map[string]string)
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
			updates[sourcePath] = updated
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

func (v *Vault) CreateFolder(folderPath string) bool {
	v.mu.Lock()
	defer v.mu.Unlock()

	fullPath := v.FullPath(folderPath)
	if !v.ValidatePathSecurity(fullPath) {
		return false
	}
	if err := os.MkdirAll(fullPath, 0755); err != nil {
		return false
	}
	v.scanCache.invalidate()
	return true
}

func (v *Vault) MoveFolder(oldPath, newPath string) error {
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
	info, err := os.Stat(oldFull)
	if err != nil || !info.IsDir() {
		return sourceNotFoundError(fmt.Sprintf("Source folder does not exist: %s", oldPath))
	}
	if _, err := os.Stat(newFull); err == nil {
		return destinationExistsError(fmt.Sprintf("A folder already exists at: %s", newPath))
	}

	conflict := v.FolderNameConflict(newPath)
	if conflict != "" && strings.ToLower(NormalizedRelPath(conflict)) != strings.ToLower(NormalizedRelPath(oldPath)) {
		return destinationExistsError(fmt.Sprintf("A folder already exists at: %s", conflict))
	}

	if err := os.MkdirAll(filepath.Dir(newFull), 0755); err != nil {
		return operationFailedError(fmt.Sprintf("Failed to move folder: %s", err.Error()))
	}

	if err := os.Rename(oldFull, newFull); err != nil {
		return operationFailedError(fmt.Sprintf("Failed to move folder: %s", err.Error()))
	}
	v.idx.dropPrefix(NormalizedRelPath(oldPath))
	v.scanCache.invalidate()
	return nil
}

func (v *Vault) DeleteFolder(folderPath string) error {
	v.mu.Lock()
	defer v.mu.Unlock()

	clean := filepath.Clean(strings.ReplaceAll(folderPath, "\\", "/"))
	if folderPath == "" || clean == "." || clean == "/" {
		return invalidPathError("Invalid folder path")
	}

	fullPath := v.FullPath(folderPath)
	if !v.ValidatePathSecurity(fullPath) {
		return invalidPathError("Invalid folder path")
	}

	// Never remove the vault root itself: a path such as "sub/.." (or one that
	// empty-resolves) cleans to notesDir, and os.RemoveAll on that would wipe
	// the whole vault. Compare cleaned absolute paths so every spelling of the
	// root is caught.
	if absFull, err := filepath.Abs(fullPath); err == nil {
		if absBase, err := filepath.Abs(v.notesDir); err == nil {
			if filepath.Clean(absFull) == filepath.Clean(absBase) {
				return invalidPathError("Invalid folder path")
			}
		}
	}

	info, err := os.Stat(fullPath)
	if err != nil || !info.IsDir() {
		return sourceNotFoundError(fmt.Sprintf("Folder does not exist: %s", folderPath))
	}
	if err := os.RemoveAll(fullPath); err != nil {
		return operationFailedError(fmt.Sprintf("Failed to delete folder: %s", err.Error()))
	}
	v.idx.dropPrefix(NormalizedRelPath(folderPath))
	v.scanCache.invalidate()
	return nil
}

func (v *Vault) ResolveVaultFolder(folderPath string) (string, error) {
	parts := strings.Split(strings.ReplaceAll(folderPath, "\\", "/"), "/")
	for _, part := range parts {
		if strings.HasPrefix(part, ".") {
			return "", os.ErrNotExist
		}
	}
	target := v.FullPath(folderPath)
	if !v.ValidatePathSecurity(target) {
		return "", os.ErrNotExist
	}
	st, err := os.Lstat(target)
	if err != nil || !st.IsDir() || (st.Mode()&os.ModeSymlink != 0) {
		return "", os.ErrNotExist
	}
	return target, nil
}

func (v *Vault) CollectFolderFiles(folder string) ([]string, int64, error) {
	var files []string
	var totalBytes int64

	err := filepath.WalkDir(folder, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil || (info.Mode()&os.ModeSymlink != 0) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.IsDir() {
			files = append(files, path)
			totalBytes += info.Size()
		}
		return nil
	})
	return files, totalBytes, err
}

func (v *Vault) CreateNoteMetadata(notePath string) NoteMetadata {
	fullPath := v.FullPath(notePath)
	if !v.ValidatePathSecurity(fullPath) {
		return NoteMetadata{}
	}

	// Lstat so a symlink masquerading as a note is rejected instead of being
	// followed out of the vault.
	info, err := os.Lstat(fullPath)
	if err != nil || !info.Mode().IsRegular() {
		return NoteMetadata{}
	}

	created := createdTime(info)

	file, err := os.Open(fullPath)
	if err != nil {
		return NoteMetadata{}
	}
	defer file.Close()

	return NoteMetadata{
		Created:  FormatTime(created),
		Modified: FormatTime(info.ModTime()),
		Size:     info.Size(),
		Lines:    countLines(file),
	}
}

// metadataLineLimit is the largest line countLines reads as a single line
// before falling back to a byte count; bufio.Scanner's default is 64 KiB and
// silently stops there, turning a long line into a truncated count.
const metadataLineLimit = 1 << 20

// countLines counts lines the way a text editor shows them: every "\n" opens
// a line, and a final unterminated line still counts as one (empty files have
// no lines). If even metadataLineLimit is not enough for one line, the file is
// recounted from the bytes so a pathological note cannot silently report
// fewer lines than it has.
func countLines(file *os.File) int {
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), metadataLineLimit)
	lineCount := 0
	for scanner.Scan() {
		lineCount++
	}
	if scanner.Err() == nil {
		return lineCount
	}

	// The scan hit (or exceeded) the buffer limit: rewind and count "\n"
	// bytes instead, adding the final unterminated line when the file does
	// not end with one.
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return lineCount
	}
	newlines := 0
	sawByte := false
	endsNewline := true
	var chunk [64 * 1024]byte
	for {
		n, readErr := file.Read(chunk[:])
		if n > 0 {
			sawByte = true
			newlines += bytes.Count(chunk[:n], []byte{'\n'})
			endsNewline = chunk[n-1] == '\n'
		}
		if readErr != nil {
			break
		}
	}
	if sawByte && !endsNewline {
		newlines++
	}
	return newlines
}

// Media handling
var mediaExtensions = map[string][]string{
	"image":    {".jpg", ".jpeg", ".png", ".gif", ".webp"},
	"audio":    {".mp3", ".wav", ".ogg", ".m4a"},
	"video":    {".mp4", ".webm", ".mov", ".avi"},
	"document": {".pdf"},
}

func GetMediaType(filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))
	for mediaType, exts := range mediaExtensions {
		for _, e := range exts {
			if ext == e {
				return mediaType
			}
		}
	}
	return ""
}

func AllMediaExtensions() map[string]struct{} {
	all := make(map[string]struct{})
	for _, exts := range mediaExtensions {
		for _, e := range exts {
			all[e] = struct{}{}
		}
	}
	return all
}

var sanitizeRe = regexp.MustCompile(`[\\/:*?"<>|\x00-\x1f]`)
var multiUnderscores = regexp.MustCompile(`_+`)

func SanitizeFilename(filename string) string {
	if filename == "" {
		return filename
	}
	ext := filepath.Ext(filename)
	stem := strings.TrimSuffix(filename, ext)

	name := sanitizeRe.ReplaceAllString(stem, "_")
	name = multiUnderscores.ReplaceAllString(name, "_")
	name = strings.Trim(name, "_ ")
	if name == "" {
		name = "unnamed"
	}
	return name + ext
}

func (v *Vault) GetAttachmentDir(notePath string) string {
	if notePath == "" {
		return filepath.Join(v.notesDir, "_attachments")
	}
	clean := strings.ReplaceAll(notePath, "\\", "/")
	// filepath.Dir returns the platform separator; back to slash form before
	// splitting so the _attachments check also works segment-wise on Windows.
	dir := filepath.ToSlash(filepath.Dir(clean))
	if dir == "." || dir == "" {
		return filepath.Join(v.notesDir, "_attachments")
	}
	// A note that already lives inside an _attachments tree (for example one
	// opened from the media viewer, or a synthetic upload path built from a
	// browsed attachment folder) must not get another _attachments level.
	for _, segment := range strings.Split(dir, "/") {
		if segment == "_attachments" {
			return filepath.Join(v.notesDir, dir)
		}
	}
	return filepath.Join(v.notesDir, dir, "_attachments")
}

func (v *Vault) SaveUploadedImage(notePath string, filename string, data []byte) (string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	timestamp := time.Now().Format("20060102150405")

	sanitized := SanitizeFilename(filename)
	ext := filepath.Ext(sanitized)
	stem := strings.TrimSuffix(sanitized, ext)
	finalFilename := fmt.Sprintf("%s-%s%s", stem, timestamp, ext)

	attachDir := v.GetAttachmentDir(notePath)
	if err := os.MkdirAll(attachDir, 0755); err != nil {
		return "", err
	}
	fullPath := filepath.Join(attachDir, finalFilename)
	if !v.ValidatePathSecurity(fullPath) {
		return "", fmt.Errorf("security validation failed")
	}
	if err := os.WriteFile(fullPath, data, 0644); err != nil {
		return "", err
	}
	rel, _ := filepath.Rel(v.notesDir, fullPath)
	// New media file: the next listing must see it, so drop the snapshot.
	v.scanCache.invalidate()
	return strings.ReplaceAll(rel, "\\", "/"), nil
}

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

	err := filepath.WalkDir(v.notesDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil || (info.Mode()&os.ModeSymlink != 0) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		relPath, err := filepath.Rel(v.notesDir, path)
		if err != nil {
			return nil
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

		// Track every eligible file (media included even when this call asked
		// for notes only) so prune() does not thrash media entries between
		// calls with different includeMedia.
		seen[relStr] = struct{}{}

		parentFolder := filepath.Dir(relStr)
		if parentFolder == "." {
			parentFolder = ""
		} else {
			// filepath.Dir emits the platform separator; listings are kept in
			// slash form everywhere so folder paths are cross-platform equal.
			parentFolder = strings.ReplaceAll(parentFolder, "\\", "/")
		}
		stem := strings.TrimSuffix(name, filepath.Ext(name))

		if isMarkdown {
			var tags []string
			if e, ok := v.idx.get(relStr, info.ModTime(), info.Size()); ok {
				tags = e.tags
			} else if data, err := os.ReadFile(path); err == nil {
				// CRLF-normalized once here; cached content and ParseTags see
				// the same bytes the rest of the app does.
				content := strings.ReplaceAll(string(data), "\r\n", "\n")
				tags = v.idx.putNote(relStr, info.ModTime(), info.Size(), content)
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
	for f := range folderSet {
		folders = append(folders, f)
	}
	sort.Strings(folders)

	// The cache takes ownership of the walk slices from here on.
	return v.scanCache.store(notes, folders), nil
}

// Backlinks resolution

// TagCounts returns the tag histogram for the current snapshot. The counts are
// computed once per snapshot and cached, so the sidebar endpoint does not walk
// every note on every request.
func (v *Vault) TagCounts() (map[string]int, error) {
	snap, err := v.scanNotesSnapshot()
	if err != nil {
		return nil, err
	}
	return snap.tagCounts(), nil
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

// linkContext builds the surrounding-text window backlinks show for one link,
// clipped30 bytes around the match span and ellipsized at the edges. The
// window is computed once, when the note is indexed.
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

// extractOutLinks finds every wikilink and markdown link in content exactly
// once, when the note is indexed: backlinks and the graph then query these
// occurrences instead of re-running the regexes over the whole vault on every
// request. Targets are normalized the way each consumer needs them (wikilinks
// already have their "#Heading" anchor stripped; markdown links keep the raw,
// trimmed destination so resolution can stay relative to the reading note).
func extractOutLinks(content string) (wiki, md []LinkOcc) {
	lines := strings.Split(content, "\n")
	for lineNum, line := range lines {
		num := lineNum + 1

		// Wikilinks
		for _, match := range wikilinkRe.FindAllStringSubmatchIndex(line, -1) {
			target := strings.TrimSpace(line[match[2]:match[3]])
			// [[Note#Heading]] is a link to Note; the heading is an anchor,
			// not part of the target path.
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

		// Markdown links
		for _, match := range mdlinkRe.FindAllStringSubmatchIndex(line, -1) {
			rawTarget := strings.TrimSpace(line[match[4]:match[5]])
			if isExternalOrFragmentLink(rawTarget) {
				continue
			}
			if strings.Split(rawTarget, "#")[0] == "" {
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

// Resolver for graph edges
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

func (r *LinkResolver) ResolveWikilink(target string, sourceFolder string) string {
	target = strings.TrimSpace(target)
	// [[Note#Heading]] points at Note; the anchor only matters when the note
	// is opened, not when resolving the edge/backlink target.
	if idx := strings.Index(target, "#"); idx != -1 {
		target = strings.TrimSpace(target[:idx])
	}
	if target == "" {
		return ""
	}
	targetLower := strings.ToLower(target)

	// 1. Relative to source folder
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

	// 2. Relative to vault root
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

	// 3. Fallback to stem
	if orig, ok := r.noteNames[targetLower]; ok {
		return orig
	}

	return ""
}

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

func IsUnderSystemFolder(path string) bool {
	parent := ""
	if strings.Contains(path, "/") {
		idx := strings.LastIndex(path, "/")
		parent = path[:idx]
	}
	if parent == "" || parent == "." {
		return false
	}
	segments := strings.Split(parent, "/")
	for _, seg := range segments {
		if strings.HasPrefix(seg, "_") {
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

	// The resolver is built with the snapshot (its path set only changes when
	// notes are added or removed), so the graph no longer rebuilds it per
	// request.
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
		p := note.Path
		if !includeSystemFolders && IsUnderSystemFolder(p) {
			continue
		}
		nodes = append(nodes, GraphNode{
			ID:    p,
			Label: strings.TrimSuffix(filepath.Base(p), filepath.Ext(p)),
		})

		// Links were extracted when the note was indexed: no content read and
		// no regex pass per graph request.
		wikiLinks, mdLinks := v.idx.links(p)

		sourceFolder := strings.ReplaceAll(filepath.Dir(p), "\\", "/")
		if sourceFolder == "." {
			sourceFolder = ""
		}

		// 1. Wikilinks (first-wins)
		for _, occ := range wikiLinks {
			resolved := resolver.ResolveWikilink(occ.Target, sourceFolder)
			if resolved != "" && resolved != p {
				if !includeSystemFolders && IsUnderSystemFolder(resolved) {
					continue
				}
				k := edgeKey{s: p, t: resolved}
				if _, exists := edgeMap[k]; !exists {
					edgeMap[k] = GraphEdge{
						Source: p,
						Target: resolved,
						Type:   "wikilink",
					}
				}
			}
		}

		// 2. Markdown links
		for _, occ := range mdLinks {
			resolved := resolver.ResolveMDLink(occ.Target, sourceFolder)
			if resolved != "" && resolved != p {
				if !includeSystemFolders && IsUnderSystemFolder(resolved) {
					continue
				}
				k := edgeKey{s: p, t: resolved}
				if _, exists := edgeMap[k]; !exists {
					edgeMap[k] = GraphEdge{
						Source: p,
						Target: resolved,
						Type:   "markdown",
					}
				}
			}
		}
	}

	edges := make([]GraphEdge, 0, len(edgeMap))
	for _, e := range edgeMap {
		edges = append(edges, e)
	}

	return GraphData{
		Nodes: nodes,
		Edges: edges,
	}, nil
}
