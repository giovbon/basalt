// Folder creation, rename, delete, and bulk-delete flows.

import { ErrorHandler, encodeVaultPath, FilenameValidator } from '../core/utils.js';
import * as api from '../core/api.js';

export function createFolders() {
    return {
        async _finalizeCreateFolder(folderPath, targetFolder) {
            this._optimisticAddFolder(folderPath);
            if (targetFolder) this.expandedFolders.add(targetFolder);
            this.expandedFolders.add(folderPath);
            this._rebuildTreeAfterMutation();

            try {
                await api.sendJSON('/api/folders', 'POST', { path: folderPath });
                this.goToHomepageFolder(folderPath);
                return true;
            } catch (error) {
                ErrorHandler.handle('create folder', error);
                await this.loadNotes({ silent: true });
                return false;
            }
        },

        async createFolder(parentPath = null) {
            const explicitTarget = parentPath !== null && parentPath !== undefined ? parentPath : undefined;
            this.openCreateNameModal('folder', explicitTarget);
        },

        renameFolder(folderPath, currentName) {
            this.renameFolderPath = folderPath;
            this.renameFolderOldName = currentName;
            this.renameFolderInput = currentName;
            this.showRenameFolderModal = true;
            this.mobileSidebarOpen = false;
            this.$nextTick(() => {
                const el = document.getElementById('rename-folder-modal-input');
                if (el) {
                    el.focus();
                    el.select();
                }
            });
        },

        closeRenameFolderModal() {
            this.showRenameFolderModal = false;
            this.renameFolderPath = '';
            this.renameFolderOldName = '';
            this.renameFolderInput = '';
        },

        cancelRenameFolderModal() {
            this.closeRenameFolderModal();
        },

        async submitRenameFolderModal() {
            const folderPath = this.renameFolderPath;
            const currentName = this.renameFolderOldName;
            const newName = (this.renameFolderInput || '').trim();
            if (!newName || newName === currentName) {
                this.closeRenameFolderModal();
                return;
            }

            const validation = FilenameValidator.validateFilename(newName);
            if (!validation.valid) {
                this.toast(this.getValidationErrorMessage(validation, 'folder'), { type: 'warning' });
                return;
            }

            const validatedName = validation.sanitized;
            const pathParts = folderPath.split('/');
            pathParts[pathParts.length - 1] = validatedName;
            const newPath = pathParts.join('/');
            if (newPath !== folderPath && this.folderPathTaken(newPath)) {
                this.toast(this.t('folders.already_exists', { name: validatedName }), { type: 'warning' });
                return;
            }

            const ok = await this._finalizeRenameFolder(folderPath, newPath);
            if (ok) this.closeRenameFolderModal();
        },

        async _finalizeRenameFolder(folderPath, newPath) {
            const folderPrefix = folderPath + '/';
            const newFolderPrefix = newPath + '/';

            this._optimisticRenameFolderTree(folderPath, newPath);
            this._rebuildTreeAfterMutation();

            if (this.expandedFolders.has(folderPath)) {
                this.expandedFolders.delete(folderPath);
                this.expandedFolders.add(newPath);
            }
            const newFavorites = this.favorites.map(f =>
                f.startsWith(folderPrefix) ? newFolderPrefix + f.substring(folderPrefix.length) : f
            );
            if (JSON.stringify(newFavorites) !== JSON.stringify(this.favorites)) {
                this.favorites = newFavorites;
                this.favoritesSet = new Set(newFavorites);
                this.saveFavorites();
            }
            if (this.currentNote && this.currentNote.startsWith(folderPrefix)) {
                this.currentNote = newFolderPrefix + this.currentNote.substring(folderPrefix.length);
            }

            try {
                await api.sendJSON('/api/folders/rename', 'POST', { oldPath: folderPath, newPath });
                return true;
            } catch (error) {
                ErrorHandler.handle('rename folder', error);
                await this.loadNotes({ silent: true });
                return false;
            }
        },

        async deleteFolder(folderPath, folderName) {
            const ok = await this.confirmModalAsk({
                message: this.t('folders.confirm_delete', { name: folderName }),
            });
            if (!ok) return;

            const folderPrefix = folderPath + '/';

            this._optimisticRemoveFolderTree(folderPath);
            this._rebuildTreeAfterMutation();

            this.expandedFolders.delete(folderPath);
            const newFavorites = this.favorites.filter(f => !f.startsWith(folderPrefix));
            if (newFavorites.length !== this.favorites.length) {
                this.favorites = newFavorites;
                this.favoritesSet = new Set(newFavorites);
                this.saveFavorites();
            }
            if (this.currentNote && this.currentNote.startsWith(folderPrefix)) {
                this._resetNoteState();
            }

            try {
                await api.send(`/api/folders/${encodeVaultPath(folderPath)}`, 'DELETE');
                this.loadTagsDebounced();
            } catch (error) {
                ErrorHandler.handle('delete folder', error);
                await this.loadNotes({ silent: true });
            }
        },

        async deleteSelectedTreeItems() {
            if (this.deletingSelectedTreeItems || this.selectedTreeItems.length === 0) return;

            const selectedItems = [...this.selectedTreeItems];
            const items = selectedItems.filter(item => !selectedItems.some(folder =>
                folder.type === 'folder' && folder.path !== item.path
                && item.path.startsWith(folder.path + '/')
            ));
            const ok = await this.confirmModalAsk({
                message: this.t('sidebar.confirm_delete_selected', { count: items.length }),
            });
            if (!ok) return;

            this.deletingSelectedTreeItems = true;
            const deletedItems = [];
            const failedItems = [];
            for (const item of items) {
                try {
                    const endpoint = item.type === 'folder' ? '/api/folders/' : '/api/notes/';
                    await api.send(`${endpoint}${encodeVaultPath(item.path)}`, 'DELETE');
                    deletedItems.push(item);
                } catch (error) {
                    failedItems.push({ ...item, error });
                }
            }

            const deletedFolders = deletedItems.filter(item => item.type === 'folder');
            const deletedFiles = deletedItems.filter(item => item.type !== 'folder');
            for (const item of deletedFolders) {
                this._optimisticRemoveFolderTree(item.path);
                const prefix = item.path + '/';
                this.expandedFolders.forEach(path => {
                    if (path === item.path || path.startsWith(prefix)) this.expandedFolders.delete(path);
                });
            }
            for (const item of deletedFiles) {
                this._optimisticRemoveNote(item.path);
            }

            if (deletedItems.length > 0) {
                const isDeletedPath = path => deletedFiles.some(item => item.path === path)
                    || deletedFolders.some(item => path.startsWith(item.path + '/'));
                const favorites = this.favorites.filter(path => !isDeletedPath(path));
                if (favorites.length !== this.favorites.length) {
                    this.favorites = favorites;
                    this.favoritesSet = new Set(favorites);
                    this.saveFavorites();
                }

                if (this.currentNote && isDeletedPath(this.currentNote)) {
                    this._resetNoteState();
                    window.history.replaceState({ homepageFolder: this.selectedHomepageFolder || '' }, '', '/');
                } else if (this.currentMedia && isDeletedPath(this.currentMedia)) {
                    this.closeMediaViewer();
                    window.history.replaceState({ homepageFolder: this.selectedHomepageFolder || '' }, '', '/');
                }

                this._rebuildTreeAfterMutation();
                await this.loadNotes({ silent: true });
            }

            this.selectedTreeItems = failedItems.map(({ path, type }) => ({ path, type }));
            this.treeSelectionAnchor = failedItems.length > 0 ? this.treeSelectionAnchor : null;
            this.treeSelectionMode = failedItems.length > 0;
            if (failedItems.length > 0) {
                const detail = failedItems[0].error.detail || failedItems[0].error.message;
                this.toast(this.t('sidebar.bulk_delete_partial', {
                    count: failedItems.length,
                    error: detail,
                }), { type: 'error' });
            }
            this.deletingSelectedTreeItems = false;
        },
    };
}
