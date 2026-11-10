// App bootstrap: application lifecycle, server config, and URL routing.
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import * as api from '../core/api.js';
import { createOfflineStore } from '../lib/offline-store.js';
import { setAppRoot } from './root.js';
import { createLocalSettings } from './local-settings.js';
import { createLocalization } from './localization.js';
import { createThemeSettings } from './theme-settings.js';

// IndexedDB open can be blocked (another tab holding an older schema). Cap the
// wait so startup and offline fallbacks never hang on it: the store keeps
// opening in the background and later calls can still use it.
const OFFLINE_OPEN_TIMEOUT_MS = 5000;

export function createBootstrap() {
    return {
        ...createLocalSettings(),
        ...createLocalization(),
        ...createThemeSettings(),
        
        // Initialize app
        async init() {
            // Publish the reactive root before nested panel components
            // initialize: Alpine walks the tree top-down, so every panel's
            // init() (see panel-scope.js) can delegate to this object.
            setAppRoot(this);

            // Prevent double initialization (Alpine.js may call x-init twice in some cases)
            if (window.__noteapp_initialized) return;
            window.__noteapp_initialized = true;
            
            // Store global reference for native event handlers in x-html content
            window.$root = this;

            // Hover cards for internal links in the preview
            this.initLinkPreviews();
            
            // ESC key to cancel drag operations
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.draggedItem) {
                    this.cancelDrag();
                }
            });
            
            await this.loadConfig();
            await this.loadThemes();
            await this.initTheme();
            await this.loadAvailableLocales();
            // Note: Translations are inlined into index.html before Alpine init (see index.html)
            // loadLocale() is only called when user changes language from settings
            // Hydrate persisted settings before the first tree render, so
            // sortMode, hideUnderscoreFolders and viewMode do not flash the
            // defaults and then switch once the API data arrives.
            this.loadLocalSettings();
            // Start IndexedDB in the background: startup must not wait for it,
            // and the online paths only write to it after the response arrives.
            this._initOffline();
            await this.loadNotes();

            // Reconcile queued edits before opening the note from the URL:
            // otherwise the editor would show the pre-offline version and the
            // replay would overwrite it on the server moments later.
            if (this.isOnline) await this._syncPendingSaves();

            // Parse URL and load specific note if provided
            this.loadItemFromURL();
            
            // Set initial homepage state ONLY if we're actually on the homepage
            if (window.location.pathname === '/') {
                window.history.replaceState({ homepageFolder: '' }, '', '/');
                document.title = this.appName;
            }
            
            // Listen for browser back/forward navigation
            window.addEventListener('popstate', (e) => {
                if (e.state && e.state.notePath) {
                    // Navigating to a note
                    const searchQuery = e.state.searchQuery || '';
                    const targetLine = e.state.targetLine || null;
                    const targetColumn = e.state.targetColumn || null;
                    this.exactSearchMatch = e.state.exactSearchMatch !== false;
                    this.loadNote(e.state.notePath, false, searchQuery, targetLine, targetColumn); // false = don't update history
                    
                    // Update search box and trigger search if needed
                    if (searchQuery) {
                        this.searchQuery = searchQuery;
                        this.searchNotes();
                    } else {
                        this.searchQuery = '';
                        this.searchResults = [];
                        this.expandedSearchResults = {};
                        this.clearSearchHighlights();
                    }
                } else if (e.state && e.state.mediaPath) {
                    // Navigating to a media file
                    this.viewMedia(e.state.mediaPath, null, false);
                } else {
                    // Navigating back to homepage
                    this._resetNoteState();
                    
                    // Restore homepage folder state if it was saved
                    if (e.state && e.state.homepageFolder !== undefined) {
                        this.selectedHomepageFolder = e.state.homepageFolder || '';
                    } else {
                        // No folder state in history, go to root
                        this.selectedHomepageFolder = '';
                    }
                    
                    // Invalidate cache to force recalculation
                    this._homepageCache = {
                        folderPath: null,
                        notes: null,
                        folders: null,
                        breadcrumb: null
                    };
                    
                    // Clear search
                    this.searchQuery = '';
                    this.searchResults = [];
                    this.expandedSearchResults = {};
                    this.clearSearchHighlights();
                }
            });
            
            // Cache DOM references after initial render
            this.$nextTick(() => {
                this.refreshDOMCache();
            });
            
            // Setup mobile view mode handler
            this.setupMobileViewMode();
            
            // Watch view mode changes and auto-save
            this.$watch('viewMode', (newValue) => {
                this.saveViewMode();
                // Suppress scroll-position stores while Alpine toggles the
                // panes' visibility: for a few ms after the switch the pane
                // that is going away can still fire scroll events from a
                // degenerate layout (width 0), and the bogus editorPct they
                // produce is applied to the editor by _restoreNoteScroll(),
                // which is what made the editor jump to the end of the note.
                this._viewModeSwitching = true;
                // Re-apply the saved scroll position to whichever pane just became visible.
                // x-show toggles display:none/block; an overflow:auto element resets its
                // scrollTop on that transition, so the previously-hidden pane lands at 0
                // unless we explicitly restore. $nextTick waits for Alpine to flush the
                // x-show change, the rAF then waits for layout so scrollHeight is valid.
                this.$nextTick(() => {
                    requestAnimationFrame(() => {
                        this._restoreNoteScroll();
                        if (newValue !== 'edit') this.fitMarkmap();
                        // One more frame: lets any scroll event emitted by the
                        // layout settle pass through while still suppressed.
                        requestAnimationFrame(() => {
                            this._viewModeSwitching = false;
                        });
                    });
                });
            });

            this.$watch('currentTheme', () => this.updateMarkmapTheme(this._markmapSvg));
            
            // Watch for changes in note content to re-apply search highlights
            this.$watch('noteContent', () => {
                if (this.currentSearchHighlight) {
                    // Re-apply highlights after content changes (with small delay for render)
                    this.$nextTick(() => {
                        setTimeout(() => {
                            this._reapplySearchHighlights();
                        }, 50);
                    });
                }
                // Re-render the markdown preview when content changes
                this.schedulePreviewRender();
            });
            
            // Re-render preview when the note changes (e.g., user navigates)
            this.$watch('currentNote', () => {
                this.schedulePreviewRender();
            });
            
            // Watch favorites expanded state and save to localStorage
            this.$watch('favoritesExpanded', () => {
                this.saveFavoritesExpanded();
            });
            
            // Setup keyboard shortcuts (only once to prevent double triggers)
            if (!window.__noteapp_shortcuts_initialized) {
                window.__noteapp_shortcuts_initialized = true;
                window.addEventListener('keydown', (e) => {
                    // Use e.key (not e.code) for letter keys to support non-QWERTY keyboard layouts
                    
                    // Ctrl/Cmd + S to save the current note
                    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                        e.preventDefault();
                        this.saveNote();
                    }
                    
                    // Ctrl/Cmd + Alt + P for Quick Switcher
                    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'p') {
                        e.preventDefault();
                        this.openQuickSwitcher();
                        return;
                    }
                    
                    // Ctrl/Cmd + Alt/Option + N for new note
                    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'n') {
                        e.preventDefault();
                        this.createNote();
                    }
                    
                    // Ctrl/Cmd + Alt/Option + F for new folder
                    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'f') {
                        e.preventDefault();
                        this.createFolder();
                    }
                    
                    const target = e.target;
                    const isOtherEditableTarget = target?.isContentEditable
                        || (['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName)
                            && !(target.tagName === 'TEXTAREA' && target.id === 'note-editor'));

                    // Keep the browser's native undo/redo for other editable fields.
                    if (!isOtherEditableTarget && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
                        e.preventDefault();
                        this.undo();
                    }
                    
                    // Ctrl/Cmd + Y OR Ctrl/Cmd+Shift+Z for redo
                    if (!isOtherEditableTarget && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
                        e.preventDefault();
                        this.redo();
                    }
                    if (!isOtherEditableTarget && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
                        e.preventDefault();
                        this.redo();
                    }
                    
                    // F3 for next search match
                    if (e.code === 'F3' && !e.shiftKey) {
                        e.preventDefault();
                        this.nextMatch();
                    }
                    
                    // Shift + F3 for previous search match
                    if (e.code === 'F3' && e.shiftKey) {
                        e.preventDefault();
                        this.previousMatch();
                    }
                    
                    // Ctrl/Cmd + Alt/Option + Z to toggle Zen mode.
                    // Global (fires regardless of focus) so users can enter/exit Zen without
                    // first clicking into the editor. Requires an open note; noop otherwise.
                    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'z') {
                        if (this.currentNote) {
                            e.preventDefault();
                            this.toggleZenMode();
                        }
                    }
                    
                    // View-mode shortcuts (global — fire regardless of focus):
                    //   Ctrl/Cmd + Alt/Option + 1  → Edit
                    //   Ctrl/Cmd + Alt/Option + 2  → Split  (falls back to Edit on mobile)
                    //   Ctrl/Cmd + Alt/Option + 3  → Preview
                    //   Ctrl/Cmd + Alt/Option + V  → Cycle Edit → Split → Preview → Edit
                    // Skipped when no note is open, in Zen mode (edit-only), or while the graph
                    // overlay is showing. Uses e.code for digits so the physical top-row keys
                    // fire on AZERTY/QWERTZ layouts (where 1/2/3 need Shift) and to bypass
                    // Mac's Option+digit dead-key composer (Option+1 = ¡, etc.).
                    if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey
                        && this.currentNote && !this.zenMode && !this.showGraph) {
                        const isMobile = window.innerWidth <= 768;
                        let targetMode = null;
                        if (e.code === 'Digit1') {
                            targetMode = 'edit';
                        } else if (e.code === 'Digit2') {
                            targetMode = isMobile ? 'edit' : 'split';
                        } else if (e.code === 'Digit3') {
                            targetMode = 'preview';
                        } else if (e.key.toLowerCase() === 'v') {
                            if (isMobile) {
                                targetMode = this.viewMode === 'edit' ? 'preview' : 'edit';
                            } else {
                                const order = ['edit', 'split', 'preview'];
                                const currentIdx = order.indexOf(this.viewMode);
                                targetMode = order[(currentIdx + 1) % order.length];
                            }
                        }
                        if (targetMode !== null) {
                            e.preventDefault();
                            this.viewMode = targetMode;
                        }
                    }
                    
                    // Only apply markdown shortcuts when editor is focused and a note is open
                    const isEditorFocused = document.activeElement?.id === 'note-editor';
                    if (isEditorFocused && this.currentNote) {
                        // Ctrl/Cmd + B for bold
                        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
                            e.preventDefault();
                            this.wrapSelection('**', '**', 'bold text');
                        }
                        
                        // Ctrl/Cmd + I for italic
                        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
                            e.preventDefault();
                            this.wrapSelection('*', '*', 'italic text');
                        }
                        
                        // Ctrl/Cmd + K for link
                        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                            e.preventDefault();
                            this.insertLink();
                        }
                        
                        // Ctrl/Cmd + Alt/Option + T for table
                        if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 't') {
                            e.preventDefault();
                            this.insertTable();
                        }
                    }
                    
                    // Escape to exit Zen mode (works anywhere)
                    if (e.key === 'Escape' && this.zenMode) {
                        e.preventDefault();
                        this.toggleZenMode();
                    }
                });
            }
            
            // Note: setupScrollSync() is called when a note is loaded (see loadNote())
            
            // Listen for system theme changes
            if (window.matchMedia) {
                window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
                    if (this.currentTheme === 'system') {
                        this.applyTheme('system');
                    }
                });
            }
            
            // Listen for fullscreen changes (to sync zen mode state)
            document.addEventListener('fullscreenchange', () => {
                if (!document.fullscreenElement && this.zenMode) {
                    // User exited fullscreen manually, exit zen mode too
                    this.zenMode = false;
                    this.viewMode = this.previousViewMode;
                }
            });
            
            // Toasts from ErrorHandler and code paths without Alpine `this`
            if (!window.__noteapp_toast_listener) {
                window.__noteapp_toast_listener = true;
                window.addEventListener('notediscovery:toast', (e) => {
                    const d = e.detail || {};
                    if (typeof d.message !== 'string' || !d.message) return;
                    this.toast(d.message, {
                        type: d.type || 'error',
                        durationMs: d.durationMs
                    });
                });
            }
        },
        
        // Create the shared IndexedDB store (once) and subscribe to the
        // browser's connectivity events. Opening is asynchronous; startup only
        // waits for it through _offlineReady(), which is time-boxed.
        _initOffline() {
            if (!this._offlineStore) {
                this._offlineStore = createOfflineStore();
            }
            if (!this._offlineStorePromise) {
                this._offlineStorePromise = this._offlineStore.open().then((ok) => {
                    this.offlineAvailable = ok;
                    return ok;
                });
                this._offlineStorePromise.then((ok) => {
                    if (ok) this._refreshPendingSaveCount();
                });
            }
            if (!this._offlineListenersBound && typeof window !== 'undefined') {
                this._offlineListenersBound = true;
                window.addEventListener('online', () => {
                    this.isOnline = true;
                    this.offlineMode = false;
                    this._syncPendingSaves();
                });
                window.addEventListener('offline', () => {
                    this.isOnline = false;
                    // Nothing can be replayed until the connection returns;
                    // drop the pending retry so it does not wake up in vain.
                    if (this._offlineSyncRetryTimer) {
                        clearTimeout(this._offlineSyncRetryTimer);
                        this._offlineSyncRetryTimer = null;
                    }
                });
            }
            return this._offlineStorePromise;
        },

        // Resolves to the store when IndexedDB is usable, or null. Callers must
        // treat null as "online only" and keep working. Bounded by a timeout so
        // a blocked open cannot stall startup or the offline fallback.
        async _offlineReady() {
            if (!this._offlineStorePromise) this._initOffline();
            let timer;
            const timeout = new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), OFFLINE_OPEN_TIMEOUT_MS);
            });
            try {
                const ok = await Promise.race([this._offlineStorePromise, timeout]);
                return ok ? this._offlineStore : null;
            } finally {
                clearTimeout(timer);
            }
        },

        async _refreshPendingSaveCount() {
            const store = await this._offlineReady();
            if (!store) {
                this.pendingSaveCount = 0;
                return;
            }
            try {
                this.pendingSaveCount = await store.pendingCount();
                if (this.pendingSaveCount === 0 && this._offlineSyncRetryTimer) {
                    clearTimeout(this._offlineSyncRetryTimer);
                    this._offlineSyncRetryTimer = null;
                }
            } catch (_) {
                // A transient IndexedDB error must not surface as a save error.
            }
        },

        // Load app configuration
        async loadConfig() {
            try {
                const config = await api.getJSON('/api/config');
                this.appName = config.name;
                this.appVersion = config.version || '0.0.0';
                this.authEnabled = config.authentication?.enabled || false;
                this.demoMode = config.demoMode || false;
                this.alreadyDonated = config.alreadyDonated || false;
                // Server already clamps autosaveDelayMs to a sane range; we just sanity-check the type.
                if (Number.isFinite(config.autosaveDelayMs) && config.autosaveDelayMs > 0) {
                    this.autosaveDelayMs = config.autosaveDelayMs;
                }
                if (typeof config.defaultTheme === 'string' && config.defaultTheme) {
                    this.defaultTheme = config.defaultTheme;
                }
                if (Number.isFinite(config.uploadMaxNoteMb) && config.uploadMaxNoteMb > 0) {
                    this.uploadMaxNoteMb = config.uploadMaxNoteMb;
                }
                if (typeof config.todoKeywords === 'string') {
                    this.todoKeywords = config.todoKeywords;
                }
                if (config.ntfy && typeof config.ntfy === 'object') {
                    this.ntfyConfig = {
                        ...this.ntfyConfig,
                        enabled: config.ntfy.enabled === true,
                        serverUrl: config.ntfy.serverUrl || 'https://ntfy.sh',
                        topic: config.ntfy.topic || '',
                        captureDir: config.ntfy.captureDir || 'Captura',
                        tags: Array.isArray(config.ntfy.tags) && config.ntfy.tags.length
                            ? config.ntfy.tags.join(', ')
                            : 'ntfy',
                        username: config.ntfy.username || '',
                        passwordConfigured: config.ntfy.passwordConfigured === true,
                        password: '',
                        clearPassword: false,
                    };
                }
            } catch (error) {
                console.error('Failed to load config:', error);
            }
        },

        async saveNtfyConfig() {
            if (this.ntfyConfig.saving) return;
            this.ntfyConfig.saving = true;
            try {
                const result = await api.sendJSON('/api/ntfy/config', 'POST', {
                    enabled: this.ntfyConfig.enabled,
                    serverUrl: this.ntfyConfig.serverUrl,
                    topic: this.ntfyConfig.topic,
                    username: this.ntfyConfig.username,
                    password: this.ntfyConfig.password,
                    clearPassword: this.ntfyConfig.clearPassword,
                    captureDir: this.ntfyConfig.captureDir,
                    tags: this.ntfyConfig.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
                });
                this.ntfyConfig.passwordConfigured = result.passwordConfigured;
                this.ntfyConfig.password = '';
                this.ntfyConfig.clearPassword = false;
                this.ntfyConfig.username = result.username;
                this.ntfyConfig.tags = result.tags.join(', ');
                this.toast(this.t('settings.ntfy_saved'), { type: 'success' });
            } catch (error) {
                this.toast(error.detail || error.message || this.t('settings.ntfy_save_failed'), { type: 'error' });
            } finally {
                this.ntfyConfig.saving = false;
            }
        },
        
        // Load item (note or media) from URL path
        loadItemFromURL() {
            // Get path from URL (e.g., /folder/note or /folder/image.png)
            let path = window.location.pathname;
            
            // Strip .md extension if present (for MKdocs/Zensical integration)
            if (path.toLowerCase().endsWith('.md')) {
                path = path.slice(0, -3);
                // Update URL bar to show clean path without .md
                window.history.replaceState(null, '', path);
            }
            
            // Skip if root path or static assets
            if (path === '/' || path.startsWith('/static/') || path.startsWith('/api/')) {
                return;
            }
            
            // Remove leading slash and decode URL encoding (e.g., %20 -> space)
            const decodedPath = decodeURIComponent(path.substring(1));
            
            // Check if this is a media file (image, audio, video, PDF)
            const matchedItem = this.notes.find(n => n.path === decodedPath);
            
            if (matchedItem && matchedItem.type !== 'note') {
                // It's a media file, view it
                this.viewMedia(decodedPath, matchedItem.type, false); // false = don't update history
            } else {
                // It's a note, add .md extension and load it
                const notePath = decodedPath + '.md';
                
                // Parse query string for search parameter and optional line anchor
                const urlParams = new URLSearchParams(window.location.search);
                const searchParam = urlParams.get('search');
                this.exactSearchMatch = urlParams.get('whole_word') !== 'false';
                const lineParam = parseInt(urlParams.get('line') || '', 10);
                const targetLine = Number.isFinite(lineParam) && lineParam > 0 ? lineParam : null;
                const colParam = parseInt(urlParams.get('col') || '', 10);
                const targetColumn = Number.isFinite(colParam) && colParam > 0 ? colParam : null;
                
                // Try to load the note directly - the backend will handle 404 if it doesn't exist
                // This is more robust than checking the frontend notes list
                this.loadNote(notePath, false, searchParam || '', targetLine, targetColumn);
                
                // If there's a search parameter, populate the search box and trigger search
                if (searchParam) {
                    this.searchQuery = searchParam;
                    // Trigger search to populate results list
                    this.searchNotes();
                }
            }
        },
    };
}
