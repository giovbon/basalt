package vault

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"notediscovery/internal/search"
)

func TestGetBacklinksIncludesHeadingAnchoredWikilinks(t *testing.T) {
	dir := t.TempDir()
	v := New(dir)

	if err := v.SaveNote("nota tal.md", "# Cap 1\n\nBody.\n"); err != nil {
		t.Fatal(err)
	}
	if err := v.SaveNote("source.md", "See [[nota tal#Cap 1]] and [[nota tal#Other|alias]].\n"); err != nil {
		t.Fatal(err)
	}

	backlinks := v.GetBacklinks("nota tal.md")
	if len(backlinks) != 1 {
		t.Fatalf("backlinks = %#v, want one item", backlinks)
	}
	if backlinks[0].Path != "source.md" {
		t.Fatalf("backlink path = %q, want source.md", backlinks[0].Path)
	}
	if len(backlinks[0].References) != 2 {
		t.Fatalf("references = %#v, want two anchored links", backlinks[0].References)
	}
}

func TestMoveNoteUpdatesWikilinksToRenamedNote(t *testing.T) {
	dir := t.TempDir()
	v := New(dir)
	if err := v.SaveNote("folder/nota-1.md", "# Nota\n"); err != nil {
		t.Fatal(err)
	}
	sameFolderLinks := "[[nota-1]] [[nota-1.md|alias]] [[nota-1#Head]] [[folder/nota-1.md]] [[other]] [markdown](nota-1.md)\n"
	if err := v.SaveNote("folder/source.md", sameFolderLinks); err != nil {
		t.Fatal(err)
	}
	if err := v.SaveNote("outside.md", "Veja [[nota-1]] e [[nota-1#Head|alias]].\n"); err != nil {
		t.Fatal(err)
	}

	if err := v.MoveNote("folder/nota-1.md", "folder/nota-2.md"); err != nil {
		t.Fatal(err)
	}

	got, err := v.GetNoteContent("folder/source.md")
	if err != nil {
		t.Fatal(err)
	}
	want := "[[nota-2]] [[nota-2.md|alias]] [[nota-2#Head]] [[folder/nota-2.md]] [[other]] [markdown](nota-1.md)\n"
	if got != want {
		t.Errorf("same-folder links = %q, want %q", got, want)
	}

	got, err = v.GetNoteContent("outside.md")
	if err != nil {
		t.Fatal(err)
	}
	if want := "Veja [[folder/nota-2]] e [[folder/nota-2#Head|alias]].\n"; got != want {
		t.Errorf("outside links = %q, want %q", got, want)
	}

	if got := v.GetBacklinks("folder/nota-2.md"); len(got) != 2 {
		t.Errorf("backlinks after rename = %#v, want both source notes", got)
	}
}

func TestMoveNoteRefreshesListingAndPersistedIndex(t *testing.T) {
	dir := t.TempDir()
	indexPath := filepath.Join(t.TempDir(), ".basalt-index.gob")
	v := New(dir)
	if err := v.StartIndexPersistence(indexPath); err != nil {
		t.Fatal(err)
	}
	if err := v.SaveNote("folder/old.md", "# Target\n"); err != nil {
		t.Fatal(err)
	}
	if err := v.SaveNote("source.md", "See [[folder/old]].\n"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := v.ScanNotes(false); err != nil {
		t.Fatal(err)
	}

	if err := v.MoveNote("folder/old.md", "moved/new.md"); err != nil {
		t.Fatal(err)
	}
	notes, _, err := v.ScanNotes(false)
	if err != nil {
		t.Fatal(err)
	}
	paths := notePaths(notes)
	if hasPath(paths, "folder/old.md") || !hasPath(paths, "moved/new.md") {
		t.Fatalf("listing after move = %v, want moved/new.md and no folder/old.md", paths)
	}
	got, err := v.GetNoteContent("source.md")
	if err != nil {
		t.Fatal(err)
	}
	if got != "See [[moved/new]].\n" {
		t.Errorf("source after move = %q, want updated wikilink", got)
	}
	if err := v.SaveIndexNow(); err != nil {
		t.Fatal(err)
	}
	v.Close()

	restored := New(dir)
	if err := restored.StartIndexPersistence(indexPath); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(restored.Close)
	if got := restored.GetBacklinks("moved/new.md"); len(got) != 1 || got[0].Path != "source.md" {
		t.Errorf("restored backlinks = %+v, want source.md", got)
	}
	restored.idx.mu.RLock()
	_, oldEntryExists := restored.idx.entries["folder/old.md"]
	_, newEntryExists := restored.idx.entries["moved/new.md"]
	restored.idx.mu.RUnlock()
	if oldEntryExists || !newEntryExists {
		t.Errorf("restored index old path exists = %v, new path exists = %v", oldEntryExists, newEntryExists)
	}
}

func TestMoveNoteRollsBackWhenLinkWriteFails(t *testing.T) {
	dir := t.TempDir()
	v := New(dir)
	if err := v.SaveNote("target.md", "target\n"); err != nil {
		t.Fatal(err)
	}
	originalLinks := "See [[target]].\n"
	for _, path := range []string{"a-source.md", "b-source.md"} {
		if err := v.SaveNote(path, originalLinks); err != nil {
			t.Fatal(err)
		}
	}

	writes := 0
	v.moveLinkWrite = func(path, content string) error {
		writes++
		if writes == 2 {
			return errors.New("injected write failure")
		}
		return v.saveNoteLocked(path, content)
	}

	err := v.MoveNote("target.md", "renamed.md")
	if err == nil {
		t.Fatal("MoveNote succeeded despite a link write failure")
	}
	if !strings.Contains(err.Error(), "Move was rolled back") {
		t.Fatalf("MoveNote error = %q, want explicit rollback result", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "target.md")); err != nil {
		t.Errorf("original note was not restored: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "renamed.md")); !os.IsNotExist(err) {
		t.Errorf("destination still exists after rollback, stat error = %v", err)
	}
	for _, path := range []string{"a-source.md", "b-source.md"} {
		got, err := os.ReadFile(filepath.Join(dir, path))
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != originalLinks {
			t.Errorf("%s = %q after rollback, want %q", path, got, originalLinks)
		}
	}
}

func TestResolveWikilinkIgnoresHeadingAnchor(t *testing.T) {
	r := NewLinkResolver([]string{"target.md", "folder/note.md"})

	if got := r.ResolveWikilink("target#Cap 1", ""); got != "target.md" {
		t.Fatalf("ResolveWikilink(target#Cap 1) = %q, want target.md", got)
	}
	if got := r.ResolveWikilink("note#Intro", "folder"); got != "folder/note.md" {
		t.Fatalf("ResolveWikilink(note#Intro) = %q, want folder/note.md", got)
	}
	if got := r.ResolveWikilink("#Cap 1", ""); got != "" {
		t.Fatalf("ResolveWikilink(#Cap 1) = %q, want empty", got)
	}
}

func TestGetAttachmentDirDoesNotNestAttachments(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "vault")
	v := New(root)

	tests := []struct {
		notePath string
		want     string
	}{
		{"", filepath.Join(root, "_attachments")},
		{"note.md", filepath.Join(root, "_attachments")},
		{"Projects/note.md", filepath.Join(root, "Projects", "_attachments")},
		{"_attachments/note.md", filepath.Join(root, "_attachments")},
		{"Projects/_attachments/note.md", filepath.Join(root, "Projects", "_attachments")},
		{"Projects/_attachments/sub/note.md", filepath.Join(root, "Projects", "_attachments", "sub")},
	}

	for _, tt := range tests {
		if got := v.GetAttachmentDir(tt.notePath); got != tt.want {
			t.Errorf("GetAttachmentDir(%q) = %q, want %q", tt.notePath, got, tt.want)
		}
	}
}

// TestGetFoldedContentCachesAndFollowsEdits covers the search fast path: the
// fold is accent/case-free, served from the index, and tracks edits made
// outside the app once the file's (mtime, size) change.
func TestGetFoldedContentCachesAndFollowsEdits(t *testing.T) {
	dir := t.TempDir()
	v := New(dir)
	if err := v.SaveNote("nota.md", "O coração\n"); err != nil {
		t.Fatal(err)
	}

	folded, err := v.GetFoldedContent("nota.md")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(folded, "coracao") {
		t.Errorf("folded = %q, want accent-free lowercase text", folded)
	}

	again, err := v.GetFoldedContent("nota.md")
	if err != nil {
		t.Fatal(err)
	}
	if again != folded {
		t.Errorf("second fold = %q, want cached %q", again, folded)
	}

	// External rewrite (different size): the fold must follow the new bytes.
	edited := "A CORACAO maior\n"
	if err := os.WriteFile(filepath.Join(dir, "nota.md"), []byte(edited), 0644); err != nil {
		t.Fatal(err)
	}
	folded, err = v.GetFoldedContent("nota.md")
	if err != nil {
		t.Fatal(err)
	}
	if want := search.FoldContent(edited); folded != want {
		t.Errorf("fold after edit = %q, want %q", folded, want)
	}
}

// TestGetBacklinksMarkdownRelativeAndTruncation exercises the indexed-link
// path: markdown links resolve relative to the reading note, references keep
// line order (wikilink before markdown on the same line) and are capped at3.
func TestGetBacklinksMarkdownRelativeAndTruncation(t *testing.T) {
	dir := t.TempDir()
	v := New(dir)
	if err := v.SaveNote("folder/target.md", "# T\n"); err != nil {
		t.Fatal(err)
	}
	source := "line1 [[target]]\n" +
		"line2 [t](target.md) and [[target#Head]]\n" +
		"line3 [[target]]\n"
	if err := v.SaveNote("folder/source.md", source); err != nil {
		t.Fatal(err)
	}

	backlinks := v.GetBacklinks("folder/target.md")
	if len(backlinks) != 1 {
		t.Fatalf("backlinks = %#v, want one item", backlinks)
	}
	refs := backlinks[0].References
	if len(refs) != 3 {
		t.Fatalf("references = %#v, want exactly 3 (capped)", refs)
	}
	want := []struct {
		line int
		typ  string
	}{{1, "wikilink"}, {2, "wikilink"}, {2, "markdown"}}
	for i, w := range want {
		if refs[i].LineNumber != w.line || refs[i].Type != w.typ {
			t.Errorf("refs[%d] = line %d/%s, want line %d/%s", i, refs[i].LineNumber, refs[i].Type, w.line, w.typ)
		}
	}
	if refs[0].Context != "line1 [[target]]" {
		t.Errorf("context = %q, want %q", refs[0].Context, "line1 [[target]]")
	}
}

// TestGetBacklinksSeesExternalLinkEdits makes sure link occurrences are
// refreshed when the file changes on disk: a scan re-reads the note and
// re-extracts its links, so backlinks never serve a stale graph for long.
func TestGetBacklinksSeesExternalLinkEdits(t *testing.T) {
	oldTTL := scanCacheTTL
	scanCacheTTL = 0
	defer func() { scanCacheTTL = oldTTL }()

	dir := t.TempDir()
	v := New(dir)
	if err := v.SaveNote("target.md", "# T\n"); err != nil {
		t.Fatal(err)
	}
	if err := v.SaveNote("source.md", "no links here\n"); err != nil {
		t.Fatal(err)
	}
	if got := v.GetBacklinks("target.md"); len(got) != 0 {
		t.Fatalf("backlinks before edit = %#v, want none", got)
	}

	if err := os.WriteFile(filepath.Join(dir, "source.md"), []byte("now [[target]]\n"), 0644); err != nil {
		t.Fatal(err)
	}
	got := v.GetBacklinks("target.md")
	if len(got) != 1 || got[0].Path != "source.md" {
		t.Fatalf("backlinks after edit = %#v, want source.md linking back", got)
	}
	if len(got[0].References) != 1 || got[0].References[0].LineNumber != 1 {
		t.Errorf("references = %#v, want one wikilink on line 1", got[0].References)
	}
}

// TestGetGraphDataFromIndexedLinks checks the graph is built from the links
// recorded at index time, both wikilinks and markdown links.
func TestGetGraphDataFromIndexedLinks(t *testing.T) {
	dir := t.TempDir()
	v := New(dir)
	for path, content := range map[string]string{
		"target.md": "# T\n",
		"other.md":  "# O\n",
		"source.md": "see [[target]] and [go](other.md)\n",
	} {
		if err := v.SaveNote(path, content); err != nil {
			t.Fatal(err)
		}
	}

	data, err := v.GetGraphData(true)
	if err != nil {
		t.Fatal(err)
	}
	if len(data.Nodes) != 3 {
		t.Errorf("nodes = %d, want 3 (%v)", len(data.Nodes), data.Nodes)
	}
	edges := make(map[string]string, len(data.Edges))
	for _, e := range data.Edges {
		edges[e.Source+" -> "+e.Target] = e.Type
	}
	if edges["source.md -> target.md"] != "wikilink" {
		t.Errorf("wikilink edge = %q, want wikilink (%v)", edges["source.md -> target.md"], edges)
	}
	if edges["source.md -> other.md"] != "markdown" {
		t.Errorf("markdown edge = %q, want markdown (%v)", edges["source.md -> other.md"], edges)
	}
}

// TestCacheBudgetsEvictLRUInsteadOfDisabling pins the behaviour that replaced
// the old cliff: when a pool fills up the least recently used payload is
// evicted and every note stays readable (content falls back to disk), instead
// of the whole cache being switched off.
func TestCacheBudgetsEvictLRUInsteadOfDisabling(t *testing.T) {
	oldContent, oldFold := contentCacheBudget, foldCacheBudget
	contentCacheBudget = 140
	foldCacheBudget = 140
	defer func() {
		contentCacheBudget = oldContent
		foldCacheBudget = oldFold
	}()

	dir := t.TempDir()
	v := New(dir)
	payload := strings.Repeat("x", 50)
	for _, path := range []string{"a.md", "b.md", "c.md"} {
		if err := v.SaveNote(path, payload); err != nil {
			t.Fatal(err)
		}
	}

	if v.idx.contentBytes > contentCacheBudget {
		t.Errorf("contentBytes = %d, over budget %d", v.idx.contentBytes, contentCacheBudget)
	}
	if v.idx.entries["a.md"].hasContent {
		t.Error("a.md should have been evicted (least recently used)")
	}
	if !v.idx.entries["c.md"].hasContent {
		t.Error("c.md should still be cached")
	}

	// Reading the evicted note serves it from disk and evicts the new LRU (b).
	got, err := v.GetNoteContent("a.md")
	if err != nil {
		t.Fatal(err)
	}
	if got != payload {
		t.Errorf("GetNoteContent = %q, want %q", got, payload)
	}
	if !v.idx.entries["a.md"].hasContent {
		t.Error("a.md should be cached again after being read")
	}
	if v.idx.entries["b.md"].hasContent {
		t.Error("b.md should have been evicted after a.md was read")
	}

	// The fold pool follows the same rules and every note stays foldable.
	for _, path := range []string{"a.md", "b.md", "c.md"} {
		if _, err := v.GetFoldedContent(path); err != nil {
			t.Fatalf("GetFoldedContent(%s): %v", path, err)
		}
	}
	if v.idx.foldedBytes > foldCacheBudget {
		t.Errorf("foldedBytes = %d, over budget %d", v.idx.foldedBytes, foldCacheBudget)
	}
	if v.idx.contentBytes > contentCacheBudget {
		t.Errorf("contentBytes = %d, over budget %d after folding", v.idx.contentBytes, contentCacheBudget)
	}
}

// TestSaveNoteIfHash covers the compare-and-swap save: wrong base hash
// refuses to write and reports the current hash, a matching base hash writes
// without marking the note as created, and a new path is created.
func TestSaveNoteIfHashCompareAndSwap(t *testing.T) {
	dir := t.TempDir()
	v := New(dir)

	original := "# Note\n\nbody\n"
	if err := v.SaveNote("note.md", original); err != nil {
		t.Fatal(err)
	}
	baseHash := ContentHash(original)

	before, err := os.ReadFile(filepath.Join(dir, "note.md"))
	if err != nil {
		t.Fatal(err)
	}

	// Wrong base hash: nothing is written and the current hash comes back.
	res, err := v.SaveNoteIfHash("note.md", "# Tampered\n", "wrong-hash")
	if err != nil {
		t.Fatal(err)
	}
	if res.Saved {
		t.Error("Saved = true, want false with a wrong base hash")
	}
	if res.CurrentHash != baseHash {
		t.Errorf("CurrentHash = %q, want current content hash %q", res.CurrentHash, baseHash)
	}
	after, err := os.ReadFile(filepath.Join(dir, "note.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Error("file was modified despite a wrong base hash")
	}

	// Matching base hash: saved, but not created.
	res, err = v.SaveNoteIfHash("note.md", "# Updated\n", baseHash)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Saved {
		t.Error("Saved = false, want true with a matching base hash")
	}
	if res.Created {
		t.Error("Created = true, want false for an existing note")
	}
	if res.CurrentHash != ContentHash("# Updated\n") {
		t.Errorf("CurrentHash = %q, want hash of the new content", res.CurrentHash)
	}

	// New path with empty base hash: always saves and is marked created.
	res, err = v.SaveNoteIfHash("new.md", "# Brand new\n", "")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Saved || !res.Created {
		t.Errorf("Saved = %v, Created = %v, want true true", res.Saved, res.Created)
	}
}

func TestSaveNoteIfHashDoesNotRecreateDeletedNote(t *testing.T) {
	dir := t.TempDir()
	v := New(dir)
	original := "original content\n"
	if err := v.SaveNote("note.md", original); err != nil {
		t.Fatal(err)
	}
	if !v.DeleteNote("note.md") {
		t.Fatal("DeleteNote(note.md) failed")
	}

	result, err := v.SaveNoteIfHash("note.md", "unsaved edits\n", ContentHash(original))
	if err != nil {
		t.Fatal(err)
	}
	if result.Saved || !result.Deleted {
		t.Errorf("result = %+v, want Deleted true and Saved false", result)
	}
	if _, err := os.Stat(filepath.Join(dir, "note.md")); !os.IsNotExist(err) {
		t.Errorf("deleted note was recreated, stat error = %v", err)
	}
}

// TestGetNoteContentRejectsSymlink ensures a symlink inside the vault that
// points outside it is never followed.
func TestGetNoteContentRejectsSymlink(t *testing.T) {
	dir := t.TempDir()
	v := New(dir)

	outsideDir := t.TempDir()
	outside := filepath.Join(outsideDir, "outside.txt")
	if err := os.WriteFile(outside, []byte("outside secret data\n"), 0644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.md")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks not supported in this environment: %v", err)
	}

	if _, err := v.GetNoteContent("link.md"); err == nil {
		t.Error("GetNoteContent followed a symlink to a file outside the vault")
	}
	if _, err := v.GetFoldedContent("link.md"); err == nil {
		t.Error("GetFoldedContent followed a symlink to a file outside the vault")
	}
}

// TestDeleteFolderRootRefused ensures DeleteFolder(".") refuses to delete the
// vault root and leaves every note intact.
func TestDeleteFolderRootRefused(t *testing.T) {
	dir := t.TempDir()
	v := New(dir)
	if err := v.SaveNote("keep.md", "# keep\n"); err != nil {
		t.Fatal(err)
	}

	if err := v.DeleteFolder("."); err == nil {
		t.Error("DeleteFolder('.') = nil, want an error")
	} else if !errors.Is(err, ErrInvalidPath) {
		t.Errorf("DeleteFolder('.') error = %v, want ErrInvalidPath", err)
	}
	if _, err := v.GetNoteContent("keep.md"); err != nil {
		t.Errorf("note at vault root was deleted: %v", err)
	}
}

// TestTagCountsAreCachedAndCopied pins the sidebar fast path: counts are built
// once per snapshot and handed out as a copy, so a caller cannot corrupt the
// cache by mutating the map it received.
func TestTagCountsAreCachedAndCopied(t *testing.T) {
	dir := t.TempDir()
	v := New(dir)
	for path, content := range map[string]string{
		"a.md": "---\ntags: [alpha, beta]\n---\nbody\n",
		"b.md": "---\ntags: [beta]\n---\nbody\n",
	} {
		if err := v.SaveNote(path, content); err != nil {
			t.Fatal(err)
		}
	}

	counts, err := v.TagCounts()
	if err != nil {
		t.Fatal(err)
	}
	if counts["alpha"] != 1 || counts["beta"] != 2 {
		t.Fatalf("counts = %#v, want alpha:1 beta:2", counts)
	}

	counts["alpha"] = 99
	delete(counts, "beta")

	again, err := v.TagCounts()
	if err != nil {
		t.Fatal(err)
	}
	if again["alpha"] != 1 || again["beta"] != 2 {
		t.Errorf("counts after caller mutation = %#v, want cached alpha:1 beta:2", again)
	}
}

// TestScanNotesSnapshotSurvivesLaterWrites verifies the copy-on-write scan
// cache: a listing already handed to a caller must not change when a later save
// publishes a new snapshot.
func TestScanNotesSnapshotSurvivesLaterWrites(t *testing.T) {
	oldTTL := scanCacheTTL
	scanCacheTTL = time.Hour
	defer func() { scanCacheTTL = oldTTL }()

	dir := t.TempDir()
	v := New(dir)
	if err := v.SaveNote("first.md", "first\n"); err != nil {
		t.Fatal(err)
	}

	before, foldersBefore, err := v.ScanNotes(false)
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != 1 || before[0].Path != "first.md" {
		t.Fatalf("before = %#v, want first.md", notePaths(before))
	}
	if len(foldersBefore) != 0 {
		t.Fatalf("folders before = %v, want none", foldersBefore)
	}

	if err := v.SaveNote("second.md", "second\n"); err != nil {
		t.Fatal(err)
	}

	if len(before) != 1 || before[0].Path != "first.md" {
		t.Errorf("previously returned snapshot changed after a save: %#v", notePaths(before))
	}
	after, _, err := v.ScanNotes(false)
	if err != nil {
		t.Fatal(err)
	}
	if set := notePaths(after); !hasPath(set, "first.md") || !hasPath(set, "second.md") {
		t.Errorf("new snapshot = %v, want both notes", set)
	}
}

// TestGetBacklinksOrdersNotesByMTime checks the reverse index preserves the
// previous newest-first note ordering.
func TestGetBacklinksOrdersNotesByMTime(t *testing.T) {
	oldTTL := scanCacheTTL
	scanCacheTTL = 0
	defer func() { scanCacheTTL = oldTTL }()

	dir := t.TempDir()
	v := New(dir)
	if err := v.SaveNote("target.md", "# T\n"); err != nil {
		t.Fatal(err)
	}
	if err := v.SaveNote("older.md", "[[target]]\n"); err != nil {
		t.Fatal(err)
	}
	if err := v.SaveNote("newer.md", "[[target]]\n"); err != nil {
		t.Fatal(err)
	}

	now := time.Now()
	if err := os.Chtimes(filepath.Join(dir, "older.md"), now.Add(-2*time.Hour), now.Add(-2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(filepath.Join(dir, "newer.md"), now.Add(-time.Hour), now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}

	backlinks := v.GetBacklinks("target.md")
	if len(backlinks) != 2 {
		t.Fatalf("backlinks = %#v, want two", backlinks)
	}
	if backlinks[0].Path != "newer.md" || backlinks[1].Path != "older.md" {
		t.Errorf("backlink order = %q, %q; want newer.md, older.md", backlinks[0].Path, backlinks[1].Path)
	}
}
