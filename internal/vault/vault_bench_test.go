package vault

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var benchmarkSearchMatches int

func benchmarkVault(b *testing.B, noteCount int) (*Vault, string) {
	b.Helper()
	dir := b.TempDir()
	body := "Markdown content for measuring vault scans, indexing, and full-text search. "
	for i := 0; i < noteCount; i++ {
		folder := filepath.Join(dir, fmt.Sprintf("folder-%02d", i%10))
		if err := os.MkdirAll(folder, 0755); err != nil {
			b.Fatal(err)
		}

		content := fmt.Sprintf(
			"---\ntags: [benchmark, group-%02d]\n---\n# Note %05d\n\n%s\nSee [[Note %05d]].\n",
			i%20, i, body, (i+1)%noteCount,
		)
		if i%100 == 0 {
			content += "\nThe rare benchmark phrase appears here.\n"
		}
		path := filepath.Join(folder, fmt.Sprintf("note-%05d.md", i))
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			b.Fatal(err)
		}
	}
	return New(dir), "rare benchmark phrase"
}

func benchmarkSearch(v *Vault, notes []NoteRecord, query string) (int, error) {
	matches := 0
	for _, note := range notes {
		folded, err := v.FoldedContentForRecord(note)
		if err != nil {
			return 0, err
		}
		if strings.Contains(folded, query) {
			matches++
		}
	}
	return matches, nil
}

func BenchmarkVaultScanNotes(b *testing.B) {
	for _, noteCount := range []int{100, 1000, 10000} {
		b.Run(fmt.Sprintf("notes-%d", noteCount), func(b *testing.B) {
			b.Run("warm-snapshot", func(b *testing.B) {
				v, _ := benchmarkVault(b, noteCount)
				if _, _, err := v.ScanNotes(false); err != nil {
					b.Fatal(err)
				}
				b.ReportAllocs()
				b.ReportMetric(float64(noteCount), "notes/op")
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					notes, _, err := v.ScanNotes(false)
					if err != nil {
						b.Fatal(err)
					}
					if len(notes) != noteCount {
						b.Fatalf("ScanNotes returned %d notes, want %d", len(notes), noteCount)
					}
				}
			})

			b.Run("filesystem-rescan", func(b *testing.B) {
				v, _ := benchmarkVault(b, noteCount)
				if _, _, err := v.ScanNotes(false); err != nil {
					b.Fatal(err)
				}
				b.ReportAllocs()
				b.ReportMetric(float64(noteCount), "notes/op")
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					v.scanCache.invalidate()
					notes, _, err := v.ScanNotes(false)
					if err != nil {
						b.Fatal(err)
					}
					if len(notes) != noteCount {
						b.Fatalf("ScanNotes returned %d notes, want %d", len(notes), noteCount)
					}
				}
			})

			b.Run("cold-index-scan", func(b *testing.B) {
				v, _ := benchmarkVault(b, noteCount)
				b.ReportAllocs()
				b.ReportMetric(float64(noteCount), "notes/op")
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					if i > 0 {
						b.StopTimer()
						v.idx = newIndex()
						v.scanCache.invalidate()
						b.StartTimer()
					}
					notes, _, err := v.ScanNotes(false)
					if err != nil {
						b.Fatal(err)
					}
					if len(notes) != noteCount {
						b.Fatalf("ScanNotes returned %d notes, want %d", len(notes), noteCount)
					}
				}
			})
		})
	}
}

func BenchmarkVaultSearchFoldedContent(b *testing.B) {
	for _, noteCount := range []int{100, 1000, 10000} {
		b.Run(fmt.Sprintf("notes-%d", noteCount), func(b *testing.B) {
			b.Run("warm-cache", func(b *testing.B) {
				v, query := benchmarkVault(b, noteCount)
				notes, _, err := v.ScanNotes(false)
				if err != nil {
					b.Fatal(err)
				}
				if _, err := benchmarkSearch(v, notes, query); err != nil {
					b.Fatal(err)
				}
				b.ReportAllocs()
				b.ReportMetric(float64(noteCount), "notes/op")
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					matches, err := benchmarkSearch(v, notes, query)
					if err != nil {
						b.Fatal(err)
					}
					benchmarkSearchMatches = matches
				}
			})

			b.Run("cold-index-and-fold-cache", func(b *testing.B) {
				v, query := benchmarkVault(b, noteCount)
				b.ReportAllocs()
				b.ReportMetric(float64(noteCount), "notes/op")
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					if i > 0 {
						b.StopTimer()
						v.idx = newIndex()
						v.scanCache.invalidate()
						b.StartTimer()
					}
					notes, _, err := v.ScanNotes(false)
					if err != nil {
						b.Fatal(err)
					}
					matches, err := benchmarkSearch(v, notes, query)
					if err != nil {
						b.Fatal(err)
					}
					benchmarkSearchMatches = matches
				}
			})
		})
	}
}
