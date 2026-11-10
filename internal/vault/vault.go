package vault

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"regexp"
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
	walkDir   func(string, fs.WalkDirFunc) error

	moveLinkWrite func(string, string) error

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
		walkDir:   filepath.WalkDir,
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
	// Deleted is true when a non-empty baseHash was supplied but the note no
	// longer exists. The caller must ask before intentionally recreating it.
	Deleted bool
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
// note as baseHash, and if another writer changed or deleted it since, nothing
// is written and the changed content hash or Deleted flag comes back.
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
	if baseHash != "" && !exists {
		return SaveNoteResult{Deleted: true}, nil
	}
	if baseHash != "" {
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
