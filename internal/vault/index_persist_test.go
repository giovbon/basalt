package vault

import (
	"bytes"
	"encoding/gob"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// readIndexFile decodes the persisted index at path, failing the test when it
// is missing or undecodable.
func readIndexFile(t *testing.T, path string) indexFile {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading index file: %v", err)
	}
	var f indexFile
	if err := gob.NewDecoder(bytes.NewReader(data)).Decode(&f); err != nil {
		t.Fatalf("decoding index file: %v", err)
	}
	return f
}

// entryView is a copy of the persisted fields of one index entry, read under
// the index lock so tests never share entry internals.
type entryView struct {
	mtime      time.Time
	size       int64
	tags       []string
	wikiLinks  []LinkOcc
	mdLinks    []LinkOcc
	hasLinks   bool
	hasContent bool
}

func entryFields(ix *Index, rel string) (entryView, bool) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	got, exists := ix.entries[rel]
	if !exists {
		return entryView{}, false
	}
	return entryView{
		mtime:      got.mtime,
		size:       got.size,
		tags:       got.tags,
		wikiLinks:  got.wikiLinks,
		mdLinks:    got.mdLinks,
		hasLinks:   got.hasLinks,
		hasContent: got.hasContent,
	}, true
}

// TestIndexPersistenceRoundTrip proves a fresh vault answers from the gob
// alone: the file is written by Close (final flush), loaded on start, and the
// first walk re-reads nothing — no content is restored (it is never
// persisted) and the index stays clean afterwards.
func TestIndexPersistenceRoundTrip(t *testing.T) {
	dir := t.TempDir()
	indexPath := filepath.Join(t.TempDir(), ".basalt-index.gob")

	if err := os.WriteFile(filepath.Join(dir, "a.md"),
		[]byte("---\ntags: [revisit]\n---\nsee [[b]]\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "b.md"), []byte("beta body\n"), 0644); err != nil {
		t.Fatal(err)
	}

	// First vault: populate and let Close's final flush write the file.
	v1 := New(dir)
	if err := v1.StartIndexPersistence(indexPath); err != nil {
		t.Fatal(err)
	}
	if _, _, err := v1.ScanNotes(false); err != nil {
		t.Fatal(err)
	}
	v1.Close()

	// Second vault: load before any walk.
	v2 := New(dir)
	if err := v2.StartIndexPersistence(indexPath); err != nil {
		t.Fatalf("loading index: %v", err)
	}
	t.Cleanup(v2.Close)

	e, ok := entryFields(v2.idx, "a.md")
	if !ok {
		t.Fatal("restored index has no entry for a.md")
	}
	if e.hasContent {
		t.Error("content must not be persisted; the restored entry must start without it")
	}
	if !e.hasLinks {
		t.Error("restored entry lost its extracted links")
	}
	if len(e.wikiLinks) == 0 || e.wikiLinks[0].Target != "b" {
		t.Errorf("restored wikilinks = %+v, want one to b", e.wikiLinks)
	}
	if len(e.tags) == 0 || e.tags[0] != "revisit" {
		t.Errorf("restored tags = %v, want [revisit]", e.tags)
	}

	// The walk must trust the restored (mtime, size): no re-read, no dirty.
	notes, _, err := v2.ScanNotes(false)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, n := range notes {
		if n.Path == "a.md" {
			found = true
			if len(n.Tags) != 1 || n.Tags[0] != "revisit" {
				t.Errorf("listing tags = %v, want [revisit] served from the index", n.Tags)
			}
		}
	}
	if !found {
		t.Fatal("restored listing is missing a.md")
	}
	v2.idx.mu.RLock()
	reRead := v2.idx.entries["a.md"].hasContent
	v2.idx.mu.RUnlock()
	if reRead {
		t.Error("scan re-read a note the restored index already covers")
	}
	if v2.idx.dirty.Load() {
		t.Error("a scan over unchanged files must not mark the index dirty")
	}

	// Backlinks are served from the restored links without touching the file.
	backlinks := v2.GetBacklinks("b.md")
	if len(backlinks) == 0 {
		t.Fatal("backlinks empty; the restored links were not used")
	}
	if backlinks[0].Path != "a.md" {
		t.Errorf("backlink source = %q, want a.md", backlinks[0].Path)
	}
}

func TestIndexPersistenceReconcilesExternalChanges(t *testing.T) {
	dir := t.TempDir()
	indexPath := filepath.Join(t.TempDir(), ".basalt-index.gob")

	for path, content := range map[string]string{
		"source.md":     "---\ntags: [old]\n---\n[[old-target]]\n",
		"old-target.md": "old target\n",
		"removed.md":    "remove me\n",
	} {
		if err := os.WriteFile(filepath.Join(dir, path), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}

	v1 := New(dir)
	if err := v1.StartIndexPersistence(indexPath); err != nil {
		t.Fatal(err)
	}
	if _, _, err := v1.ScanNotes(false); err != nil {
		t.Fatal(err)
	}
	if err := v1.SaveIndexNow(); err != nil {
		t.Fatal(err)
	}
	v1.Close()

	updatedSource := "---\ntags: [fresh]\n---\n[[new-target]]\n"
	if err := os.WriteFile(filepath.Join(dir, "source.md"), []byte(updatedSource), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "old-target.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "removed.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "new-target.md"), []byte("new target\n"), 0644); err != nil {
		t.Fatal(err)
	}

	v2 := New(dir)
	if err := v2.StartIndexPersistence(indexPath); err != nil {
		t.Fatalf("loading previous index: %v", err)
	}
	t.Cleanup(v2.Close)

	notes, _, err := v2.ScanNotes(false)
	if err != nil {
		t.Fatal(err)
	}
	paths := notePaths(notes)
	for _, path := range []string{"source.md", "new-target.md"} {
		if !hasPath(paths, path) {
			t.Errorf("listing = %v, missing %q", paths, path)
		}
	}
	for _, path := range []string{"old-target.md", "removed.md"} {
		if hasPath(paths, path) {
			t.Errorf("listing still contains removed path %q: %v", path, paths)
		}
	}
	for _, note := range notes {
		if note.Path == "source.md" && (len(note.Tags) != 1 || note.Tags[0] != "fresh") {
			t.Errorf("source tags = %v, want [fresh]", note.Tags)
		}
	}

	if got := v2.GetBacklinks("new-target.md"); len(got) != 1 || got[0].Path != "source.md" {
		t.Errorf("new-target backlinks = %+v, want source.md", got)
	}
	if got := v2.GetBacklinks("old-target.md"); len(got) != 0 {
		t.Errorf("old-target backlinks = %+v, want none", got)
	}

	if err := v2.SaveIndexNow(); err != nil {
		t.Fatal(err)
	}
	persisted := readIndexFile(t, indexPath)
	persistedPaths := make(map[string]struct{}, len(persisted.Entries))
	for _, entry := range persisted.Entries {
		persistedPaths[entry.Rel] = struct{}{}
	}
	for _, path := range []string{"source.md", "new-target.md"} {
		if _, ok := persistedPaths[path]; !ok {
			t.Errorf("persisted index is missing %q: %v", path, persistedPaths)
		}
	}
	for _, path := range []string{"old-target.md", "removed.md"} {
		if _, ok := persistedPaths[path]; ok {
			t.Errorf("persisted index still contains %q: %v", path, persistedPaths)
		}
	}
}

// TestIndexPersistenceFlushesOnlyWhenDirty pins the write policy: a clean
// index writes nothing, a mutated one writes on demand, and the file carries
// version + absolute vault path for validation on load.
func TestIndexPersistenceFlushesOnlyWhenDirty(t *testing.T) {
	dir := t.TempDir()
	indexPath := filepath.Join(t.TempDir(), ".basalt-index.gob")

	v := New(dir)
	if err := v.StartIndexPersistence(indexPath); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(v.Close)

	// Clean index: flush is a no-op and no file appears.
	if err := v.SaveIndexNow(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(indexPath); !os.IsNotExist(err) {
		t.Fatalf("flush wrote %s while the index was clean", indexPath)
	}

	// One external note, one walk: now the flush persists it.
	if err := os.WriteFile(filepath.Join(dir, "n.md"), []byte("body\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := v.ScanNotes(false); err != nil {
		t.Fatal(err)
	}
	if !v.idx.dirty.Load() {
		t.Fatal("scan should mark the index dirty")
	}
	if err := v.SaveIndexNow(); err != nil {
		t.Fatal(err)
	}
	if v.idx.dirty.Load() {
		t.Error("dirty flag should clear after a successful save")
	}

	f := readIndexFile(t, indexPath)
	if f.FileVersion != indexFileVersion {
		t.Errorf("FileVersion = %d, want %d", f.FileVersion, indexFileVersion)
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	if f.Vault != abs {
		t.Errorf("Vault = %q, want %q", f.Vault, abs)
	}
	if len(f.Entries) != 1 || f.Entries[0].Rel != "n.md" {
		t.Errorf("Entries = %+v, want a single n.md", f.Entries)
	}

	// Clean again: a second flush rewrites nothing (byte-identical file).
	before, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := v.SaveIndexNow(); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Error("flush rewrote the file although the index was clean")
	}
}

// TestIndexPersistenceDiscardsCorruptFile checks the safety valve: an
// undecodable or wrong-version file reports an error, is never deleted, and
// the vault keeps working straight from the .md files.
func TestIndexPersistenceDiscardsCorruptFile(t *testing.T) {
	cases := map[string][]byte{
		"corrupt": []byte("definitely not a gob document"),
	}
	// Wrong-but-valid version, encoded as a real gob.
	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(indexFile{
		FileVersion: indexFileVersion + 1,
		Entries:     []persistedEntry{{Rel: "stale.md"}},
	}); err != nil {
		t.Fatal(err)
	}
	cases["future-version"] = buf.Bytes()

	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			indexPath := filepath.Join(t.TempDir(), ".basalt-index.gob")
			if err := os.WriteFile(indexPath, payload, 0644); err != nil {
				t.Fatal(err)
			}

			v := New(dir)
			if err := v.StartIndexPersistence(indexPath); err == nil {
				t.Fatal("loading the bad index file should report an error")
			}
			// The load itself never removes the file...
			if _, err := os.Stat(indexPath); err != nil {
				t.Fatalf("load removed the index file: %v", err)
			}
			// ...and nothing from it leaked into the index.
			v.idx.mu.RLock()
			n := len(v.idx.entries)
			v.idx.mu.RUnlock()
			if n != 0 {
				t.Errorf("index has %d entries after a failed load, want 0", n)
			}

			// The vault still rebuilds from the .md files.
			if err := os.WriteFile(filepath.Join(dir, "fresh.md"), []byte("fresh\n"), 0644); err != nil {
				t.Fatal(err)
			}
			notes, _, err := v.ScanNotes(false)
			if err != nil {
				t.Fatal(err)
			}
			if !hasPath(notePaths(notes), "fresh.md") {
				t.Errorf("listing = %v, want fresh.md", notePaths(notes))
			}
			v.Close()
		})
	}
}

// TestIndexPersistenceRejectsForeignVault: the gob records the absolute vault
// it belongs to; loading it into another vault reports the mismatch and
// restores nothing (the caller then rebuilds from that vault's own notes).
func TestIndexPersistenceRejectsForeignVault(t *testing.T) {
	dirA, dirB := t.TempDir(), t.TempDir()
	indexPath := filepath.Join(t.TempDir(), ".basalt-index.gob")

	if err := os.WriteFile(filepath.Join(dirA, "only-in-a.md"), []byte("a\n"), 0644); err != nil {
		t.Fatal(err)
	}
	vA := New(dirA)
	if err := vA.StartIndexPersistence(indexPath); err != nil {
		t.Fatal(err)
	}
	if _, _, err := vA.ScanNotes(false); err != nil {
		t.Fatal(err)
	}
	if err := vA.SaveIndexNow(); err != nil {
		t.Fatal(err)
	}
	vA.Close()

	if err := os.WriteFile(filepath.Join(dirB, "only-in-b.md"), []byte("b\n"), 0644); err != nil {
		t.Fatal(err)
	}
	vB := New(dirB)
	err := vB.StartIndexPersistence(indexPath)
	if err == nil {
		t.Fatal("loading another vault's index should report an error")
	}
	if !strings.Contains(err.Error(), "another vault") {
		t.Errorf("error = %q, want it to mention another vault", err)
	}
	vB.idx.mu.RLock()
	_, leaked := vB.idx.entries["only-in-a.md"]
	restored := len(vB.idx.entries)
	vB.idx.mu.RUnlock()
	if leaked || restored != 0 {
		t.Errorf("foreign index leaked %d entries into this vault", restored)
	}

	// Vault B keeps working and eventually rewrites the file for itself.
	notes, _, err := vB.ScanNotes(false)
	if err != nil {
		t.Fatal(err)
	}
	if !hasPath(notePaths(notes), "only-in-b.md") {
		t.Errorf("listing = %v, want only-in-b.md", notePaths(notes))
	}
	if err := vB.SaveIndexNow(); err != nil {
		t.Fatal(err)
	}
	if f := readIndexFile(t, indexPath); len(f.Entries) != 1 || f.Entries[0].Rel != "only-in-b.md" {
		t.Errorf("file after re-save = %+v, want only only-in-b.md", f.Entries)
	}
	vB.Close()
}
