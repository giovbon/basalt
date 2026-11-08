// File tree sidebar: rendering, folders, tags, favorites, outline.
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import { ErrorHandler, encodeVaultPath, FilenameValidator } from '../core/utils.js';
import { CONFIG, LOCAL_SETTINGS } from '../core/config.js';
import * as api from '../core/api.js';
import { buildFolderTree, noteComparator, folderComparator } from '../lib/folder-tree.js';
import { folderFromPath, filenameFromPath, inferTypeFromPath } from '../lib/paths.js';
import { readLocalSettings, saveSetting } from '../core/settings.js';
import { translate } from '../core/i18n.js';
import { treeIconSvg, treeIconKind, treeKindClass } from '../lib/file-icons.js';

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
            } catch (error) {
                ErrorHandler.handle('load tags', error, false); // Optional: no toast
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
                    const data = await api.getJSON(`/api/search?q=${encodeURIComponent(this.searchQuery)}`);
                    
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
                        && (this.currentSearchHighlight || '') !== (this.searchQuery || '')) {
                        this.currentSearchHighlight = this.searchQuery;
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

        toggleTreeSelectionMode() {
            this.treeSelectionMode = !this.treeSelectionMode;
            this.selectedTreeItems = [];
            this.treeSelectionAnchor = null;
            this.buildFolderTree();
        },

        setTreeItemSelected(path, type, selected) {
            const matches = item => item.path === path && item.type === type;
            if (!selected) {
                this.selectedTreeItems = this.selectedTreeItems.filter(item => !matches(item));
                this.syncTreeSelectionCheckboxes();
                return;
            }

            if (this.selectedTreeItems.some(item => matches(item)
                || (item.type === 'folder' && path.startsWith(item.path + '/')))) {
                this.syncTreeSelectionCheckboxes();
                return;
            }

            if (type === 'folder') {
                this.selectedTreeItems = this.selectedTreeItems.filter(item =>
                    !item.path.startsWith(path + '/')
                );
            }
            this.selectedTreeItems = [...this.selectedTreeItems, { path, type }];
            this.syncTreeSelectionCheckboxes();
        },

        syncTreeSelectionCheckboxes() {
            document.querySelectorAll('.tree-select-checkbox').forEach(checkbox => {
                checkbox.checked = this.selectedTreeItems.some(item =>
                    item.path === checkbox.dataset.path && item.type === checkbox.dataset.type
                );
            });
        },

        toggleTreeItemSelection(path, type) {
            const selected = this.selectedTreeItems.some(item => item.path === path && item.type === type);
            this.setTreeItemSelected(path, type, !selected);
            this.treeSelectionAnchor = { path, type };
        },

        selectTreeItemRange(path, type, selected) {
            const checkboxes = [...document.querySelectorAll('.tree-select-checkbox')];
            const targetIndex = checkboxes.findIndex(checkbox =>
                checkbox.dataset.path === path && checkbox.dataset.type === type
            );
            const anchorIndex = this.treeSelectionAnchor
                ? checkboxes.findIndex(checkbox =>
                    checkbox.dataset.path === this.treeSelectionAnchor.path
                    && checkbox.dataset.type === this.treeSelectionAnchor.type
                )
                : -1;

            if (anchorIndex < 0 || targetIndex < 0) {
                this.setTreeItemSelected(path, type, selected);
                this.treeSelectionAnchor = { path, type };
                return;
            }

            const start = Math.min(anchorIndex, targetIndex);
            const end = Math.max(anchorIndex, targetIndex);
            for (const checkbox of checkboxes.slice(start, end + 1)) {
                this.setTreeItemSelected(checkbox.dataset.path, checkbox.dataset.type, selected);
            }
        },

        handleTreeCheckboxClick(checkbox, event) {
            event.stopPropagation();
            if (event.shiftKey) {
                this.selectTreeItemRange(checkbox.dataset.path, checkbox.dataset.type, checkbox.checked);
                return;
            }
            this.setTreeItemSelected(checkbox.dataset.path, checkbox.dataset.type, checkbox.checked);
            this.treeSelectionAnchor = {
                path: checkbox.dataset.path,
                type: checkbox.dataset.type,
            };
        },

        renderTreeSelectCheckbox(path, type) {
            if (!this.treeSelectionMode) return '';
            const checked = this.selectedTreeItems.some(item => item.path === path && item.type === type);
            const label = this.escapeHtmlAttr(this.t('sidebar.select_item', { name: path }));
            return `<input type="checkbox" class="tree-select-checkbox" data-path="${this.escapeHtmlAttr(path)}" data-type="${type}" aria-label="${label}" ${checked ? 'checked' : ''} onclick="window.$root.handleTreeCheckboxClick(this, event)" style="width: 14px; height: 14px; flex: 0 0 14px; accent-color: var(--accent-primary); cursor: pointer;">`;
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
        
        // =====================================================================
        // DATA-ATTRIBUTE BASED HANDLERS
        // These read path/name/type from data-* attributes, avoiding JS escaping issues
        // =====================================================================
        
        // Escape strings for HTML attributes (simpler than JS escaping)
        escapeHtmlAttr(str) {
            if (!str) return '';
            return str
                .replace(/&/g, '&amp;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        },
        
        // Folder handlers - read from dataset
        handleFolderClick(el, event) {
            if (this.treeSelectionMode) {
                const path = el.dataset.path;
                if (event && event.shiftKey) {
                    this.selectTreeItemRange(path, 'folder', true);
                } else {
                    this.toggleTreeItemSelection(path, 'folder');
                }
                return;
            }
            this.toggleFolder(el.dataset.path);
        },
        handleFolderDragOver(el, event) {
            // Only sidebar items can be moved between folders. Ignoring other
            // drags (OS files) leaves the folder a non-drop target instead of
            // swallowing the drop and doing nothing.
            if (!this.draggedItem) return;
            event.preventDefault();
            // A leftover 'editor' target (from dragging across the editor)
            // must not make onFolderDrop ignore this drop.
            this.dropTarget = null;
            this.dragOverFolder = el.dataset.path;
            el.classList.add('drag-over');
        },
        handleFolderDragLeave(el) {
            this.dragOverFolder = null;
            el.classList.remove('drag-over');
        },
        handleFolderDrop(el, event) {
            // preventDefault marks the drop as handled; without it the browser
            // applies its default action to the dragged item.
            event.preventDefault();
            event.stopPropagation();
            el.classList.remove('drag-over');
            this.dragOverFolder = null;
            this.onFolderDrop(el.dataset.path);
        },
        handleNewItemClick(el, event) {
            event.stopPropagation();
            this.dropdownTargetFolder = el.dataset.path;
            this.toggleNewDropdown(event);
        },
        handleRenameFolderClick(el, event) {
            event.stopPropagation();
            this.renameFolder(el.dataset.path, el.dataset.name);
        },
        handleDeleteFolderClick(el, event) {
            event.stopPropagation();
            this.deleteFolder(el.dataset.path, el.dataset.name);
        },
        
        // Item (note/media) handlers - read from dataset
        handleItemClick(el, event) {
            if (this.treeSelectionMode) {
                const path = el.dataset.path;
                const type = el.dataset.type || 'note';
                if (event && event.shiftKey) {
                    this.selectTreeItemRange(path, type, true);
                } else {
                    this.toggleTreeItemSelection(path, type);
                }
                return;
            }
            this.openItem(el.dataset.path, el.dataset.type);
        },
        handleDeleteItemClick(el, event) {
            event.stopPropagation();
            if (el.dataset.type !== 'note') {
                this.deleteMedia(el.dataset.path);
            } else {
                this.deleteNote(el.dataset.path, el.dataset.name);
            }
        },
        handleRenameMediaClick(el, event) {
            event.stopPropagation();
            this.renameMedia(el.dataset.path);
        },
        
        // =====================================================================
        // FOLDER TREE RENDERING
        // =====================================================================
        
        // Render folder recursively (helper for deep nesting)
        // Uses data-* attributes to store path/name, avoiding JS string escaping issues
        renderFolderRecursive(folder) {
            if (!folder) return '';
            
            let html = '';
            const isExpanded = this.expandedFolders.has(folder.path);
            const esc = (s) => this.escapeHtmlAttr(s); // Shorthand for HTML escaping
            const isEmpty = folder.notes.length === 0 &&
                (!folder.children || Object.keys(folder.children).length === 0);
            
            // Render this folder's header
            // Note: Using native event handlers with data-* attributes instead of Alpine directives
            // because x-html doesn't process Alpine directives in dynamically generated content
            html += `
                <div>
                    <div 
                        data-path="${esc(folder.path)}"
                        data-name="${esc(folder.name)}"
                        draggable="true"
                        ondragstart="window.$root.onItemDragStart(this.dataset.path, 'folder', event)"
                        ondragend="window.$root.onItemDragEnd()"
                        ondragover="window.$root.handleFolderDragOver(this, event)"
                        ondragenter="window.$root.handleFolderDragOver(this, event)"
                        ondragleave="window.$root.handleFolderDragLeave(this)"
                        ondrop="window.$root.handleFolderDrop(this, event)"
                        onclick="window.$root.handleFolderClick(this, event)"
                        class="tree-row folder-item tree--folder${isExpanded ? ' is-expanded' : ''}"
                        title="${esc(folder.path)}"
                    >
                        ${this.renderTreeSelectCheckbox(folder.path, 'folder')}
                        <span class="tree-chevron${isExpanded ? ' is-open' : ''}" aria-hidden="true" style="${this.treeSelectionMode ? 'display:none;' : ''}">
                            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l4 4-4 4V4z"/></svg>
                        </span>
                        ${treeIconSvg('folder')}
                        <span class="tree-label">${esc(folder.name)}${isEmpty ? `<span class="tree-empty">(${esc(this.t('folders.empty'))})</span>` : ''}</span>
                        <span class="tree-actions hover-buttons" onclick="event.stopPropagation()">
                            <button 
                                data-path="${esc(folder.path)}"
                                onclick="window.$root.handleNewItemClick(this, event)"
                                class="tree-action"
                                title="${esc(this.t('sidebar.new_note'))}"
                            >+</button>
                            <button 
                                data-path="${esc(folder.path)}"
                                data-name="${esc(folder.name)}"
                                onclick="window.$root.handleRenameFolderClick(this, event)"
                                class="tree-action"
                                title="${esc(this.t('sidebar.rename_folder'))}"
                            >
                                <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 20h9"></path>
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>
                                </svg>
                            </button>
                            <button 
                                data-path="${esc(folder.path)}"
                                data-name="${esc(folder.name)}"
                                onclick="window.$root.handleDeleteFolderClick(this, event)"
                                class="tree-action tree-action--danger"
                                title="${esc(this.t('sidebar.delete_folder'))}"
                            >
                                <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                                </svg>
                            </button>
                        </span>
                    </div>
            `;
            
            // If expanded, render folder contents (child folders + notes)
            if (isExpanded) {
                html += `<div class="folder-contents">`;
                
                // First, render child folders (if any)
                if (folder.children && Object.keys(folder.children).length > 0) {
                    const children = Object.entries(folder.children)
                        .filter(([k, v]) => !this.hideUnderscoreFolders || !v.name.startsWith('_'))
                        .sort((a, b) => this.getFolderSortComparator()(a[1], b[1]));

                    children.forEach(([childKey, childFolder]) => {
                        html += this.renderFolderRecursive(childFolder);
                    });
                }
                
                // Then, render notes and images in this folder (after subfolders)
                if (folder.notes && folder.notes.length > 0) {
                    folder.notes.forEach(note => {
                        html += this.renderNoteItem(note);
                    });
                }
                
                html += `</div>`; // Close folder-contents
            }
            
            html += `</div>`; // Close folder wrapper
            return html;
        },
        
        // Render a single note/media item (used by both folders and root level)
        renderNoteItem(note) {
            const esc = (s) => this.escapeHtmlAttr(s);
            const isMediaFile = note.type !== 'note';
            const isCurrentNote = this.currentNote === note.path;
            const isCurrentMedia = this.currentMedia === note.path;
            const isCurrent = isMediaFile ? isCurrentMedia : isCurrentNote;

            // .md -> blue document, .pdf -> red document, media gets its own
            // stroked icon (image/audio/video) so rows stay visually consistent.
            const kind = treeIconKind(note.type);
            const icon = kind ? treeIconSvg(kind) : this.getMediaIcon(note.type);
            // PDFs are the one media type that gets an inline rename button in
            // the sidebar (notes are renamed from the editor toolbar).
            const isPdf = kind === 'pdf' || /\.pdf$/i.test(note.path);
            // Media rows show their extension: the name is stored without one,
            // so "orcamento" alone would not tell a PDF from a note.
            const extMatch = isMediaFile ? note.path.match(/\.[^./]+$/) : null;
            const ext = extMatch ? extMatch[0] : '';
            const deleteTitle = !isMediaFile
                ? this.t('toolbar.delete_note')
                : this.t('toolbar.delete_image');
            
            return `
                <div 
                    data-path="${esc(note.path)}"
                    data-name="${esc(note.name)}"
                    data-type="${note.type}"
                    draggable="true"
                    ondragstart="window.$root.onItemDragStart(this.dataset.path, this.dataset.type || 'note', event)"
                    ondragend="window.$root.onItemDragEnd()"
                    onclick="window.$root.handleItemClick(this, event)"
                    class="tree-row note-item ${treeKindClass(kind)}${isPdf ? ' note-item--has-rename' : ''}${isCurrent ? ' tree-active active' : ''}"
                    title="${esc(note.path)}"
                    style="${isCurrent ? 'background-color: var(--accent-light); color: var(--accent-primary);' : ''}"
                >
                    ${this.renderTreeSelectCheckbox(note.path, note.type)}
                    <span class="tree-indent" aria-hidden="true" style="${this.treeSelectionMode ? 'display:none;' : ''}"></span>
                    ${icon}
                    <span class="tree-label">${esc(note.name)}${ext ? `<span class="tree-ext">${esc(ext)}</span>` : ''}</span>
                    ${isPdf ? `
                    <button 
                        data-path="${esc(note.path)}"
                        onclick="window.$root.handleRenameMediaClick(this, event)"
                        class="note-rename-btn tree-action"
                        style="opacity: 0;"
                        title="${esc(this.t('media.rename'))}"
                    >
                        <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 20h9"></path>
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>
                        </svg>
                    </button>` : ''}
                    <button 
                        data-path="${esc(note.path)}"
                        data-name="${esc(note.name)}"
                        data-type="${note.type}"
                        onclick="window.$root.handleDeleteItemClick(this, event)"
                        class="note-delete-btn tree-action tree-action--danger"
                        style="opacity: 0;"
                        title="${esc(deleteTitle)}"
                    >
                        <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                        </svg>
                    </button>
                </div>
            `;
        },
        
        // Render root-level items (notes and media not in any folder)
        renderRootItems() {
            const root = this.folderTree['__root__'];
            if (!root || !root.notes || root.notes.length === 0) {
                return '';
            }
            return root.notes.map(note => this.renderNoteItem(note)).join('');
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
