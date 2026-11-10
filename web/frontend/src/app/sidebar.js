// Sidebar navigation, folder operations, tags, favorites, and outline.
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import { ErrorHandler, encodeVaultPath } from '../core/utils.js';
import { LOCAL_SETTINGS } from '../core/config.js';
import * as api from '../core/api.js';
import { buildFolderTree, noteComparator, folderComparator } from '../lib/folder-tree.js';
import { folderFromPath, filenameFromPath, inferTypeFromPath } from '../lib/paths.js';
import { saveSetting } from '../core/settings.js';

export function createSidebar() {
    return {
        
        getFolderNode(folderPath = '') {
            if (!this.folderTree || typeof this.folderTree !== 'object') {
                return null;
            }
            
            if (!folderPath) {
                return this.folderTree['__root__'] || { name: '', path: '', children: {}, notes: [], noteCount: 0 };
            }
            
            const parts = folderPath.split('/').filter(Boolean);
            let currentLevel = this.folderTree;
            let node = null;
            
            for (const part of parts) {
                if (!currentLevel[part]) {
                    return null;
                }
                node = currentLevel[part];
                currentLevel = node.children || {};
            }
            
            return node;
        },

        // Cycle through sort modes
        cycleSortMode() {
            const currentIndex = this.sortModes.indexOf(this.sortMode);
            const nextIndex = (currentIndex + 1) % this.sortModes.length;
            this.sortMode = this.sortModes[nextIndex];
            saveSetting('sortMode', this.sortMode, LOCAL_SETTINGS);
            // Rebuild tree to apply new sort order
            this.buildFolderTree();
        },

        // Generic sort glyph with the arrow following the current direction.
        getSortIcon() {
            const ascending = ['z-a', 'oldest', 'smallest'].includes(this.sortMode);
            const arrow = ascending
                ? '<path d="M20 19V5"/><path d="m17 8 3-3 3 3"/>'
                : '<path d="M20 5v14"/><path d="m17 16 3 3 3-3"/>';
            return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" '
                + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
                + 'stroke-linejoin="round" aria-hidden="true">'
                + '<path d="M3 6h11M3 12h8M3 18h5"/>' + arrow + '</svg>';
        },

        // Get sort comparator based on current mode (for notes)
        getSortComparator() {
            return noteComparator(this.sortMode);
        },

        // Get sort comparator for folders (only A-Z/Z-A, others default to A-Z)
        getFolderSortComparator() {
            return folderComparator(this.sortMode);
        },
        
        // Load all tags
        async loadTags() {
            try {
                const data = await api.getJSON('/api/tags');
                this.allTags = data.tags || {};
                this._cacheTags(this.allTags);
            } catch (error) {
                // Offline: the counts come from the last snapshot; without one,
                // keep the previous in-memory value instead of clearing it.
                const cached = await this._readCachedTags();
                if (cached) {
                    this.allTags = cached;
                } else {
                    ErrorHandler.handle('load tags', error, false); // Optional: no toast
                }
            }
        },

        _cacheTags(tags) {
            Promise.resolve().then(async () => {
                const store = await this._offlineReady();
                if (store) await store.setMeta('tags', tags);
            }).catch(() => {});
        },

        async _readCachedTags() {
            const store = await this._offlineReady();
            if (!store) return null;
            try {
                const tags = await store.getMeta('tags', null);
                return tags && typeof tags === 'object' ? tags : null;
            } catch (_) {
                return null;
            }
        },
        
        // Debounced tag reload (prevents excessive API calls during typing)
        loadTagsDebounced() {
            // Clear existing timeout
            if (this.tagReloadTimeout) {
                clearTimeout(this.tagReloadTimeout);
            }
            
            // Set new timeout - reload tags 2 seconds after last save
            this.tagReloadTimeout = setTimeout(() => {
                this.loadTags();
            }, 2000);
        },
        
        // Toggle tag selection for filtering
        toggleTag(tag) {
            const index = this.selectedTags.indexOf(tag);
            if (index > -1) {
                this.selectedTags.splice(index, 1);
            } else {
                this.selectedTags.push(tag);
            }
            
            // Apply unified filtering
            this.applyFilters();
        },
        
        // Clear all tag filters
        clearTagFilters() {
            this.selectedTags = [];
            
            // Apply unified filtering
            this.applyFilters();
        },
        
        // Scroll to a heading in the editor or preview
        scrollToHeading(heading) {
            if (this.viewMode === 'preview' || this.viewMode === 'split') {
                // In preview/split mode, scroll the preview pane
                const preview = document.querySelector('.markdown-preview');
                if (preview) {
                    // Find the heading element by text content (more reliable than ID)
                    const headingElements = preview.querySelectorAll('h1, h2, h3, h4, h5, h6');
                    for (const el of headingElements) {
                        if (el.textContent.trim() === heading.text) {
                            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            // Add a brief highlight effect
                            el.style.transition = 'background-color 0.3s';
                            el.style.backgroundColor = 'var(--accent-light)';
                            setTimeout(() => {
                                el.style.backgroundColor = '';
                            }, 1000);
                            return;
                        }
                    }
                }
            }
            
            if (this.viewMode === 'edit' || this.viewMode === 'split') {
                // In edit/split mode, scroll the editor to the line
                const textarea = document.querySelector('.editor-textarea');
                if (textarea && heading.line) {
                    const lines = textarea.value.split('\n');
                    let charPos = 0;
                    
                    // Calculate character position of the heading line
                    for (let i = 0; i < heading.line - 1 && i < lines.length; i++) {
                        charPos += lines[i].length + 1; // +1 for newline
                    }
                    
                    // Set cursor position and scroll
                    textarea.focus();
                    textarea.setSelectionRange(charPos, charPos);
                    
                    // Calculate scroll position (approximate)
                    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 24;
                    const scrollTop = (heading.line - 1) * lineHeight - textarea.clientHeight / 3;
                    textarea.scrollTop = Math.max(0, scrollTop);
                }
            }
        },

        // Navigate to a backlink (note that links to current note)
        navigateToBacklink(backlinkPath) {
            this.loadNote(backlinkPath);
        },
        
        // Unified filtering logic combining tags and text search
        async applyFilters() {
            const hasTextSearch = this.isSearchable();
            const hasTagFilter = this.selectedTags.length > 0;
            
            // Case 1: No filters at all → show full folder tree
            if (!hasTextSearch && !hasTagFilter) {
                this.isSearching = false;
                this.searchResults = [];
                this.expandedSearchResults = {};
                this.currentSearchHighlight = '';
                this.clearSearchHighlights();
                this.buildFolderTree();
                return;
            }
            
            // Case 2: Only tag filter → convert to flat list of matching notes
            if (hasTagFilter && !hasTextSearch) {
                this.isSearching = false;
                this.searchResults = this.notes.filter(note => 
                    note.type === 'note' && this.noteMatchesTags(note)
                );
                this.expandedSearchResults = {};
                this.currentSearchHighlight = '';
                this.clearSearchHighlights();
                return;
            }
            
            // Case 3: Text search (with or without tag filter)
            if (hasTextSearch) {
                this.isSearching = true;
                try {
                    const params = new URLSearchParams({
                        q: this.searchQuery,
                        whole_word: String(this.exactSearchMatch),
                    });
                    const data = await api.getJSON(`/api/search?${params}`);
                    
                    // Apply tag filtering to search results if tags are selected
                    let results = data.results;
                    if (hasTagFilter) {
                        results = results.filter(result => {
                            const note = this.notes.find(n => n.path === result.path);
                            return note ? this.noteMatchesTags(note) : false;
                        });
                    }
                    
                    this.searchResults = results;

                    // Keep groups the user already expanded, but drop paths that
                    // disappeared from the new result set.
                    const expanded = {};
                    for (const result of results) {
                        if (this.expandedSearchResults[result.path]) {
                            expanded[result.path] = true;
                        }
                    }
                    this.expandedSearchResults = expanded;
                    
                    // Highlight the term in the note that is already open.
                    // Skip when this exact query is already showing: a note
                    // opened from a result (or a reload of
                    // ?search=&line=&col=) highlights the clicked occurrence
                    // itself, and running this pass again would reset it to
                    // the first match and scroll away from it.
                    if (this.currentNote && this.noteContent
                        && ((this.currentSearchHighlight || '') !== (this.searchQuery || '')
                            || this.currentSearchExactMatch !== this.exactSearchMatch)) {
                        this.currentSearchHighlight = this.searchQuery;
                        this.currentSearchExactMatch = this.exactSearchMatch;
                        this.$nextTick(() => {
                            this.highlightSearchTerm(this.searchQuery, false);
                        });
                    }
                } catch (error) {
                    console.error('Search failed:', error);
                    this.searchResults = [];
                } finally {
                    this.isSearching = false;
                }
            }
        },
        
        // Check if a note matches selected tags (AND logic)
        noteMatchesTags(note) {
            if (this.selectedTags.length === 0) {
                return true; // No filter active
            }
            if (!note.tags || note.tags.length === 0) {
                return false; // Note has no tags but filter is active
            }
            // Check if note has ALL selected tags (AND logic)
            return this.selectedTags.every(tag => note.tags.includes(tag));
        },
        
        // Get all tags sorted by name
        get sortedTags() {
            return Object.entries(this.allTags).sort((a, b) => a[0].localeCompare(b[0]));
        },
        
        // Get tags for current note
        get currentNoteTags() {
            if (!this.currentNote) return [];
            const note = this.notes.find(n => n.path === this.currentNote);
            return note && note.tags ? note.tags : [];
        },
        
        // ==================== FAVORITES ====================
        
        // Save favorites to localStorage
        saveFavorites() {
            try {
                saveSetting('favorites', this.favorites, LOCAL_SETTINGS);
            } catch (e) {
                console.warn('Could not save favorites to localStorage');
            }
        },
        
        // Check if a note is favorited (O(1) lookup)
        isFavorite(notePath) {
            return this.favoritesSet.has(notePath);
        },
        
        // Toggle favorite status for a note
        toggleFavorite(notePath = null) {
            const path = notePath || this.currentNote;
            if (!path) return;
            
            if (this.favoritesSet.has(path)) {
                // Remove from favorites
                this.favorites = this.favorites.filter(f => f !== path);
            } else {
                // Add to favorites
                this.favorites = [...this.favorites, path];
            }
            // Recreate Set from array for consistency
            this.favoritesSet = new Set(this.favorites);
            this.saveFavorites();
        },
        
        // Get favorite notes with full details (for display)
        get favoriteNotes() {
            return this.favorites
                .map(path => {
                    // Find note by exact path or case-insensitive match
                    let note = this.notes.find(n => n.path === path);
                    if (!note) {
                        note = this.notes.find(n => n.path.toLowerCase() === path.toLowerCase());
                    }
                    if (!note) return null;
                    return {
                        path: note.path, // Use actual path from notes (fixes case issues)
                        name: note.path.split('/').pop().replace('.md', ''),
                        folder: note.folder || ''
                    };
                })
                .filter(Boolean); // Remove nulls (deleted notes)
        },
        
        saveFavoritesExpanded() {
            try {
                saveSetting('favoritesExpanded', this.favoritesExpanded, LOCAL_SETTINGS);
            } catch (e) {
                console.error('Error saving favorites expanded state:', e);
            }
        },
        
        // Build folder tree structure
        buildFolderTree() {
            // The tree itself is a pure transformation (lib/folder-tree.js); the
            // component only owns the reactive assignment and the cache reset.
            this.folderTree = buildFolderTree(this.notes, this.allFolders, this.getSortComparator());

            // Invalidate homepage cache when tree is rebuilt
            this._homepageCache = {
                folderPath: null,
                notes: null,
                folders: null,
                breadcrumb: null
            };
        },
        
        // =====================================================================
        // OPTIMISTIC MUTATION HELPERS
        // Mirror server-side index updates locally so file ops feel instant on
        // big vaults. Mutations apply the change to this.notes/this.allFolders
        // immediately, fire the request, and on error fall back to
        // loadNotes({silent: true}) to resync from disk.
        // =====================================================================
        
        _isoNow() {
            return new Date().toISOString();
        },
        
        _folderFromPath(path) {
            return folderFromPath(path);
        },
        
        _filenameFromPath(path) {
            return filenameFromPath(path);
        },

        // Windows and macOS store these as one file. Rename already used this
        // comparison; create and import must too, or `b` overwrites `B`.
        notePathTaken(path) {
            if (!path) return false;
            const lower = path.toLowerCase();
            return this.notes.some(n => n.path.toLowerCase() === lower);
        },

        folderPathTaken(path) {
            if (!path) return false;
            const lower = path.toLowerCase();
            return this.allFolders.some(folder => folder.toLowerCase() === lower);
        },
        
        _inferTypeFromPath(path) {
            return inferTypeFromPath(path);
        },
        
        // Refresh sidebar tree + wikilink lookup maps after any optimistic update.
        _rebuildTreeAfterMutation() {
            this.buildNoteLookupMaps();
            this.buildFolderTree();
        },
        
        // Add a note/media file to the local list. No-op if already present.
        _optimisticAddNote(path, { content = '', type = null, size = null } = {}) {
            if (this.notes.some(n => n.path === path)) return;
            const inferredType = type || this._inferTypeFromPath(path);
            const filename = this._filenameFromPath(path);
            const name = inferredType === 'note' ? filename.replace(/\.md$/i, '') : filename;
            this.notes.push({
                path,
                name,
                folder: this._folderFromPath(path),
                type: inferredType,
                size: size != null ? size : (content ? new Blob([content]).size : 0),
                modified: this._isoNow(),
                tags: [],
            });
        },
        
        _optimisticRemoveNote(path) {
            this.notes = this.notes.filter(n => n.path !== path);
        },
        
        // Used by single-note rename and move (path changes, identity preserved).
        _optimisticRenameNote(oldPath, newPath) {
            const note = this.notes.find(n => n.path === oldPath);
            if (!note) return;
            note.path = newPath;
            note.folder = this._folderFromPath(newPath);
            const filename = this._filenameFromPath(newPath);
            note.name = note.type === 'note' ? filename.replace(/\.md$/i, '') : filename;
        },
        
        _optimisticAddFolder(folderPath) {
            if (!folderPath) return;
            if (!this.allFolders.includes(folderPath)) {
                this.allFolders.push(folderPath);
            }
        },
        
        // Cascade: remove the folder, its descendant folders, and every note inside.
        _optimisticRemoveFolderTree(folderPath) {
            const prefix = folderPath + '/';
            this.allFolders = this.allFolders.filter(f => f !== folderPath && !f.startsWith(prefix));
            this.notes = this.notes.filter(n => !n.path.startsWith(prefix));
        },

        // Cascade: rename the folder, its descendant folders, and rewrite paths
        // of every note inside.
        _optimisticRenameFolderTree(oldPath, newPath) {
            if (oldPath === newPath) return;
            const oldPrefix = oldPath + '/';
            const newPrefix = newPath + '/';
            this.allFolders = this.allFolders.map(f => {
                if (f === oldPath) return newPath;
                if (f.startsWith(oldPrefix)) return newPrefix + f.substring(oldPrefix.length);
                return f;
            });
            this.notes.forEach(n => {
                if (n.path.startsWith(oldPrefix)) {
                    n.path = newPrefix + n.path.substring(oldPrefix.length);
                    n.folder = this._folderFromPath(n.path);
                }
            });
        },
        
        // Toggle folder expansion
        toggleFolder(folderPath) {
            if (this.expandedFolders.has(folderPath)) {
                this.expandedFolders.delete(folderPath);
            } else {
                this.expandedFolders.add(folderPath);
            }
            // Force Alpine reactivity by creating new Set reference
            this.expandedFolders = new Set(this.expandedFolders);
        },
        
        // Check if folder is expanded
        isFolderExpanded(folderPath) {
            return this.expandedFolders.has(folderPath);
        },
        
        // Expand all folders
        expandAllFolders() {
            this.allFolders.forEach(folder => {
                this.expandedFolders.add(folder);
            });
            // Force Alpine reactivity
            this.expandedFolders = new Set(this.expandedFolders);
        },
        
        // Collapse all folders
        collapseAllFolders() {
            this.expandedFolders.clear();
            // Force Alpine reactivity
            this.expandedFolders = new Set(this.expandedFolders);
        },
        
        // Expand folder tree to show a specific note
        expandFolderForNote(notePath) {
            const parts = notePath.split('/');
            
            // If note is in root, no folders to expand
            if (parts.length <= 1) return;
            
            // Remove the note name (last part)
            parts.pop();
            
            // Build and expand all parent folders
            let currentPath = '';
            parts.forEach((part, index) => {
                currentPath = index === 0 ? part : `${currentPath}/${part}`;
                this.expandedFolders.add(currentPath);
            });
            
            // Force Alpine reactivity
            this.expandedFolders = new Set(this.expandedFolders);
        },
        
        // Scroll note into view in the sidebar navigation
        scrollNoteIntoView(notePath) {
            // Find the note element in the sidebar
            // Use a slight delay to ensure DOM is fully rendered with Alpine bindings applied
            setTimeout(() => {
                const sidebar = document.querySelector('.flex-1.overflow-y-auto.custom-scrollbar');
                if (!sidebar) return;
                
                const noteElements = sidebar.querySelectorAll('.note-item');
                let targetElement = null;
                const noteName = notePath.split('/').pop().replace('.md', '');
                
                // Find the element that corresponds to this note
                noteElements.forEach(el => {
                    // Check if this is a note element (not folder) by checking if it has the note name
                    if (el.textContent.trim().startsWith(noteName) || el.textContent.includes(noteName)) {
                        // Check computed style to see if it's highlighted
                        const computedStyle = window.getComputedStyle(el);
                        const bgColor = computedStyle.backgroundColor;
                        
                        // Check if background has the accent color (not transparent or default)
                        if (bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent' && !bgColor.includes('255, 255, 255')) {
                            targetElement = el;
                        }
                    }
                });
                
                // If found, scroll it into view
                if (targetElement) {
                    targetElement.scrollIntoView({ 
                        behavior: 'smooth', 
                        block: 'center',
                        inline: 'nearest'
                    });
                }
            }, 200); // Increased delay to ensure Alpine has finished rendering
        },
        
        // Unified drag and drop handlers for notes, folders, and media
        onItemDragStart(itemPath, itemType, event) {
            // Set unified drag state
            this.draggedItem = { path: itemPath, type: itemType };
            
            // Make drag image semi-transparent
            if (event.target) {
                event.target.style.opacity = '0.5';
            }
            
            event.dataTransfer.effectAllowed = 'all';
        },
        
        onItemDragEnd() {
            this.draggedItem = null;
            this.dropTarget = null;
            this.dragOverFolder = null;
            // Reset opacity of all draggable items
            document.querySelectorAll('.note-item, .folder-header').forEach(el => el.style.opacity = '1');
            // Reset drag-over class
            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        },
        
        
        cancelDrag() {
            // Cancel any active drag operation (triggered by ESC key)
            this.draggedItem = null;
            this.dropTarget = null;
            this.dragOverFolder = null;
            // Reset styles - only query elements with drag-over class (more efficient)
            document.querySelectorAll('.folder-item').forEach(el => el.style.opacity = '1');
            document.querySelectorAll('.note-item').forEach(el => el.style.opacity = '1');
            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        },
        
        async onFolderDrop(targetFolderPath) {
            // Capture dragged item info immediately (ondragend may clear it)
            if (!this.draggedItem) return;
            const { path: draggedPath, type: draggedType } = this.draggedItem;
            
            // Determine item category for endpoint selection
            const isFolder = draggedType === 'folder';
            const isNote = draggedType === 'note';
            const isMedia = !isFolder && !isNote; // image, audio, video, document
            
            // Handle folder drop
            if (isFolder) {
                // Prevent dropping folder into itself or its subfolders
                if (targetFolderPath === draggedPath || 
                    targetFolderPath.startsWith(draggedPath + '/')) {
                    this.toast(this.t('folders.cannot_move_into_self'), { type: 'warning' });
                    return;
                }
                
                const folderName = draggedPath.split('/').pop();
                const newPath = targetFolderPath ? `${targetFolderPath}/${folderName}` : folderName;
                
                if (newPath === draggedPath) return;
                
                const oldPrefix = draggedPath + '/';
                const newPrefix = newPath + '/';
                const wasExpanded = this.expandedFolders.has(draggedPath);
                
                this._optimisticRenameFolderTree(draggedPath, newPath);
                this._rebuildTreeAfterMutation();
                
                const favoritesInFolder = this.favorites.filter(f => f.startsWith(oldPrefix));
                if (favoritesInFolder.length > 0) {
                    const newFavorites = this.favorites.map(f =>
                        f.startsWith(oldPrefix) ? newPrefix + f.substring(oldPrefix.length) : f
                    );
                    this.favorites = newFavorites;
                    this.favoritesSet = new Set(newFavorites);
                    this.saveFavorites();
                }
                if (wasExpanded) {
                    this.expandedFolders.delete(draggedPath);
                    this.expandedFolders.add(newPath);
                    this.saveExpandedFolders();
                }
                if (this.currentNote && this.currentNote.startsWith(oldPrefix)) {
                    this.currentNote = newPrefix + this.currentNote.substring(oldPrefix.length);
                }
                
                try {
                    await api.sendJSON('/api/folders/move', 'POST', { oldPath: draggedPath, newPath });
                    // Re-read the vault so the sidebar matches disk even if the
                    // optimistic tree above missed something (no page reload needed).
                    await this.loadNotes({ silent: true });
                } catch (error) {
                    console.error('Failed to move folder:', error);
                    // ApiError.detail carries the server message; network failures use the localized fallback.
                    this.toast(error.detail || this.t('move.failed_folder'), { type: 'error' });
                    await this.loadNotes({ silent: true });
                }
                return;
            }
            
            // Handle note or media drop into folder
            const item = this.notes.find(n => n.path === draggedPath);
            if (!item) return;
            
            const filename = draggedPath.split('/').pop();
            const newPath = targetFolderPath ? `${targetFolderPath}/${filename}` : filename;
            
            if (newPath === draggedPath) return;
            
            const wasFavorited = isNote && this.favoritesSet.has(draggedPath);
            const wasCurrentNote = this.currentNote === draggedPath;
            const wasCurrentMedia = this.currentMedia === draggedPath;
            
            this._optimisticRenameNote(draggedPath, newPath);
            this._rebuildTreeAfterMutation();
            
            if (wasFavorited) {
                this.favorites = this.favorites.map(f => f === draggedPath ? newPath : f);
                this.favoritesSet = new Set(this.favorites);
                this.saveFavorites();
            }
            if (wasCurrentNote) this.currentNote = newPath;
            if (wasCurrentMedia) this.currentMedia = newPath;
            
            try {
                const endpoint = isMedia ? '/api/media/move' : '/api/notes/move';
                await api.sendJSON(endpoint, 'POST', { oldPath: draggedPath, newPath });
                // Re-read the vault so the sidebar matches disk even if the
                // optimistic tree above missed something (no page reload needed).
                await this.loadNotes({ silent: true });
            } catch (error) {
                console.error(`Failed to move ${isMedia ? 'media' : 'note'}:`, error);
                this.toast(error.detail || this.t(isMedia ? 'move.failed_media' : 'move.failed_note'), { type: 'error' });
                await this.loadNotes({ silent: true });
            }
        },
    };
}
