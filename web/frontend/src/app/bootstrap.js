// App bootstrap: init, config, theme, locale and settings, toasts.
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import { CONFIG, LOCAL_SETTINGS } from '../core/config.js';
import { ErrorHandler, encodeVaultPath, FilenameValidator } from '../core/utils.js';
import * as api from '../core/api.js';
import { readLocalSettings, saveSetting } from '../core/settings.js';
import { translate } from '../core/i18n.js';
import { setAppRoot } from './root.js';

export function createBootstrap() {
    return {
        
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
            await this.loadNotes();
            
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
                });
                this.ntfyConfig.passwordConfigured = result.passwordConfigured;
                this.ntfyConfig.password = '';
                this.ntfyConfig.clearPassword = false;
                this.ntfyConfig.username = result.username;
                this.toast(this.t('settings.ntfy_saved'), { type: 'success' });
            } catch (error) {
                this.toast(error.detail || error.message || this.t('settings.ntfy_save_failed'), { type: 'error' });
            } finally {
                this.ntfyConfig.saving = false;
            }
        },
        
        // Load available themes from backend
        async loadThemes() {
            try {
                const data = await api.getJSON('/api/themes');
                
                // Theme names are plain text; the optional icon field is not
                // rendered in the select because a native <option> cannot hold SVG.
                this.availableThemes = data.themes;
            } catch (error) {
                console.error('Failed to load themes:', error);
                // Fallback to default themes
                this.availableThemes = [
                    { id: 'light', name: 'Light' },
                    { id: 'dark', name: 'Dark' }
                ];
            }
        },
        
        // Initialize theme system
        async initTheme() {
            // A user's saved preference takes priority over the configured default.
            const savedTheme = localStorage.getItem('noteDiscoveryTheme') || this.defaultTheme;
            this.currentTheme = savedTheme;
            await this.applyTheme(savedTheme);
        },
        
        // Set and apply theme
        async setTheme(themeId) {
            this.currentTheme = themeId;
            saveSetting('noteDiscoveryTheme', themeId);
            await this.applyTheme(themeId);
        },
        
        // Syntax highlighting toggle
        toggleSyntaxHighlight() {
            this.syntaxHighlightEnabled = !this.syntaxHighlightEnabled;
            saveSetting('syntaxHighlightEnabled', this.syntaxHighlightEnabled, LOCAL_SETTINGS);
            if (this.syntaxHighlightEnabled) {
                this.updateSyntaxHighlight();
            }
        },
        
        // Load all localStorage settings at once using centralized config
        loadLocalSettings() {
            // core/settings.js validates each entry and falls back to the
            // declared default, so a corrupted value never reaches the UI.
            Object.assign(this, readLocalSettings(LOCAL_SETTINGS));

            // Special case: favorites also needs to update the Set for O(1) lookups
            this.favoritesSet = new Set(this.favorites);
        },
        
        // Readable line length toggle (for preview max-width)
        toggleReadableLineLength() {
            this.readableLineLength = !this.readableLineLength;
            saveSetting('readableLineLength', this.readableLineLength, LOCAL_SETTINGS);
        },
        
        // Hide underscore folders toggle (sidebar tree and graph)
        toggleHideUnderscoreFolders() {
            this.hideUnderscoreFolders = !this.hideUnderscoreFolders;
            saveSetting('hideUnderscoreFolders', this.hideUnderscoreFolders, LOCAL_SETTINGS);
            if (this.showGraph) {
                this.initGraph();
            }
        },

        // Tab inserts tab toggle (Tab key inserts tab character instead of changing focus)
        toggleTabInsertsTab() {
            this.tabInsertsTab = !this.tabInsertsTab;
            saveSetting('tabInsertsTab', this.tabInsertsTab, LOCAL_SETTINGS);
        },

        // Behavior of the "+" (new note) button: chooser, note or folder.
        persistNewButtonAction() {
            saveSetting('newButtonAction', this.newButtonAction, LOCAL_SETTINGS);
        },

        // Pre-fill a new note's title with a timestamp.
        toggleAutoFillNoteTitle() {
            this.autoFillNoteTitle = !this.autoFillNoteTitle;
            saveSetting('autoFillNoteTitle', this.autoFillNoteTitle, LOCAL_SETTINGS);
        },

        // Hide / show only the sidebar PANEL (files, search, outline, etc.); the icon rail
        // stays put so users can still switch panels with one click after re-expanding.
        // Width is animated via CSS; sidebarWidth itself is intentionally NOT touched, so a
        // user's custom drag-resized width is restored automatically on expand.
        toggleSidebarPanel() {
            this.sidebarPanelCollapsed = !this.sidebarPanelCollapsed;
            saveSetting('sidebarPanelCollapsed', this.sidebarPanelCollapsed, LOCAL_SETTINGS);
        },

        // Switch the active sidebar panel (Files / Search / Tags / Outline / Backlinks
        // / Settings) with smart toggle behaviour for the icon rail:
        //
        //   collapsed       + click any icon X  → expand + switch to X
        //   expanded, on Y  + click icon X      → switch to X (no collapse change)
        //   expanded, on X  + click icon X      → collapse (symmetric "click active to close")
        //
        // That third rule matches the VS Code / Cursor / JetBrains / Obsidian convention where
        // re-clicking the active sidebar icon hides the panel. Without it, the only way to
        // collapse would be the dedicated toggle button, which is fine but leaves an asymmetry.
        //
        // On mobile (≤768px) the desktop collapse is CSS-overridden, so the panel is always
        // visible; we deliberately skip toggling in that case so a one-off mobile tap doesn't
        // silently clear the user's persisted desktop preference.
        openSidebarPanel(panelName) {
            const isDesktop = window.innerWidth > 768;
            if (panelName === 'todos' && this.activePanel !== 'todos') {
                this.loadTodos();
            }
            if (isDesktop && this.activePanel === panelName && !this.sidebarPanelCollapsed) {
                this.toggleSidebarPanel();
                return;
            }
            this.activePanel = panelName;
            if (isDesktop && this.sidebarPanelCollapsed) {
                this.toggleSidebarPanel();
            }
        },
        
        // Apply theme to document
        async applyTheme(themeId) {
            // index.html ships a blocking <link id="theme-stylesheet"> and an inline
            // head script that points it at the saved/default id and sets data-theme,
            // so on first load the CSS is already present and nothing is fetched.
            // Runtime changes just retarget the link (it blocks paint until the new
            // CSS arrives). The JSON fetch + #dynamic-theme style element remains as
            // a fallback for pages served without the link. Highlight.js is still
            // updated below either way, because the theme link only carries the app
            // theme CSS.
            try {
                const link = document.getElementById('theme-stylesheet');
                const styleEl = document.getElementById('dynamic-theme');
                const alreadyLoaded =
                    document.documentElement.getAttribute('data-theme') === themeId &&
                    (link !== null || (styleEl !== null && styleEl.textContent));

                if (!alreadyLoaded) {
                    if (link) {
                        // Retarget the existing stylesheet; no JSON round-trip needed.
                        link.href = '/api/themes/' + encodeURIComponent(themeId);
                        document.documentElement.setAttribute('data-theme', themeId);
                    } else {
                        const body = await api.getText(`/api/themes/${themeId}`);
                        // Accept both the JSON envelope {css: "..."} and raw CSS.
                        let css = body;
                        try {
                            css = JSON.parse(body).css;
                        } catch (_) {
                            // Raw CSS response; keep the body as-is
                        }

                        let el = styleEl;
                        if (!el) {
                            el = document.createElement('style');
                            el.id = 'dynamic-theme';
                            document.head.appendChild(el);
                        }
                        el.textContent = css;

                        document.documentElement.setAttribute('data-theme', themeId);
                    }
                }
                
                // Load appropriate Highlight.js theme for code syntax highlighting
                const highlightTheme = document.getElementById('highlight-theme');
                if (highlightTheme) {
                    if (themeId === 'light') {
                        highlightTheme.href = '/static/vendor/highlight.js/styles/github.min.css';
                    } else {
                        // Use dark theme for dark/custom themes
                        highlightTheme.href = '/static/vendor/highlight.js/styles/github-dark.min.css';
                    }
                }
                
                // Re-render Mermaid diagrams with new theme if there's a current note
                if (this.currentNote) {
                    // Small delay to allow theme CSS to load
                    setTimeout(() => {
                        // Clear existing Mermaid renders
                        const previewContent = document.querySelector('.markdown-preview');
                        if (previewContent) {
                            const mermaidContainers = previewContent.querySelectorAll('.mermaid-rendered');
                            mermaidContainers.forEach(container => {
                                // Replace with the original code block for re-rendering
                                const parent = container.parentElement;
                                if (parent && container.dataset.originalCode) {
                                    const pre = document.createElement('pre');
                                    const code = document.createElement('code');
                                    code.className = 'language-mermaid';
                                    code.textContent = container.dataset.originalCode;
                                    pre.appendChild(code);
                                    parent.replaceChild(pre, container);
                                }
                            });
                        }
                        // Re-render with new theme
                        this.renderMermaid();
                    }, 100);
                }
                
                // Refresh graph if visible (longer delay to ensure CSS is applied)
                if (this.showGraph) {
                    setTimeout(() => this.initGraph(), 300);
                }
                
                // Update PWA theme-color meta tag to match current theme
                const themeColorMeta = document.querySelector('meta[name="theme-color"]');
                if (themeColorMeta) {
                    // Get the accent color from CSS variables
                    const accentColor = getComputedStyle(document.documentElement)
                        .getPropertyValue('--accent-primary').trim() || '#7c3aed';
                    themeColorMeta.setAttribute('content', accentColor);
                }
            } catch (error) {
                console.error('Failed to load theme:', error);
            }
        },
        
        // ==================== INTERNATIONALIZATION ====================
        
        // Translation function - get translated string by key
        t(key, params = {}) {
            return translate(this.translations, key, params);
        },
        
        /**
         * Non-blocking toast (replaces window.alert). Types map to theme CSS variables.
         * @param {string} message
         * @param {{ type?: 'error'|'warning'|'info'|'success', durationMs?: number }} [options]
         * @returns {number|undefined} toast id
         */
        toast(message, options = {}) {
            if (typeof message !== 'string' || !message) return;
            const type = ['error', 'warning', 'info', 'success'].includes(options.type)
                ? options.type
                : 'info';
            let durationMs = options.durationMs;
            if (durationMs == null || typeof durationMs !== 'number' || durationMs < 0) {
                durationMs = type === 'error' ? CONFIG.TOAST_DURATION_ERROR_MS
                    : type === 'warning' ? CONFIG.TOAST_DURATION_WARNING_MS
                        : type === 'success' ? CONFIG.TOAST_DURATION_SUCCESS_MS
                            : CONFIG.TOAST_DURATION_INFO_MS;
            }
            const id = ++this._toastIdSeq;
            const entry = { id, message, type, _tid: null };
            this.toasts.push(entry);
            while (this.toasts.length > CONFIG.TOAST_MAX_VISIBLE) {
                const first = this.toasts.shift();
                if (first && first._tid) clearTimeout(first._tid);
            }
            entry._tid = setTimeout(() => this.dismissToast(id), durationMs);
            return id;
        },
        
        dismissToast(id) {
            const idx = this.toasts.findIndex((t) => t.id === id);
            if (idx === -1) return;
            const entry = this.toasts[idx];
            if (entry._tid) {
                clearTimeout(entry._tid);
                entry._tid = null;
            }
            this.toasts.splice(idx, 1);
        },
        
        /**
         * Get localized error message from FilenameValidator result
         * @param {object} validation - The validation result from FilenameValidator
         * @param {string} type - 'note' or 'folder'
         * @returns {string} Localized error message
         */
        getValidationErrorMessage(validation, type = 'note') {
            switch (validation.error) {
                case 'empty':
                    return type === 'note' 
                        ? this.t('notes.empty_name') 
                        : this.t('folders.invalid_name');
                case 'forbidden_chars':
                    return this.t('validation.forbidden_chars', { 
                        chars: validation.forbiddenChars 
                    });
                case 'reserved_name':
                    return this.t('validation.reserved_name');
                case 'invalid_dot':
                    return this.t('validation.invalid_dot');
                case 'trailing_dot_space':
                    return this.t('validation.trailing_dot_space');
                default:
                    return type === 'note' 
                        ? this.t('notes.invalid_name') 
                        : this.t('folders.invalid_name');
            }
        },
        
        // Load available locales from backend
        async loadAvailableLocales() {
            try {
                const data = await api.getJSON('/api/locales');
                this.availableLocales = data.locales || [];
            } catch (error) {
                console.error('Failed to load available locales:', error);
                this.availableLocales = [{ code: 'pt-BR', name: 'Português (Brasil)', flag: '🇧🇷' }];
            }
        },
        
        // Load translations for a specific locale
        async loadLocale(localeCode = null) {
            const targetLocale = localeCode || localStorage.getItem('locale') || 'pt-BR';
            
            try {
                // 404 means "fall back to pt-BR", so the status is inspected here.
                const response = await api.raw(`/api/locales/${targetLocale}`);
                if (response.ok) {
                    this.translations = await response.json();
                    this.currentLocale = targetLocale;
                    saveSetting('locale', targetLocale);
                } else if (targetLocale !== 'pt-BR') {
                    // Fallback to pt-BR if requested locale not found
                    await this.loadLocale('pt-BR');
                }
            } catch (error) {
                console.error('Failed to load locale:', error);
                // If pt-BR also fails, translations will be empty and t() will return keys
                if (targetLocale !== 'pt-BR') {
                    await this.loadLocale('pt-BR');
                }
            }
        },
        
        // Change locale and reload translations
        async changeLocale(localeCode) {
            await this.loadLocale(localeCode);
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
