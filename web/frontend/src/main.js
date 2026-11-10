// Basalt Frontend Application

// Modular sources live in src/; build-js.sh bundles them into app.js.
// Pure modules (config, utils, lib/*) have no DOM or Alpine dependency and are
// covered by node --test (see test/).
import { createWikilink } from './app/wikilink.js';
import { createScrollSync } from './app/scroll-sync.js';
import { createState } from './app/state.js';
import { createQuickSwitcher } from './app/quick-switcher.js';
import { createMedia } from './app/media.js';
import { createSearch } from './app/search.js';
import { createTodos } from './app/todos.js';
import { createBootstrap } from './app/bootstrap.js';
import { createNotes } from './app/notes.js';
import { createFolders } from './app/folders.js';
import { createPreview } from './app/preview.js';
import { createPreviewDiagrams } from './app/preview-diagrams.js';
import { createPreviewTasks } from './app/preview-tasks.js';
import { createGraph } from './app/graph.js';
import { createEditor } from './app/editor.js';
import { createLinkPreview } from './app/link-preview.js';
import { createHomepage } from './app/homepage.js';
import { createSidebar } from './app/sidebar.js';
import { createFileTree } from './app/file-tree.js';
import { createUi } from './app/ui.js';
import { createPanelScope } from './app/panel-scope.js';

// Composition root: each feature slice owns a group of methods (and
// state.js owns the data fields). compose() copies property descriptors so
// `get` accessors stay getters instead of being evaluated once.
function compose(...slices) {
    const out = {};
    for (const slice of slices) {
        Object.defineProperties(out, Object.getOwnPropertyDescriptors(slice));
    }
    return out;
}

function noteApp() {
    return compose(
        createWikilink(),
        createScrollSync(),
        createState(),
        createQuickSwitcher(),
        createMedia(),
        createSearch(),
        createTodos(),
        createBootstrap(),
        createNotes(),
        createFolders(),
        createPreview(),
        createPreviewDiagrams(),
        createPreviewTasks(),
        createGraph(),
        createEditor(),
        createLinkPreview(),
        createHomepage(),
        createSidebar(),
        createFileTree(),
        createUi(),
    );
}

// Register one Alpine component for the app root and one per UI panel. Alpine
// invokes these factories when it evaluates x-data="noteApp" / x-data="filesPanel"
// (index.html and partials/), giving every panel its own x-data boundary while
// the panel facade keeps delegating to the shared root state.
//
// app.js is a classic script that runs before Alpine's deferred bundle, so the
// registration has to wait for Alpine's own init event.
const PANEL_COMPONENTS = [
    'appShell',
    'iconRail',
    'filesPanel',
    'searchPanel',
    'todosPanel',
    'outlinePanel',
    'backlinksPanel',
    'settingsPanel',
    'graphPanel',
    'homepagePanel',
    'editorPanel',
    'mediaPanel',
    'mobilePanel',
    'newItemModal',
    'wikilinkAutocomplete',
    'newNoteModal',
    'renameFolderModal',
    'renameMediaModal',
    'confirmModal',
    'quickSwitcherModal',
];

function registerAlpineComponents() {
    window.Alpine.data('noteApp', noteApp);
    for (const name of PANEL_COMPONENTS) {
        window.Alpine.data(name, createPanelScope);
    }
}

if (window.Alpine) {
    // Defensive: the bundle normally loads before Alpine, but a reordered or
    // cached script tag must not leave x-data without its component.
    registerAlpineComponents();
} else {
    document.addEventListener('alpine:init', registerAlpineComponents);
}
