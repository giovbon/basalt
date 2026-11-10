package vault

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// notePaths is a set of the note paths a listing returned.
func notePaths(notes []NoteRecord) map[string]struct{} {
	set := make(map[string]struct{}, len(notes))
	for _, n := range notes {
		set[n.Path] = struct{}{}
	}
	return set
}

func hasPath(set map[string]struct{}, path string) bool {
	_, ok := set[path]
	return ok
}

func TestScanNotesDoesNotCachePartialWalkOnError(t *testing.T) {
	dir := t.TempDir()
	v := New(dir)
	if err := v.SaveNote("complete.md", "complete\n"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := v.ScanNotes(false); err != nil {
		t.Fatal(err)
	}
	v.scanCache.mu.Lock()
	cachedSnapshot := v.scanCache.snap
	v.scanCache.mu.Unlock()

	walkErr := errors.New("injected directory read failure")
	originalWalkDir := v.walkDir
	v.walkDir = func(root string, walkFn fs.WalkDirFunc) error {
		return filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
			if err == nil && path == filepath.Join(root, "blocked") {
				return walkFn(path, nil, walkErr)
			}
			return walkFn(path, entry, err)
		})
	}
	if err := os.Mkdir(filepath.Join(dir, "blocked"), 0755); err != nil {
		t.Fatal(err)
	}

	v.scanCache.invalidate()
	if _, _, err := v.ScanNotes(false); !errors.Is(err, walkErr) {
		t.Fatalf("ScanNotes error = %v, want injected walk error", err)
	}
	v.scanCache.mu.Lock()
	snapshotAfterFailure := v.scanCache.snap
	cacheStillStale := v.scanCache.stale
	v.scanCache.mu.Unlock()
	if snapshotAfterFailure != cachedSnapshot || !cacheStillStale {
		t.Fatal("failed walk replaced or validated the cached snapshot")
	}

	v.walkDir = originalWalkDir
	notes, _, err := v.ScanNotes(false)
	if err != nil {
		t.Fatal(err)
	}
	if !hasPath(notePaths(notes), "complete.md") {
		t.Errorf("successful retry omitted complete.md: %v", notePaths(notes))
	}
}

// TestScanNotesServesSnapshotUntilWriteOrTTL pins the two refresh paths of the
// walk cache: app writes are visible immediately (patched), external edits only
// after the TTL forces a new walk.
func TestScanNotesServesSnapshotUntilWriteOrTTL(t *testing.T) {
	oldTTL := scanCacheTTL
	scanCacheTTL = time.Hour
	defer func() { scanCacheTTL = oldTTL }()

	dir := t.TempDir()
	v := New(dir)
	if err := v.SaveNote("one.md", "one\n"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := v.ScanNotes(false); err != nil {
		t.Fatal(err)
	}

	// Edit made outside the app, inside the TTL window: not walked yet...
	if err := os.WriteFile(filepath.Join(dir, "external.md"), []byte("external\n"), 0644); err != nil {
		t.Fatal(err)
	}
	// ...while an app write is visible right away.
	if err := v.SaveNote("app.md", "app\n"); err != nil {
		t.Fatal(err)
	}

	notes, _, err := v.ScanNotes(false)
	if err != nil {
		t.Fatal(err)
	}
	set := notePaths(notes)
	if !hasPath(set, "one.md") || !hasPath(set, "app.md") {
		t.Errorf("listing = %v, want one.md and app.md", set)
	}
	if hasPath(set, "external.md") {
		t.Errorf("listing picked up an external edit before the TTL expired: %v", set)
	}

	// Once the TTL expires the walk runs again and notices the edit.
	scanCacheTTL = 0
	notes, _, err = v.ScanNotes(false)
	if err != nil {
		t.Fatal(err)
	}
	if !hasPath(notePaths(notes), "external.md") {
		t.Errorf("listing = %v, want external.md after TTL expiry", notePaths(notes))
	}
}

// TestScanNotesPatchesSavesAndDeletesWithoutWalking verifies saves, new nested
// folders and deletes update the snapshot in place: the canary file written
// behind the app's back would only show up if a walk had happened.
func TestScanNotesPatchesSavesAndDeletesWithoutWalking(t *testing.T) {
	oldTTL := scanCacheTTL
	scanCacheTTL = time.Hour
	defer func() { scanCacheTTL = oldTTL }()

	dir := t.TempDir()
	v := New(dir)
	if err := v.SaveNote("keep.md", "keep\n"); err != nil {
		t.Fatal(err)
	}
	if err := v.SaveNote("Folder/note.md", "first\n"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := v.ScanNotes(false); err != nil {
		t.Fatal(err)
	}

	// Canary: only a full walk would reveal this file.
	if err := os.WriteFile(filepath.Join(dir, "external.md"), []byte("x\n"), 0644); err != nil {
		t.Fatal(err)
	}

	if err := v.SaveNote("Folder/note.md", "updated\n"); err != nil {
		t.Fatal(err)
	}
	if err := v.SaveNote("another.md", "new\n"); err != nil {
		t.Fatal(err)
	}
	if err := v.SaveNote("Brand/New/note.md", "deep\n"); err != nil {
		t.Fatal(err)
	}
	if !v.DeleteNote("keep.md") {
		t.Fatal("DeleteNote(keep.md) failed")
	}

	notes, folders, err := v.ScanNotes(false)
	if err != nil {
		t.Fatal(err)
	}
	set := notePaths(notes)
	for _, want := range []string{"Folder/note.md", "another.md", "Brand/New/note.md"} {
		if !hasPath(set, want) {
			t.Errorf("listing missing %q: %v", want, set)
		}
	}
	if hasPath(set, "keep.md") {
		t.Errorf("deleted note still listed: %v", set)
	}
	if hasPath(set, "external.md") {
		t.Errorf("snapshot was rebuilt by a walk: %v", set)
	}

	wantFolders := []string{"Brand", "Brand/New", "Folder"}
	if len(folders) != len(wantFolders) {
		t.Fatalf("folders = %v, want %v", folders, wantFolders)
	}
	for i, want := range wantFolders {
		if folders[i] != want {
			t.Errorf("folders[%d] = %q, want %q (full list %v)", i, folders[i], want, folders)
		}
	}
}

// TestScanNotesFiltersMediaByFlag checks the snapshot always stores media but
// only hands it to callers that asked for it.
func TestScanNotesFiltersMediaByFlag(t *testing.T) {
	dir := t.TempDir()
	v := New(dir)
	if err := v.SaveNote("n.md", "note\n"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "img.png"), []byte{0x89, 'P', 'N', 'G'}, 0644); err != nil {
		t.Fatal(err)
	}

	withMedia, _, err := v.ScanNotes(true)
	if err != nil {
		t.Fatal(err)
	}
	seenMedia := false
	for _, n := range withMedia {
		if n.Path == "img.png" {
			seenMedia = true
			if n.Type != "image" {
				t.Errorf("media type = %q, want image", n.Type)
			}
		}
	}
	if !seenMedia {
		t.Errorf("ScanNotes(true) missing img.png: %v", notePaths(withMedia))
	}

	notesOnly, _, err := v.ScanNotes(false)
	if err != nil {
		t.Fatal(err)
	}
	if hasPath(notePaths(notesOnly), "img.png") {
		t.Errorf("ScanNotes(false) returned media: %v", notePaths(notesOnly))
	}
	if !hasPath(notePaths(notesOnly), "n.md") {
		t.Errorf("ScanNotes(false) missing the note: %v", notePaths(notesOnly))
	}
}
