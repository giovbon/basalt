// Note loading, editing, saving, and note-level mutation flows.
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import { CONFIG } from '../core/config.js';
import { ErrorHandler, encodeVaultPath, FilenameValidator } from '../core/utils.js';
import * as api from '../core/api.js';
import { findDataviewQueries } from '../lib/dataview.js';
import { createSaveController } from '../lib/save-controller.js';
import { conflictCopyPath, foldersFromNotes, offlineStamp } from '../lib/paths.js';
import { createOutboxSync } from '../lib/outbox-sync.js';

// How long to wait before replaying an outbox that still has work after a pass
// (text coalesced during the request, or a server that was briefly down).
const OFFLINE_SYNC_RETRY_MS = 15000;

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
                this.offlineMode = false;
                // Fire-and-forget: the sidebar is already usable and the
                // cache write must not delay it.
                this._cacheNotesSnapshot(data);
            } catch (error) {
                // Only transport failures and server errors fall back to the
                // snapshot. A 401/403 must stay visible instead of showing a
                // stale vault from a session that is no longer valid.
                const canUseCache = !error || typeof error.status !== 'number' || error.status >= 500;
                const restored = canUseCache ? await this._restoreNotesSnapshot() : false;
                if (restored) {
                    this.offlineMode = true;
                } else {
                    ErrorHandler.handle('load notes', error);
                }
            } finally {
                clearTimeout(this._notesLoadingOverlayTimer);
                this.notesLoading = false;
                this.notesLoadingShowOverlay = false;
            }
        },

        // Persist the sidebar snapshot (summaries + folder list) for offline
        // startup. Failures are silent: cache is best-effort.
        _cacheNotesSnapshot(data) {
            // Only the newest snapshot may replace the cache: two loadNotes()
            // calls can overlap (initial load + a silent re-sync after a save)
            // and the older response must not clobber the newer one.
            const seq = this._notesSnapshotSeq + 1;
            this._notesSnapshotSeq = seq;
            Promise.resolve().then(async () => {
                const store = await this._offlineReady();
                if (!store || this._notesSnapshotSeq !== seq) return;
                await store.replaceSummaries(data.notes || []);
                await store.setMeta('folders', data.folders || []);
                await store.setMeta('notesCachedAt', new Date().toISOString());
            }).catch(() => {});
        },

        // Rebuild the sidebar from the cached snapshot. Returns false when
        // nothing was ever cached, so the caller can surface the real error.
        async _restoreNotesSnapshot() {
            const store = await this._offlineReady();
            if (!store) return false;
            try {
                const cachedAt = await store.getMeta('notesCachedAt', null);
                if (cachedAt === null) return false;
                const summaries = await store.listSummaries();
                const folders = await store.getMeta('folders', null);
                this.notes = summaries;
                this.allFolders = Array.isArray(folders)
                    ? folders
                    : foldersFromNotes(summaries);
                this.buildNoteLookupMaps();
                this.buildFolderTree();
                const tags = await store.getMeta('tags', null);
                if (tags && typeof tags === 'object') this.allTags = tags;
                return true;
            } catch (_) {
                return false;
            }
        },

        // Cache the full GET /api/notes/{path} payload so the note can be
        // opened offline with its outline, frontmatter and backlinks.
        _cacheDocument(notePath, data) {
            Promise.resolve().then(async () => {
                const store = await this._offlineReady();
                if (!store) return;
                await store.putDocument({ ...data, path: notePath });
            }).catch(() => {});
        },

        async _readCachedDocument(notePath) {
            const store = await this._offlineReady();
            if (!store) return null;
            try {
                const doc = await store.getDocument(notePath);
                return doc && typeof doc.content === 'string' ? doc : null;
            } catch (_) {
                return null;
            }
        },
        
        
        // Clear every piece of state derived from the open note. Used when the
        // note disappears (404 from the API or a local delete) so the outline,
        // backlinks and undo history do not keep showing the previous document.
        _resetNoteState() {
            this.currentNote = '';
            this.noteContent = '';
            this.noteBaseHash = null;
            this.noteFromCache = false;
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
            // Close mobile sidebar when a note is selected
            this.mobileSidebarOpen = false;

            let data;
            let fromCache = false;

            try {
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
                    const httpError = new Error(`HTTP error! status: ${response.status}`);
                    httpError.status = response.status;
                    throw httpError;
                }

                data = await response.json();
                // Best-effort: a cache failure must never break opening a note.
                this._cacheDocument(notePath, data);
            } catch (error) {
                // Only transport/HTTP-server failures reach here (a 404
                // returned above). A 401/403 must stay visible instead of
                // serving a cached copy from an invalid session.
                const canUseCache = !error || typeof error.status !== 'number' || error.status >= 500;
                data = canUseCache ? await this._readCachedDocument(notePath) : null;
                if (!data) {
                    if (!this.isOnline && this.notes.some((note) => note.path === notePath)) {
                        this.toast(this.t('offline.note_not_available', {
                            name: notePath.split('/').pop().replace('.md', ''),
                        }), { type: 'warning' });
                    } else {
                        ErrorHandler.handle('load note', error);
                    }
                    return;
                }
                fromCache = true;
            }

            try {
                this.noteFromCache = fromCache;
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
                        if (!this.exactSearchMatch) {
                            params.set('whole_word', 'false');
                        }
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
                            exactSearchMatch: this.exactSearchMatch,
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
                    this.currentSearchExactMatch = this.exactSearchMatch;
                    this._searchTargetAfterRender = {
                        notePath,
                        query: searchQuery,
                        line: targetLine,
                        column: targetColumn,
                    };
                } else {
                    // Clear highlights if no search query
                    this.currentSearchHighlight = '';
                    this.currentSearchExactMatch = this.exactSearchMatch;
                    this._searchTargetAfterRender = null;
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

                        // Scroll note into view in sidebar if needed
                        this.scrollNoteIntoView(notePath);
                        
                        // Render syntax highlighting overlay (if enabled)
                        this.updateSyntaxHighlight();
                        
                        // Render markdown preview
                        this.renderPreview();

                        // x-html updates the preview after Alpine's next tick.
                        // Apply search marks and scroll only after that DOM is in
                        // place, or the search result targets the previous note.
                        this.$nextTick(() => {
                            requestAnimationFrame(() => {
                                if (this.currentNote !== notePath
                                    || this.currentSearchHighlight !== searchQuery) return;

                                if (searchQuery) {
                                    this.highlightSearchTerm(searchQuery, true, targetLine, targetColumn);
                                } else if (targetLine) {
                                    this.scrollEditorToLine(targetLine);
                                    this.scrollPreviewToSourceLine(targetLine);
                                    this.clearSearchHighlights();
                                } else {
                                    this.clearSearchHighlights();
                                }
                            });
                        });
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
                    askConflict: (notePath, details) => this._askSaveConflict(notePath, details),
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

        async _postNoteSave(notePath, content, baseHash) {
            // 409 is part of the protocol, so it is parsed rather than thrown.
            const response = await api.raw(`/api/notes/${encodeVaultPath(notePath)}`, {
                method: 'POST',
                json: { content, base_hash: baseHash }
            });
            const body = (response.ok || response.status === 409) ? await response.json() : {};
            return { ok: response.ok, status: response.status, ...body };
        },

        async _sendNoteSave({ notePath, content, baseHash }) {
            // A replay is writing this note: sending the buffer in parallel
            // could race it and turn the user's own follow-up edit into a 409.
            // Queueing keeps a single ordered writer per note.
            if (this.syncingOfflineSaves) {
                const queued = await this._queueOfflineSave({ notePath, content, baseHash });
                if (queued) {
                    return { ok: true, status: 0, queued: true, hash: baseHash || null };
                }
            }
            try {
                return await this._postNoteSave(notePath, content, baseHash);
            } catch (error) {
                // fetch only rejects for transport failures (offline, server
                // unreachable); HTTP errors were turned into a response above.
                const queued = await this._queueOfflineSave({ notePath, content, baseHash });
                if (!queued) throw error;
                return {
                    ok: true,
                    status: 0,
                    queued: true,
                    hash: baseHash || null,
                };
            }
        },

        // Persist the editor buffer in the outbox and in the document cache.
        // Returns the queued operation, or null when the cache is unavailable
        // (the caller then rethrows the original save error).
        async _queueOfflineSave({ notePath, content, baseHash }) {
            const store = await this._offlineReady();
            if (!store) return null;
            try {
                const op = await store.queueSave({
                    path: notePath,
                    content,
                    baseHash: baseHash || '',
                });
                const doc = await store.getDocument(notePath);
                await store.putDocument({
                    ...(doc || { path: notePath }),
                    path: notePath,
                    content,
                    // The server still has the old version: keep baseHash as
                    // the version the queued compare-and-swap is based on.
                    hash: baseHash || null,
                    // Parsed on the server; the cached copies describe the
                    // previous version, so drop them instead of showing a TOC
                    // for headings the pending text may have removed.
                    outline: [],
                    frontmatter: null,
                    backlinks: [],
                });
                await this._refreshPendingSaveCount();
                if (!this.isOnline && !this._offlineSaveNotified) {
                    this._offlineSaveNotified = true;
                    this.toast(this.t('offline.saved_locally'), { type: 'info' });
                }
                return op;
            } catch (error) {
                ErrorHandler.handle('queue offline save', error, false);
                return null;
            }
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
            const queued = result.queued === true;

            // A hover preview for this note would otherwise show the version
            // from before this save for up to its cache TTL.
            if (this._linkPreviewCache) this._linkPreviewCache.delete(notePath);
            if (this._wikilinkOutlineCache) this._wikilinkOutlineCache.delete(notePath);

            if (notePath === this.currentNote && !queued) {
                this.noteBaseHash = result.hash || null;
                // Refresh TOC and metadata panels from the server-parsed response.
                this.outline = result.outline || [];
                this.noteMetadata = result.frontmatter || null;
                if (content === this.noteContent && findDataviewQueries(content).length > 0) {
                    this.renderPreview();
                }
            }
            this.lastSaved = true;

            // Update only the modified timestamp for the saved note (no full reload).
            const note = this.notes.find(n => n.path === notePath);
            if (note) {
                note.modified = new Date().toISOString();
                note.size = new Blob([content]).size;
                if (Array.isArray(result.tags)) note.tags = result.tags;
                this._cacheSummary(notePath);
            }

            // Reload tags to update sidebar counts (debounced to prevent spam).
            // A queued save has no server-parsed tags to refresh.
            if (!queued) this.loadTagsDebounced();
            if (this.selectedTags.length > 0) {
                this.buildFolderTree();
            }

            // Hide the "saved" indicator.
            setTimeout(() => {
                this.lastSaved = false;
            }, CONFIG.SAVE_INDICATOR_DURATION);
        },

        async _cacheSummary(notePath) {
            const store = await this._offlineReady();
            const note = this.notes.find((n) => n.path === notePath);
            if (!store || !note) return;
            try {
                await store.putSummary({ ...note });
            } catch (_) {
                // Cache is best-effort.
            }
        },

        _getOutboxSync(store) {
            if (!this._outboxSyncInstance) {
                this._outboxSyncInstance = createOutboxSync({
                    store,
                    send: (op) => this._postNoteSave(op.path, op.content, op.baseHash),
                    onSynced: (op, result) => this._handleOutboxSynced(store, op, result),
                    onConflict: (op) => this._handleOutboxConflict(store, op),
                    onFailed: (op, result) => {
                        ErrorHandler.handle(
                            'sync queued save',
                            new Error(result?.detail || `HTTP ${result?.status || 0}`),
                            false,
                        );
                    },
                });
            }
            return this._outboxSyncInstance;
        },

        // Single-flight replay of the outbox. Called after startup, when the
        // browser reports "online", and can be called again freely.
        _syncPendingSaves() {
            if (!this.isOnline) return null;
            if (this._syncPendingPromise) return this._syncPendingPromise;

            const run = (async () => {
                const store = await this._offlineReady();
                if (!store) return null;
                const pending = await store.pendingCount().catch(() => 0);
                if (pending === 0) {
                    this.pendingSaveCount = 0;
                    return null;
                }

                this.syncingOfflineSaves = true;
                try {
                    const summary = await this._getOutboxSync(store).sync();
                    await this._refreshPendingSaveCount();
                    // A drained outbox means the next offline stretch should
                    // notify again, not stay silent because of this session.
                    if (this.pendingSaveCount === 0) this._offlineSaveNotified = false;
                    if (summary.synced > 0) {
                        this.toast(this.t('offline.synced', { count: summary.synced }), {
                            type: 'success',
                        });
                    }
                    return summary;
                } catch (error) {
                    ErrorHandler.handle('sync offline saves', error, false);
                    return null;
                } finally {
                    this.syncingOfflineSaves = false;
                    // Text coalesced into an operation during the pass, or a
                    // server that was briefly unhealthy, leaves work queued.
                    // Retry in the background instead of waiting for the next
                    // reload/reconnect event.
                    this._scheduleOfflineSyncRetry();
                }
            })();

            this._syncPendingPromise = run;
            run.finally(() => {
                this._syncPendingPromise = null;
            }).catch(() => {});
            return run;
        },

        _scheduleOfflineSyncRetry() {
            if (this._offlineSyncRetryTimer) return;
            if (!this.isOnline || this.pendingSaveCount === 0) return;
            this._offlineSyncRetryTimer = setTimeout(() => {
                this._offlineSyncRetryTimer = null;
                this._syncPendingSaves();
            }, OFFLINE_SYNC_RETRY_MS);
        },

        async _handleOutboxSynced(store, op, result) {
            // Keep the cached document's base hash in sync, but only while its
            // content is still the one the server just accepted. If the user
            // typed during the request, queueSave() already holds newer text
            // and a later pass will update the hash.
            try {
                const doc = await store.getDocument(op.path);
                if (doc && doc.content === op.content) {
                    await store.putDocument({ ...doc, hash: result.hash || null });
                }
            } catch (_) {
                // Cache is best-effort.
            }

            // If newer text was coalesced into the operation while it was in
            // flight, it was typed on top of what the server just accepted, so
            // rebase it. Without this the next replay would see a false 409.
            try {
                await store.rebasePath(op.path, result.hash || '');
            } catch (_) {
                // Cache is best-effort.
            }

            if (op.path === this.currentNote) {
                // The server version is now the base for any later save of this
                // note, even if the buffer already contains newer keystrokes.
                this.noteBaseHash = result.hash || null;
                if (op.content === this.noteContent) {
                    this._handleSaveSuccess({ notePath: op.path, content: op.content }, result);
                }
            } else {
                const note = this.notes.find((n) => n.path === op.path);
                if (note) {
                    note.modified = new Date().toISOString();
                    note.size = new Blob([op.content]).size;
                    if (Array.isArray(result.tags)) note.tags = result.tags;
                    this._cacheSummary(op.path);
                }
            }
        },

        // The queued text no longer matches the server. Preserve it as a
        // sibling note instead of overwriting or discarding it.
        async _handleOutboxConflict(store, op) {
            const stamp = `${offlineStamp()}-${String(op.opId).slice(0, 6)}`;
            const copyPath = conflictCopyPath(op.path, stamp);
            let result;
            try {
                result = await this._postNoteSave(copyPath, op.content, '');
            } catch (_) {
                // Offline again: leave the operation queued for the next pass.
                return;
            }

            if (result.ok) {
                await store.ackOp(op.opId, { updatedAt: op.updatedAt });
                this.toast(this.t('offline.conflict_copy', { path: copyPath }), {
                    type: 'warning',
                    durationMs: 12000,
                });
                await this.loadNotes({ silent: true });
                return;
            }

            this.toast(this.t('offline.conflict_pending', { path: op.path }), {
                type: 'warning',
                durationMs: 12000,
            });
        },

        // Ask what to do when the server refused a save because the file changed on disk.
        // Resolves true to overwrite. Escape, a click outside or "Reload" keep the disk version.
        async _askSaveConflict(notePath, { deleted = false } = {}) {
            const name = notePath.split('/').pop().replace('.md', '');
            return await this.confirmModalAsk({
                title: this.t(deleted ? 'notes.save_deleted_title' : 'notes.save_conflict_title'),
                message: this.t(deleted ? 'notes.save_deleted_message' : 'notes.save_conflict_message', { name }),
                danger: true,
                confirmLabel: this.t(deleted ? 'notes.save_deleted_recreate' : 'notes.save_conflict_overwrite'),
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
