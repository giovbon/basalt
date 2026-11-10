// User preferences persisted in localStorage.

import { LOCAL_SETTINGS } from '../core/config.js';
import { readLocalSettings, saveSetting } from '../core/settings.js';

export function createLocalSettings() {
    return {
        toggleSyntaxHighlight() {
            this.syntaxHighlightEnabled = !this.syntaxHighlightEnabled;
            saveSetting('syntaxHighlightEnabled', this.syntaxHighlightEnabled, LOCAL_SETTINGS);
            if (this.syntaxHighlightEnabled) {
                this.updateSyntaxHighlight();
            }
        },

        loadLocalSettings() {
            Object.assign(this, readLocalSettings(LOCAL_SETTINGS));
            this.favoritesSet = new Set(this.favorites);
        },

        toggleReadableLineLength() {
            this.readableLineLength = !this.readableLineLength;
            saveSetting('readableLineLength', this.readableLineLength, LOCAL_SETTINGS);
        },

        toggleHideUnderscoreFolders() {
            this.hideUnderscoreFolders = !this.hideUnderscoreFolders;
            saveSetting('hideUnderscoreFolders', this.hideUnderscoreFolders, LOCAL_SETTINGS);
            if (this.showGraph) {
                this.initGraph();
            }
        },

        toggleTabInsertsTab() {
            this.tabInsertsTab = !this.tabInsertsTab;
            saveSetting('tabInsertsTab', this.tabInsertsTab, LOCAL_SETTINGS);
        },

        persistNewButtonAction() {
            saveSetting('newButtonAction', this.newButtonAction, LOCAL_SETTINGS);
        },

        toggleAutoFillNoteTitle() {
            this.autoFillNoteTitle = !this.autoFillNoteTitle;
            saveSetting('autoFillNoteTitle', this.autoFillNoteTitle, LOCAL_SETTINGS);
        },

        toggleSidebarPanel() {
            this.sidebarPanelCollapsed = !this.sidebarPanelCollapsed;
            saveSetting('sidebarPanelCollapsed', this.sidebarPanelCollapsed, LOCAL_SETTINGS);
        },

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
    };
}
