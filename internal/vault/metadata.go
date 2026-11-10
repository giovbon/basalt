package vault

import (
	"bufio"
	"bytes"
	"io"
	"os"
)

func (v *Vault) CreateNoteMetadata(notePath string) NoteMetadata {
	fullPath := v.FullPath(notePath)
	if !v.ValidatePathSecurity(fullPath) {
		return NoteMetadata{}
	}

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

// metadataLineLimit caps Scanner's line allocation before countLines falls
// back to counting newline bytes.
const metadataLineLimit = 1 << 20

// countLines includes a final unterminated line and safely handles lines
// longer than Scanner's configured maximum.
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
