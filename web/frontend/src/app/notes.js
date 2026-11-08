// Note/folder CRUD plus the create/rename dialogs.
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import { CONFIG, LOCAL_SETTINGS } from '../core/config.js';
import { ErrorHandler, encodeVaultPath, FilenameValidator } from '../core/utils.js';
import * as api from '../core/api.js';
import { buildFolderTree, noteComparator, folderComparator } from '../lib/folder-tree.js';
import { createSaveController } from '../lib/save-controller.js';

export function createNotes() {
    return {
        
        // ==================== END INTERNATIONALIZATION ====================
        
        // Load all notes. Pass {silent: true} from error-recovery paths so the
        // 800ms loading overlay never appears on background re-syncs.
        async loadNotes({ silent = false } = {}) {
            this.notesLoading = true;
            clearTimeout(this._notesLoadingOverlayTimer);
            if (!silent) {
                this._notesLoadingOverlayTimer = setTimeout(() => {
                    if (this.notesLoading && this.notes.length === 0 && this.allFolders.length === 0) {
                        this.notesLoadingShowOverlay = true;
                    }
                }, 800);
            }
            try {
                const data = await api.getJSON('/api/notes');
                this.notes = data.notes;
                this.allFolders = data.folders || [];
                this.buildNoteLookupMaps();
                this.buildFolderTree();
                await this.loadTags();
            } catch (error) {
                ErrorHandler.handle('load notes', error);
            } finally {
                clearTimeout(this._notesLoadingOverlayTimer);
                this.notesLoading = false;
                this.notesLoadingShowOverlay = false;
            }
        },
        
        
        // Clear every piece of state derived from the open note. Used when the
        // note disappears (404 from the API or a local delete) so the outline,
        // backlinks and undo history do not keep showing the previous document.
        _resetNoteState() {
            this.currentNote = '';
            this.noteContent = '';
            this.noteBaseHash = null;
            this.currentNoteName = '';
            this.outline = [];
            this.backlinks = [];
            this.noteMetadata = null;
            this.undoHistory = [];
            this.redoHistory = [];
            this.isUndoRedo = false;
            this.hasPendingHistoryChanges = false;
            this.lastSaved = false;
            this._lastRenderedContent = '';
            this._lastRenderedNote = '';
            this._cachedRenderedHTML = '';
            this._initializedVideoSources = new Set();
            this.closeMediaViewer();
            document.title = this.appName;
        },

        // Load a specific note. targetLine/targetColumn are the 1-based position
        // of the occurrence to focus when the note was opened from a search
        // result (a line can hold more than one occurrence of the term).
        async loadNote(notePath, updateHistory = true, searchQuery = '', targetLine = null, targetColumn = null) {
            try {
                // Close mobile sidebar when a note is selected
                this.mobileSidebarOpen = false;

                // include_backlinks=true: the backend only computes backlinks when
                // this flag is present (they require a full vault scan, so they're
                // opt-in per request). Without it the panel always shows empty.
                // 404 means "removed elsewhere" and redirects home, so keep the status.
                const response = await api.raw(`/api/notes/${encodeVaultPath(notePath)}?include_backlinks=true`);
                
                // Check if note exists
                if (!response.ok) {
                    if (response.status === 404) {
                        // Note not found - silently redirect to home
                        window.history.replaceState({ homepageFolder: this.selectedHomepageFolder || '' }, '', '/');
                        this._resetNoteState();
                        return;
                    }
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                const data = await response.json();

                this.currentNote = notePath;
                this._lastRenderedContent = ''; // Clear render cache for new note
                this._lastRenderedNote = '';
                this._cachedRenderedHTML = '';
                this._initializedVideoSources = new Set(); // Clear video cache for new note
                this.noteContent = data.content;
                this.noteBaseHash = data.hash || null;
                // Note: scroll restoration happens later in the post-$nextTick block below
                // (where the existing scrollToTop call used to live), via _restoreNoteScroll().
                // Doing it there means a single, unified restore path instead of two racing
                // ones. See the post-$nextTick block for the full timing rationale.
                this.currentNoteName = notePath.split('/').pop().replace('.md', '');
                this.closeMediaViewer(); // Clear image viewer when loading a note
                
                // Update browser tab title
                document.title = `${this.currentNoteName} - ${this.appName}`;
                this.lastSaved = false;
                
                // Outline and frontmatter parsed server-side
                this.outline = data.outline || [];

                // Store backlinks from API response
                this.backlinks = data.backlinks || [];

                // Initialize undo/redo history for this note (with cursor at start)
                this.undoHistory = [{ content: data.content, cursorPos: 0 }];
                this.redoHistory = [];
                this.hasPendingHistoryChanges = false;
                
                // Update browser URL and history
                if (updateHistory) {
                    // Encode the path properly (spaces become %20, etc.)
                    const pathWithoutExtension = notePath.replace('.md', '');
                    // Encode each path segment to handle special characters
                    const encodedPath = encodeVaultPath(pathWithoutExtension);
                    const params = new URLSearchParams();
                    if (searchQuery) {
                        params.set('search', searchQuery);
                    }
                    if (targetLine) {
                        params.set('line', String(targetLine));
                    }
                    if (targetColumn) {
                        params.set('col', String(targetColumn));
                    }
                    const queryString = params.toString();
                    const url = `/${encodedPath}${queryString ? `?${queryString}` : ''}`;
                    window.history.pushState(
                        { 
                            notePath: notePath, 
                            searchQuery: searchQuery,
                            targetLine: targetLine,
                            targetColumn: targetColumn,
                            homepageFolder: this.selectedHomepageFolder || '' // Save current folder state
                        },
                        '',
                        url
                    );
                }
                
                // Frontmatter parsed server-side
                this.noteMetadata = data.frontmatter || null;
                
                // Store search query for highlighting
                if (searchQuery) {
                    this.currentSearchHighlight = searchQuery;
                } else {
                    // Clear highlights if no search query
                    this.currentSearchHighlight = '';
                }
                
                // Expand folder tree to show the loaded note
                this.expandFolderForNote(notePath);
                
                // Use $nextTick twice to ensure Alpine.js has time to:
                // 1. First tick: expand folders and update DOM
                // 2. Second tick: highlight the note and setup everything else
                this.$nextTick(() => {
                    this.$nextTick(() => {
                        this.refreshDOMCache();
                        this.setupScrollSync();

                        // When the note was opened from a search result, the
                        // target line/match wins over the last scroll position.
                        // Otherwise the delayed restore below would drag the
                        // viewport back to wherever the user stopped reading.
                        const focusSearchTarget = !!(searchQuery || (targetLine && targetLine > 0));
                        if (!focusSearchTarget) {
                            // First pass: editor is ready (textarea reflows synchronously). Preview
                            // may still have scrollHeight=0 because the markdown render pipeline
                            // (marked + MathJax + Mermaid + syntax highlighting) is async.
                            this._restoreNoteScroll();
                            // Second pass on a later frame: by now the preview pane has typically
                            // rendered and laid out, so its scrollTop write actually sticks. The
                            // helper is idempotent — re-running for the editor is a no-op.
                            requestAnimationFrame(() => {
                                requestAnimationFrame(() => {
                                    this._restoreNoteScroll();
                                });
                            });
                        }

                        // Apply or clear search highlighting
                        if (searchQuery) {
                            // Pass true to focus editor when loading from search result
                            this.highlightSearchTerm(searchQuery, true, targetLine, targetColumn);
                        } else if (targetLine) {
                            this.scrollEditorToLine(targetLine);
                            this.scrollPreviewToSourceLine(targetLine);
                            this.clearSearchHighlights();
                        } else {
                            this.clearSearchHighlights();
                        }
                        
                        // Scroll note into view in sidebar if needed
                        this.scrollNoteIntoView(notePath);
                        
                        // Render syntax highlighting overlay (if enabled)
                        this.updateSyntaxHighlight();
                        
                        // Render markdown preview
                        this.renderPreview();
                    });
                });
                
            } catch (error) {
                ErrorHandler.handle('load note', error);
            }
        },
        
        async createNote(folderPath = null, directPath = null) {
            if (directPath) {
                const notePath = directPath.endsWith('.md') ? directPath : `${directPath}.md`;
                if (this.notePathTaken(notePath)) {
                    this.toast(this.t('notes.already_exists', { name: notePath }), { type: 'warning' });
                    return;
                }
                await this._finalizeCreateNote(notePath);
                return;
            }
            const explicitTarget = folderPath !== null && folderPath !== undefined ? folderPath : undefined;
            this.openCreateNameModal('note', explicitTarget);
        },
        
        /**
         * @param {'note'|'folder'} kind
         * @param {string|undefined} explicitTargetFolder - if set, use as parent folder context ("" = root)
         */
        openCreateNameModal(kind, explicitTargetFolder = undefined) {
            const targetFolder =
                explicitTargetFolder !== undefined ? explicitTargetFolder : this.inferredNewItemTargetFolder();
            this.closeDropdown();
            this.mobileSidebarOpen = false;
            this.createNameModalKind = kind;
            this.createNameModalTargetFolder = targetFolder;
            this.createNameModalInput =
                (kind === 'note' && this.autoFillNoteTitle) ? this._autoTitleTimestamp() : '';
            this.showCreateNameModal = true;
            this.$nextTick(() => {
                const el = document.getElementById('create-name-modal-input');
                if (el) {
                    el.focus();
                    el.select();
                }
            });
        },
        
        // Zettelkasten-style yyyymmddHHMMSS in local time.
        _autoTitleTimestamp() {
            const d = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
                   `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
        },
        
        closeCreateNameModal() {
            this.showCreateNameModal = false;
            this.createNameModalInput = '';
        },
        
        cancelCreateNameModal() {
            this.closeCreateNameModal();
        },
        
        createNameModalHelpText() {
            const tf = this.createNameModalTargetFolder;
            if (this.createNameModalKind === 'note') {
                return tf
                    ? this.t('notes.prompt_name_in_folder', { folder: tf })
                    : this.t('notes.prompt_name_with_path');
            }
            return tf
                ? this.t('folders.prompt_name_in_folder', { folder: tf })
                : this.t('folders.prompt_name_with_path');
        },
        
        createNameModalTitle() {
            return this.createNameModalKind === 'note'
                ? this.t('sidebar.new_note')
                : this.t('sidebar.new_folder');
        },
        
        createNameModalLabel() {
            return this.createNameModalKind === 'note'
                ? this.t('notes.prompt_name')
                : this.t('folders.prompt_name');
        },
        
        async submitCreateNameModal() {
            const rawName = (this.createNameModalInput || '').trim();
            if (!rawName) {
                this.closeCreateNameModal();
                return;
            }
            const targetFolder = this.createNameModalTargetFolder;
            const kind = this.createNameModalKind;
            
            if (kind === 'note') {
                const validation = targetFolder
                    ? FilenameValidator.validateFilename(rawName)
                    : FilenameValidator.validatePath(rawName);
                if (!validation.valid) {
                    this.toast(this.getValidationErrorMessage(validation, 'note'), { type: 'warning' });
                    return;
                }
                const validatedName = validation.sanitized;
                const notePath = targetFolder
                    ? `${targetFolder}/${validatedName}.md`
                    : (validatedName.endsWith('.md') ? validatedName : `${validatedName}.md`);
                if (this.notePathTaken(notePath)) {
                    this.toast(this.t('notes.already_exists', { name: notePath }), { type: 'warning' });
                    return;
                }
                const ok = await this._finalizeCreateNote(notePath);
                if (ok) this.closeCreateNameModal();
                return;
            }
            
            const validation = targetFolder
                ? FilenameValidator.validateFilename(rawName)
                : FilenameValidator.validatePath(rawName);
            if (!validation.valid) {
                this.toast(this.getValidationErrorMessage(validation, 'folder'), { type: 'warning' });
                return;
            }
            const validatedName = validation.sanitized;
            const folderPath = targetFolder ? `${targetFolder}/${validatedName}` : validatedName;
            const existingFolder = this.allFolders.find(folder => folder.toLowerCase() === folderPath.toLowerCase());
            if (existingFolder) {
                this.toast(this.t('folders.already_exists', { name: validatedName }), { type: 'warning' });
                return;
            }
            const ok = await this._finalizeCreateFolder(folderPath, targetFolder);
            if (ok) this.closeCreateNameModal();
        },
        
        async _finalizeCreateNote(notePath) {
            // Optimistic add — sidebar reflects the new note instantly. Server
            // confirms; on failure we resync silently.
            this._optimisticAddNote(notePath, { content: '' });
            const folderPart = notePath.includes('/') ? notePath.substring(0, notePath.lastIndexOf('/')) : '';
            if (folderPart) this.expandedFolders.add(folderPart);
            this._rebuildTreeAfterMutation();
            
            try {
                await api.sendJSON(`/api/notes/${encodeVaultPath(notePath)}`, 'POST', { content: '' });
                await this.loadNote(notePath);
                this.focusEditorForNewNote();
                return true;
            } catch (error) {
                ErrorHandler.handle('create note', error);
                await this.loadNotes({ silent: true });
                return false;
            }
        },
        
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
            
            // Optimistic cascade: rewrite folder + every nested folder + every
            // note path. Sidebar reflects the rename instantly.
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
        
        // Delete folder (cascade: every nested folder + note)
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
        
        // Auto-save with debounce
        autoSave() {
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
            }
            
            this.lastSaved = false;
            
            // Push to undo history (but not during undo/redo operations)
            if (!this.isUndoRedo) {
                this.pushToHistory();
            }
            
            // Outline and metadata panels refresh from the save response
            // (server-side parsing), see saveNote().
            
            this.saveTimeout = setTimeout(() => {
                // Commit to undo history when autosave triggers (same debounce timing)
                if (this.hasPendingHistoryChanges) {
                    this.commitToHistory();
                }
                this.saveNote();
            }, this.autosaveDelayMs);
        },
        
        // Save current note. Queueing and the 409 "changed elsewhere" flow live
        // in lib/save-controller.js so they can be tested without Alpine.
        async saveNote() {
            if (!this.currentNote) return;
            await this._getSaveController().request();
        },

        _getSaveController() {
            if (!this._saveControllerInstance) {
                this._saveControllerInstance = createSaveController({
                    // capture() runs at send time, so a queued save always
                    // writes the latest buffer instead of a stale snapshot.
                    capture: () => {
                        if (!this.currentNote) return null;
                        return {
                            notePath: this.currentNote,
                            content: this.noteContent,
                            baseHash: this.noteBaseHash,
                        };
                    },
                    isCurrent: (notePath) => notePath === this.currentNote,
                    send: (payload) => this._sendNoteSave(payload),
                    askConflict: (notePath) => this._askSaveConflict(notePath),
                    reload: (notePath) => this._reloadAfterSaveConflict(notePath),
                    onSaved: (payload, result) => this._handleSaveSuccess(payload, result),
                    onUnsaved: (notePath) => {
                        const name = notePath.split('/').pop().replace('.md', '');
                        this.toast(this.t('notes.save_conflict_unsaved', { name }), { type: 'warning' });
                    },
                    onError: (error) => ErrorHandler.handle('save note', error),
                    onBusyChange: (busy) => { this.isSaving = busy; },
                });
            }
            return this._saveControllerInstance;
        },

        async _sendNoteSave({ notePath, content, baseHash }) {
            // 409 is part of the protocol, so it is parsed rather than thrown.
            const response = await api.raw(`/api/notes/${encodeVaultPath(notePath)}`, {
                method: 'POST',
                json: { content, base_hash: baseHash }
            });
            const body = (response.ok || response.status === 409) ? await response.json() : {};
            return { ok: response.ok, status: response.status, ...body };
        },

        async _reloadAfterSaveConflict(notePath) {
            // Drop the pending autosave: reloading replaces the editor buffer.
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = null;
            }
            await this.loadNote(notePath, false);
        },

        _handleSaveSuccess({ notePath, content }, result) {
            // A hover preview for this note would otherwise show the version
            // from before this save for up to its cache TTL.
            if (this._linkPreviewCache) this._linkPreviewCache.delete(notePath);

            if (notePath === this.currentNote) {
                this.noteBaseHash = result.hash || null;
                // Refresh TOC and metadata panels from the server-parsed response.
                this.outline = result.outline || [];
                this.noteMetadata = result.frontmatter || null;
            }
            this.lastSaved = true;

            // Update only the modified timestamp for the saved note (no full reload).
            const note = this.notes.find(n => n.path === notePath);
            if (note) {
                note.modified = new Date().toISOString();
                note.size = new Blob([content]).size;
                note.tags = result.tags || [];
            }

            // Reload tags to update sidebar counts (debounced to prevent spam).
            this.loadTagsDebounced();
            if (this.selectedTags.length > 0) {
                this.buildFolderTree();
            }

            // Hide the "saved" indicator.
            setTimeout(() => {
                this.lastSaved = false;
            }, CONFIG.SAVE_INDICATOR_DURATION);
        },

        // Ask what to do when the server refused a save because the file changed on disk.
        // Resolves true to overwrite. Escape, a click outside or "Reload" keep the disk version.
        async _askSaveConflict(notePath) {
            const name = notePath.split('/').pop().replace('.md', '');
            return await this.confirmModalAsk({
                title: this.t('notes.save_conflict_title'),
                message: this.t('notes.save_conflict_message', { name }),
                danger: true,
                confirmLabel: this.t('notes.save_conflict_overwrite'),
                cancelLabel: this.t('notes.save_conflict_reload')
            });
        },

        // Rename current note
        async renameNote() {
            if (!this.currentNote) return;
            
            const oldPath = this.currentNote;
            const newName = this.currentNoteName.trim();
            
            if (!newName) {
                this.toast(this.t('notes.empty_name'), { type: 'warning' });
                return;
            }
            
            // Validate the new name (single segment, no path separators)
            const validation = FilenameValidator.validateFilename(newName);
            if (!validation.valid) {
                this.toast(this.getValidationErrorMessage(validation, 'note'), { type: 'warning' });
                // Reset the name in the UI
                this.currentNoteName = oldPath.split('/').pop().replace('.md', '');
                return;
            }
            
            const validatedName = validation.sanitized;
            const folder = oldPath.split('/').slice(0, -1).join('/');
            const newPath = folder ? `${folder}/${validatedName}.md` : `${validatedName}.md`;
            
            if (oldPath === newPath) return;
            
            // Check if a note with the new name already exists
            const existingNote = this.notePathTaken(newPath) ? { path: newPath } : null;
            if (existingNote) {
                this.toast(this.t('notes.already_exists', { name: validatedName }), { type: 'warning' });
                // Reset the name in the UI
                this.currentNoteName = oldPath.split('/').pop().replace('.md', '');
                return;
            }
            
            // Optimistic rename: rewrite local path now + favorites + current
            // note pointer. The file itself moves through /api/notes/move.
            this._optimisticRenameNote(oldPath, newPath);
            this._rebuildTreeAfterMutation();
            
            if (this.favoritesSet.has(oldPath)) {
                this.favorites = this.favorites.map(f => f === oldPath ? newPath : f);
                this.favoritesSet = new Set(this.favorites);
                this.saveFavorites();
            }
            this.currentNote = newPath;

            // A pending autosave targets currentNote, which is already the new
            // path. Let it fire and it would create the destination before the
            // move, and the move would refuse to overwrite that file.
            this.flushHistory();
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = null;
            }
            
            try {
                await api.sendJSON('/api/notes/move', 'POST', { oldPath, newPath });
                // The moved file has the last saved copy. Write the editor
                // buffer too, so a rename before autosave does not drop keystrokes.
                const saveResponse = await api.raw(`/api/notes/${encodeVaultPath(newPath)}`, {
                    method: 'POST',
                    json: { content: this.noteContent, base_hash: this.noteBaseHash }
                });
                if (saveResponse.status === 409) {
                    // Changed elsewhere before the rename: the regular save asks what to do.
                    this.saveNote();
                } else if (!saveResponse.ok) {
                    throw new Error('Server returned error');
                } else if (newPath === this.currentNote) {
                    // Our own write: it is the base for the next save.
                    const saved = await saveResponse.json();
                    this.noteBaseHash = saved.hash || null;
                }
            } catch (error) {
                ErrorHandler.handle('rename note', error);
                await this.loadNotes({ silent: true });
            }
        },
        
        // Delete current note
        async deleteCurrentNote() {
            if (!this.currentNote) return;
            
            // Just call deleteNote with current note details
            await this.deleteNote(this.currentNote, this.currentNoteName);
        },
        
        // Delete any note from sidebar
        async deleteNote(notePath, noteName) {
            const ok = await this.confirmModalAsk({
                message: this.t('notes.confirm_delete', { name: noteName }),
            });
            if (!ok) return;
            
            // Optimistic: remove locally + clear current note + drop favorite
            // before the network round-trip. Sidebar refreshes in <1ms on any
            // vault size. On error we resync silently from disk.
            this._optimisticRemoveNote(notePath);
            this._rebuildTreeAfterMutation();
            
            if (this.favoritesSet.has(notePath)) {
                this.favorites = this.favorites.filter(f => f !== notePath);
                this.favoritesSet = new Set(this.favorites);
                this.saveFavorites();
            }
            
            if (this.currentNote === notePath) {
                this._resetNoteState();
                window.history.replaceState({}, '', '/');
            }
            
            try {
                await api.send(`/api/notes/${encodeVaultPath(notePath)}`, 'DELETE');
                this.loadTagsDebounced();
            } catch (error) {
                ErrorHandler.handle('delete note', error);
                await this.loadNotes({ silent: true });
            }
        },
    };
}
