// Component data fields (state.js).
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import { CONFIG, LOCAL_SETTINGS } from '../core/config.js';
import * as api from '../core/api.js';

export function createState() {
    return {
        // App state
        appName: 'Basalt',
        appVersion: '0.0.0',
        authEnabled: false,
        demoMode: false,
        alreadyDonated: false,
        autosaveDelayMs: CONFIG.AUTOSAVE_DELAY,  // hydrated from /api/config in loadConfig()
        defaultTheme: CONFIG.DEFAULT_THEME,      // hydrated from /api/config in loadConfig()
        uploadMaxNoteMb: CONFIG.UPLOAD_MAX_NOTE_MB, // hydrated from /api/config in loadConfig()
        ntfyConfig: {
            enabled: false,
            serverUrl: 'https://ntfy.sh',
            topic: '',
            captureDir: 'Captura',
            tags: 'ntfy',
            username: '',
            passwordConfigured: false,
            password: '',
            clearPassword: false,
            saving: false,
        },
        notes: [],
        treeSelectionMode: false,
        selectedTreeItems: [],
        treeSelectionAnchor: null,
        deletingSelectedTreeItems: false,

        // True while /api/notes is in flight. Drives the "Loading your vault…"
        // placeholder + the delayed overlay (notesLoadingShowOverlay).
        notesLoading: true,
        notesLoadingShowOverlay: false,
        _notesLoadingOverlayTimer: null,

        currentNote: '',
        currentNoteName: '',
        noteContent: '',
        viewMode: 'split', // 'edit', 'split', 'preview'
        searchQuery: '',
        exactSearchMatch: true,
        currentSearchExactMatch: true,
        todoKeywords: 'TODO, FIXME, LATER',
        todoKeywordsSaving: false,
        todos: [],
        expandedTodoNotes: {},
        todosLoading: false,
        todosLoaded: false,
        todosError: '',
        
        // Graph state (separate overlay, doesn't affect viewMode)
        showGraph: false,
        graphInstance: null,
        graphLoaded: false,
        graphEmpty: false,   // vault returned zero nodes — show the empty state
        graphError: '',      // non-empty: message shown instead of the canvas
        graphData: null,
        searchResults: [],
        currentSearchHighlight: '', // Track current highlighted search term
        _searchTargetAfterRender: null,
        currentMatchIndex: 0, // Current match being viewed
        totalMatches: 0, // Total number of matches in the note
        isSaving: false,
        lastSaved: false,
        noteBaseHash: null,        // Fingerprint of the current note as last read or written on disk

        // Single status shown in the editor toolbar. Alpine 3 has no x-else-if,
        // so the priority order lives here instead of in a template chain.
        get editorStatus() {
            if (!this.isOnline) return 'offline';
            if (this.syncingOfflineSaves) return 'syncing';
            if (this.pendingSaveCount > 0) return 'pending';
            if (this.noteFromCache) return 'cached';
            if (this.isSaving) return 'saving';
            if (this.lastSaved) return 'saved';
            if (this.lastEditedText) return 'edited';
            return '';
        },

        _saveControllerInstance: null, // lib/save-controller.js, created on first save

        // Offline cache and outbox (lib/offline-store.js). The store and its
        // opening promise live on the component so every slice can share one
        // connection. offlineAvailable is false when the browser has no
        // usable IndexedDB; the app then behaves exactly as before.
        isOnline: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
        offlineAvailable: false,
        offlineMode: false,        // sidebar data came from the cache
        noteFromCache: false,      // current editor buffer came from the cache
        pendingSaveCount: 0,
        syncingOfflineSaves: false,
        _offlineStore: null,
        _offlineStorePromise: null,
        _offlineListenersBound: false,
        _outboxSyncInstance: null,
        _syncPendingPromise: null,
        _offlineSyncRetryTimer: null,
        _offlineSaveNotified: false,
        _notesSnapshotSeq: 0,
        linkCopied: false,
        zenMode: false,
        // Hides only the .sidebar-panel content (files / search / tags / outline / etc.) while
        // keeping the icon rail visible — a lighter "focus mode" than zenMode. Persisted via
        // LOCAL_SETTINGS so it survives reload; hydrated by loadLocalSettings() at app init,
        // which is why the initial value here matches the LOCAL_SETTINGS default.
        sidebarPanelCollapsed: false,
        previousViewMode: 'split',
        favorites: [],
        favoritesSet: new Set(), // For O(1) lookups
        favoritesExpanded: true,
        saveTimeout: null,
        
        // Note lookup maps for O(1) wikilink resolution (built on loadNotes).
        // Values are the note's URL path (path without .md). Mirrors the rule
        // order of vault.LinkResolver: see resolveWikiLink().
        _noteLookup: {
            byPath: new Map(),           // path (with/without .md) -> urlPath
            byPathLower: new Map(),      // path.toLowerCase() -> urlPath
            byName: new Map(),           // stem (with/without .md) -> urlPath
            byNameLower: new Map(),      // stem.toLowerCase() -> urlPath
        },
        
        // Media lookup map for O(1) media wikilink resolution (built on loadNotes)
        // Maps media filename (case-insensitive) -> full path
        _mediaLookup: new Map(),

        // Extension-less media keys (report.pdf -> "report", plus "folder/report")
        // so [[report]] resolves to a PDF when no note owns that name.
        _mediaLookupStem: new Map(),
        
        // Preview rendering debounce
        _previewDebounceTimeout: null,
        _previewRenderGeneration: 0,
        _lastRenderedContent: '',
        _lastRenderedNote: '',
        _cachedRenderedHTML: '',
        _mathDebounceTimeout: null,
        _mermaidDebounceTimeout: null,
        
        // Theme state
        currentTheme: 'light',
        availableThemes: [],
        
        // Locale/i18n state
        currentLocale: localStorage.getItem('locale') || 'pt-BR',
        availableLocales: [],
        // Translations inlined server-side into index.html before Alpine init (window.__preloadedTranslations)
        translations: window.__preloadedTranslations || {},
        
        // Syntax highlighting
        syntaxHighlightEnabled: true,
        syntaxHighlightTimeout: null,
        
        // Readable line length (preview max-width)
        readableLineLength: true,
        
        // Hide underscore-prefixed folders (_attachments, _templates) from sidebar
        // Read synchronously to prevent flash on initial render
        hideUnderscoreFolders: localStorage.getItem('hideUnderscoreFolders') === 'true',

        // Tab key indents instead of changing focus. Defaults to on; only an
        // explicit "false" turns the native tab-focus behaviour back on.
        tabInsertsTab: localStorage.getItem('tabInsertsTab') !== 'false',

        // Note sorting mode (a-z, z-a, newest, oldest, largest, smallest)
        sortMode: localStorage.getItem('sortMode') || 'a-z',

        // Icon rail / panel state
        activePanel: 'files', // 'files', 'search', 'todos', 'outline', 'backlinks', 'settings'
        
        // Folder state
        folderTree: [],
        allFolders: [],
        expandedFolders: new Set(),
        dragOverFolder: null,  // Track which folder is being hovered during drag
        
        // Tags state
        allTags: {},
        selectedTags: [],
        tagReloadTimeout: null, // For debouncing tag reloads

        // Search state
        searchDebounceTimeout: null,
        isSearching: false,
        expandedSearchResults: {}, // note path -> true when its occurrence list is open
        
        // Outline (TOC) state
        outline: [], // [{level: 1, text: 'Heading', slug: 'heading'}, ...]

        // Backlinks state
        backlinks: [], // [{path: 'note.md', name: 'Note', references: [{line_number: 5, context: '...', type: 'wikilink'}]}]

        // Scroll sync state
        isScrolling: false,
        // performance.now() until which scroll events come from programmatic
        // writes (search jump) and must not be mirrored between panes.
        _scrollSyncSuppressUntil: 0,
        
        // Unified drag state for notes, folders, and media
        draggedItem: null,  // { path: string, type: 'note' | 'folder' | 'image' | 'audio' | 'video' | 'document' }
        dropTarget: null,   // 'editor' | 'folder' | null
        externalDragActive: false,  // true while OS files (not sidebar items) are being dragged over the editor
        
        // Undo/Redo history
        undoHistory: [],
        redoHistory: [],
        maxHistorySize: CONFIG.MAX_UNDO_HISTORY,
        isUndoRedo: false,
        hasPendingHistoryChanges: false,

        // Per-note editor scroll position, keyed by note path. Captured when leaving a note in
        // loadNote() and restored when returning to the same note in the same session. Stays
        // in memory only — cleared on page reload, intentionally (matches typical editor UX).
        noteScrollPositions: {},
        
        // Note metadata (frontmatter) state
        noteMetadata: null,
        metadataExpanded: false,
        // Sidebar resize state
        sidebarWidth: CONFIG.DEFAULT_SIDEBAR_WIDTH,
        isResizing: false,
        
        // Mobile sidebar state
        mobileSidebarOpen: false,
        
        // Split view resize state
        editorWidth: 50, // percentage
        isResizingSplit: false,
        
        // Dropdown state
        showNewDropdown: false,
        dropdownTargetFolder: null, // Folder context for "New" dropdown ('' = root, null = not set)
        dropdownPosition: { top: 0, left: 0 }, // Position for contextual dropdown

        // Wikilink / media autocomplete (triggered by [[ for notes, ![[ for media)
        wikilinkAutocomplete: {
            open: false,
            mode: 'note',        // 'note' | 'media' | 'heading'
            query: '',
            tokenStart: 0,       // index in noteContent right after the opening [[
            items: [],           // [{label, secondary, insert, kind, prefix, modified}]
            headingItems: [],
            activeIndex: 0,
            position: { top: 0, left: 0 },
        },
        _wikilinkOutlineCache: new Map(),
        _noteNameCounts: new Map(), // lower note stem -> count, for name-vs-path insertion
        
        newButtonAction: 'chooser',
        autoFillNoteTitle: false,
        
        // New note / folder name modal (replaces window.prompt)
        showCreateNameModal: false,
        createNameModalKind: 'note',
        createNameModalTargetFolder: '',
        createNameModalInput: '',
        
        // Rename folder modal (replaces window.prompt)
        showRenameFolderModal: false,
        renameFolderPath: '',
        renameFolderOldName: '',
        renameFolderInput: '',

        // Rename media file modal (PDFs and other attachments)
        showRenameMediaModal: false,
        renameMediaPath: '',
        renameMediaOldName: '',
        renameMediaExtension: '',
        renameMediaInput: '',
        
        // Generic confirm dialog (replaces window.confirm)
        showConfirmModal: false,
        confirmModalTitle: '',
        confirmModalMessage: '',
        confirmModalDanger: true,
        confirmModalConfirmLabel: '',
        confirmModalCancelLabel: '',
        _confirmModalResolve: null,
        
        // Quick Switcher state (Ctrl+Alt+P)
        showQuickSwitcher: false,
        quickSwitcherQuery: '',
        quickSwitcherIndex: 0,
        quickSwitcherResults: [],
        
        // Non-blocking notifications (replaces window.alert)
        toasts: [],
        _toastIdSeq: 0,
        
        // Homepage state
        selectedHomepageFolder: '',
        _homepageCache: {
            folderPath: null,
            notes: null,
            folders: null,
            breadcrumb: null
        },
        
        // Homepage constants
        HOMEPAGE_MAX_NOTES: 50,
        // Read before init() so the first paint matches the saved layout.
        homepageView: localStorage.getItem('homepageView') === 'list' ? 'list' : 'cards',
        // Name filter for the current homepage folder. Separate from searchQuery,
        // which is the sidebar's full-text search.
        homepageNameQuery: '',
        
        // Mermaid state cache
        lastMermaidTheme: null,

        // Lazily loaded Markmap module and rendered map instance
        _markmapLoadPromise: null,
        _markmapInstance: null,
        _markmapSvg: null,
        _markmapDebounceTimeout: null,
        _markmapRenderVersion: 0,
        
        // Media viewer state
        currentMedia: '',  // Path to current media file (kept as 'currentMedia' for compatibility)
        currentMediaType: 'image',  // 'image', 'audio', 'video', 'document'
        
        // DOM element cache (to avoid repeated querySelector calls)
        _domCache: {
            editor: null,
            previewContainer: null,
            previewContent: null
        },

        // Sort mode configuration
        sortModes: ['a-z', 'z-a', 'newest', 'oldest', 'largest', 'smallest'],
    };
}
