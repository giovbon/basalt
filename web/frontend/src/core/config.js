// Configuration constants and persisted-setting definitions.
//
// Extracted from the former single-file app.js: nothing here touches the DOM
// or Alpine, so it is safe to unit test (test/config.test.js).

// Runtime values that /api/config may override live on the Alpine component
// (this.autosaveDelayMs, this.defaultTheme, ...); these are the fallbacks.
export const CONFIG = {
    AUTOSAVE_DELAY: 1000,              // ms - Fallback only; runtime value lives on this.autosaveDelayMs (hydrated from /api/config). Used by autoSave().
    DEFAULT_THEME: 'light',            // Fallback only; runtime value lives on this.defaultTheme (hydrated from /api/config). Used by initTheme() when localStorage has no saved preference.
    UPLOAD_MAX_NOTE_MB: 10,            // MB - Fallback only; runtime value lives on this.uploadMaxNoteMb (hydrated from /api/config). Used by importMarkdownFile() to cap drag-drop .md imports.
    SEARCH_DEBOUNCE_DELAY: 500,        // ms - Delay before running note search while typing
    SEARCH_MIN_QUERY_LENGTH: 2,        // Shorter queries show the folder tree instead of searching
    SAVE_INDICATOR_DURATION: 2000,     // ms - How long to show "saved" indicator
    SCROLL_SYNC_DELAY: 50,             // ms - Delay to prevent scroll sync interference
    SCROLL_SYNC_MAX_RETRIES: 10,       // Maximum attempts to find editor/preview elements
    SCROLL_SYNC_RETRY_INTERVAL: 100,   // ms - Time between setupScrollSync retries
    LINK_PREVIEW_DELAY: 600,           // ms - Hover time before a link's preview card appears, long enough to move the cursor and click the link first
    MAX_UNDO_HISTORY: 50,              // Maximum number of undo steps to keep
    DEFAULT_SIDEBAR_WIDTH: 256,        // px - Default sidebar width (w-64 in Tailwind)
    TOAST_MAX_VISIBLE: 4,              // Max stacked toasts; oldest dropped when exceeded
    TOAST_DURATION_ERROR_MS: 7000,
    TOAST_DURATION_WARNING_MS: 5500,
    TOAST_DURATION_INFO_MS: 4500,
    TOAST_DURATION_SUCCESS_MS: 3500,
};

// localStorage settings configuration - centralized definition of all persisted settings
export const LOCAL_SETTINGS = {
    // Boolean settings
    syntaxHighlightEnabled: { key: 'syntaxHighlightEnabled', type: 'boolean', default: true },
    readableLineLength: { key: 'readableLineLength', type: 'boolean', default: true },
    favoritesExpanded: { key: 'favoritesExpanded', type: 'boolean', default: true },
    tagsExpanded: { key: 'tagsExpanded', type: 'boolean', default: false },
    hideUnderscoreFolders: { key: 'hideUnderscoreFolders', type: 'boolean', default: false },
    tabInsertsTab: { key: 'tabInsertsTab', type: 'boolean', default: true },
    sidebarPanelCollapsed: { key: 'sidebarPanelCollapsed', type: 'boolean', default: false },
    autoFillNoteTitle: { key: 'autoFillNoteTitle', type: 'boolean', default: false },
    // String settings
    sortMode: { key: 'sortMode', type: 'string', default: 'a-z' },
    todoKeywords: { key: 'todoKeywords', type: 'string', default: 'TODO, FIXME, LATER' },
    newButtonAction: {
        key: 'newButtonAction', type: 'string', default: 'chooser',
        valid: ['chooser', 'note', 'folder']
    },
    // Number settings with validation
    sidebarWidth: { key: 'sidebarWidth', type: 'number', default: CONFIG.DEFAULT_SIDEBAR_WIDTH, min: 200, max: 600 },
    editorWidth: { key: 'editorWidth', type: 'number', default: 50, min: 20, max: 80 },
    // String setting with validation
    viewMode: { key: 'viewMode', type: 'string', default: 'split', valid: ['edit', 'split', 'preview'] },
    // Homepage layout. Cards stay the default so existing vaults look unchanged.
    homepageView: { key: 'homepageView', type: 'string', default: 'cards', valid: ['cards', 'list'] },
    // JSON settings
    favorites: { key: 'noteFavorites', type: 'json', default: [] },
};
