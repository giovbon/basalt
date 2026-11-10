package vault

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

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

	// Guard every spelling that cleans to the vault root before RemoveAll.
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
