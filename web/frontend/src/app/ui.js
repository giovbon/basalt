// Shared UI helpers: dropdowns, dialogs, resize, metadata, misc.
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import { CONFIG, LOCAL_SETTINGS } from '../core/config.js';
import { readLocalSettings, saveSetting } from '../core/settings.js';
import { encodeVaultPath } from '../core/utils.js';

export function createUi() {
    return {
        
        // Helper: Format file size nicely
        formatSize(bytes) {
            if (!bytes) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
        },
        
        // Helper: Format date using current locale
        formatDate(dateStr) {
            if (!dateStr) return '';
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) return '';
            return date.toLocaleDateString(this.currentLocale, { 
                year: 'numeric', 
                month: 'short', 
                day: 'numeric' 
            });
        },
        
        // =====================================================
        // DROPDOWN MENU SYSTEM
        // =====================================================
        
        // Shift+click always forces the chooser regardless of newButtonAction.
        toggleNewDropdown(event) {
            const wantsChooser =
                (event && event.shiftKey) ||
                !this.newButtonAction ||
                this.newButtonAction === 'chooser';
            
            if (wantsChooser) {
                this._openNewDropdownChooser(event);
                return;
            }
            
            switch (this.newButtonAction) {
                case 'note':     this.createNote();         break;
                case 'folder':   this.createFolder();       break;
                default:         this._openNewDropdownChooser(event);
            }
        },
        
        _openNewDropdownChooser(event) {
            this.showNewDropdown = true;
            
            if (event && event.target) {
                const rect = event.target.getBoundingClientRect();
                let top = rect.bottom + 4;
                let left = rect.left;
                
                const dropdownWidth = 184;
                const dropdownHeight = 92;
                if (left + dropdownWidth > window.innerWidth) {
                    left = rect.right - dropdownWidth;
                }
                if (top + dropdownHeight > window.innerHeight) {
                    top = rect.top - dropdownHeight - 4;
                }
                
                this.dropdownPosition = { top, left };
            }
        },
        
        closeDropdown() {
            this.showNewDropdown = false;
            this.dropdownTargetFolder = null; // Reset folder context
        },
        
        /**
         * Parent folder for new note/folder from the + menu when no explicit path is passed.
         * Same rules as the create-name modal: '' = vault root; otherwise a folder path (e.g. folder1/sub).
         */
        inferredNewItemTargetFolder() {
            if (this.dropdownTargetFolder !== null && this.dropdownTargetFolder !== undefined) {
                return this.dropdownTargetFolder;
            }
            return this.selectedHomepageFolder || '';
        },
        
        // =====================================================
        // UNIFIED CREATION FUNCTIONS (reusable from anywhere)
        // =====================================================
        
        // Switch to split view (if in preview-only mode) and focus editor for new notes
        focusEditorForNewNote() {
            // Only switch if in preview-only mode - don't disturb edit or split mode
            if (this.viewMode === 'preview') {
                this.viewMode = 'split';
                this.saveViewMode();
            }
            // Focus the editor after a short delay to ensure DOM is updated
            this.$nextTick(() => {
                const editor = document.getElementById('note-editor');
                if (editor) editor.focus();
            });
        },
        
        /**
         * Theme-styled confirm dialog (replaces window.confirm).
         * @param {{ message: string, title?: string, danger?: boolean, confirmLabel?: string, cancelLabel?: string }} options
         * @returns {Promise<boolean>}
         */
        confirmModalAsk(options = {}) {
            const { message, title, danger = true, confirmLabel, cancelLabel } = options;
            return new Promise((resolve) => {
                this.confirmModalTitle = title || this.t('common.confirm_title');
                this.confirmModalMessage = message || '';
                this.confirmModalDanger = danger;
                this.confirmModalConfirmLabel = confirmLabel
                    || (danger ? this.t('common.delete') : this.t('common.ok'));
                this.confirmModalCancelLabel = cancelLabel || this.t('common.cancel');
                this._confirmModalResolve = resolve;
                this.showConfirmModal = true;
                this.mobileSidebarOpen = false;
            });
        },
        
        confirmModalConfirm() {
            this._confirmModalFinish(true);
        },
        
        confirmModalCancel() {
            this._confirmModalFinish(false);
        },
        
        _confirmModalFinish(ok) {
            if (!this._confirmModalResolve) return;
            this.showConfirmModal = false;
            const fn = this._confirmModalResolve;
            this._confirmModalResolve = null;
            fn(!!ok);
        },
        
        // Refresh DOM element cache
        refreshDOMCache() {
            this._domCache.editor = document.querySelector('.editor-textarea');
            this._domCache.previewContent = document.querySelector('.markdown-preview');
            this._domCache.previewContainer = this._domCache.previewContent ? this._domCache.previewContent.parentElement : null;
        },
        
        // Check if a string is a URL
        isUrl(str) {
            if (typeof str !== 'string') return false;
            return /^https?:\/\/\S+$/i.test(str.trim());
        },
        
        // Escape HTML to prevent XSS
        escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        },
        
        // Format metadata value for display
        formatMetadataValue(key, value) {
            if (value === null || value === undefined) return '';
            
            // Arrays are handled separately in the template
            if (Array.isArray(value)) return value;
            
            // Format dates nicely
            if (key === 'date' || key === 'created' || key === 'modified' || key === 'updated') {
                let date;
                // Parse date-only strings (YYYY-MM-DD) as local dates to avoid timezone issues
                if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
                    const [year, month, day] = value.split('-').map(Number);
                    date = new Date(year, month - 1, day);  // month is 0-indexed
                } else {
                    date = new Date(value);
                }
                if (!isNaN(date.getTime())) {
                    return date.toLocaleDateString(this.currentLocale, { 
                        year: 'numeric', 
                        month: 'short', 
                        day: 'numeric' 
                    });
                }
            }
            
            // Booleans
            if (typeof value === 'boolean') {
                return value ? this.t('common.yes') : this.t('common.no');
            }
            
            return String(value);
        },
        
        // Format metadata value as HTML (for URL support)
        formatMetadataValueHtml(key, value) {
            const formatted = this.formatMetadataValue(key, value);
            
            // Check if it's a URL
            if (this.isUrl(formatted)) {
                const escaped = this.escapeHtml(formatted);
                // Truncate long URLs for display
                const displayUrl = formatted.length > 40 
                    ? formatted.substring(0, 37) + '...' 
                    : formatted;
                return `<a href="${escaped}" target="_blank" rel="noopener noreferrer" class="metadata-link">${this.escapeHtml(displayUrl)}</a>`;
            }
            
            return this.escapeHtml(formatted);
        },
        
        // Get priority metadata fields (shown in collapsed view)
        getPriorityMetadataFields() {
            if (!this.noteMetadata) return [];
            
            // Fields to show in collapsed view, in order of priority
            const priority = ['date', 'created', 'author', 'status', 'priority', 'type', 'category'];
            const fields = [];
            
            for (const key of priority) {
                if (this.noteMetadata[key] !== undefined && !Array.isArray(this.noteMetadata[key])) {
                    const formatted = this.formatMetadataValue(key, this.noteMetadata[key]);
                    const isUrl = this.isUrl(formatted);
                    fields.push({ 
                        key, 
                        value: formatted,
                        valueHtml: isUrl ? this.formatMetadataValueHtml(key, this.noteMetadata[key]) : this.escapeHtml(formatted),
                        isUrl
                    });
                }
            }
            
            return fields.slice(0, 3); // Show max 3 fields in collapsed view
        },
        
        // Get all metadata fields except tags (for expanded view)
        getAllMetadataFields() {
            if (!this.noteMetadata) return [];
            
            return Object.entries(this.noteMetadata)
                .filter(([key]) => key !== 'tags') // Tags shown separately
                .map(([key, value]) => {
                    const isArray = Array.isArray(value);
                    const formatted = this.formatMetadataValue(key, value);
                    const isUrl = !isArray && this.isUrl(formatted);
                    return {
                        key,
                        value: formatted,
                        valueHtml: isUrl ? this.formatMetadataValueHtml(key, value) : this.escapeHtml(formatted),
                        isArray,
                        isUrl
                    };
                });
        },
        
        // Check if note has any displayable metadata
        getHasMetadata() {
            const has = this.noteMetadata && Object.keys(this.noteMetadata).length > 0;
            return has;
        },
        
        // Get tags from metadata
        getMetadataTags() {
            if (!this.noteMetadata || !this.noteMetadata.tags) return [];
            return Array.isArray(this.noteMetadata.tags) ? this.noteMetadata.tags : [this.noteMetadata.tags];
        },
        
        // Save sidebar width to localStorage
        saveSidebarWidth() {
            saveSetting('sidebarWidth', this.sidebarWidth, LOCAL_SETTINGS);
        },
        
        // Save view mode to localStorage
        saveViewMode() {
            try {
                saveSetting('viewMode', this.viewMode, LOCAL_SETTINGS);
            } catch (error) {
                console.error('Error saving view mode:', error);
            }
        },
        
        // Start resizing sidebar
        startResize(event) {
            this.isResizing = true;
            event.preventDefault();
            
            const resize = (e) => {
                if (!this.isResizing) return;
                
                // Calculate new width based on mouse position
                const newWidth = e.clientX;
                
                // Clamp between min and max
                if (newWidth >= 200 && newWidth <= 600) {
                    this.sidebarWidth = newWidth;
                }
            };
            
            const stopResize = () => {
                if (this.isResizing) {
                    this.isResizing = false;
                    this.saveSidebarWidth();
                    document.removeEventListener('mousemove', resize);
                    document.removeEventListener('mouseup', stopResize);
                }
            };
            
            document.addEventListener('mousemove', resize);
            document.addEventListener('mouseup', stopResize);
        },
        
        // Start resizing split panes (editor/preview)
        startSplitResize(event) {
            this.isResizingSplit = true;
            event.preventDefault();
            
            const container = event.target.parentElement;
            
            const resize = (e) => {
                if (!this.isResizingSplit) return;
                
                const containerRect = container.getBoundingClientRect();
                const mouseX = e.clientX - containerRect.left;
                const percentage = (mouseX / containerRect.width) * 100;
                
                // Clamp between 20% and 80%
                if (percentage >= 20 && percentage <= 80) {
                    this.editorWidth = percentage;
                }
            };
            
            const stopResize = () => {
                if (this.isResizingSplit) {
                    this.isResizingSplit = false;
                    this.saveEditorWidth();
                    document.removeEventListener('mousemove', resize);
                    document.removeEventListener('mouseup', stopResize);
                }
            };
            
            document.addEventListener('mousemove', resize);
            document.addEventListener('mouseup', stopResize);
        },
        
        // Setup mobile view mode handler (auto-switch from split to edit on mobile)
        setupMobileViewMode() {
            const MOBILE_BREAKPOINT = 768; // Match CSS breakpoint
            let previousWidth = window.innerWidth;
            
            const handleResize = () => {
                const currentWidth = window.innerWidth;
                const wasMobile = previousWidth <= MOBILE_BREAKPOINT;
                const isMobile = currentWidth <= MOBILE_BREAKPOINT;
                
                // If switching from desktop to mobile and in split mode
                if (!wasMobile && isMobile && this.viewMode === 'split') {
                    this.viewMode = 'edit';
                }
                
                previousWidth = currentWidth;
            };
            
            // Listen for window resize
            window.addEventListener('resize', handleResize);
            
            // Check initial state
            if (window.innerWidth <= MOBILE_BREAKPOINT && this.viewMode === 'split') {
                this.viewMode = 'edit';
            }
        },
        
        // Save editor width to localStorage
        saveEditorWidth() {
            saveSetting('editorWidth', this.editorWidth, LOCAL_SETTINGS);
        },

        // Scroll to top of editor and preview
        scrollToTop() {
            // Disable scroll sync temporarily to prevent interference
            this.isScrolling = true;
            
            // Use cached references (refresh if not available)
            if (!this._domCache.editor || !this._domCache.previewContainer) {
                this.refreshDOMCache();
            }
            
            // Only scroll the visible panes based on viewMode
            if (this.viewMode === 'edit' || this.viewMode === 'split') {
                if (this._domCache.editor) {
                    this._domCache.editor.scrollTop = 0;
                }
            }
            
            if (this.viewMode === 'preview' || this.viewMode === 'split') {
                // Scroll the preview container (parent of .markdown-preview)
                if (this._domCache.previewContainer) {
                    this._domCache.previewContainer.scrollTop = 0;
                }
            }
            
            // Re-enable scroll sync after a short delay
            setTimeout(() => {
                this.isScrolling = false;
            }, CONFIG.SCROLL_SYNC_DELAY);
        },
        
        // Copy current note link to clipboard
        async copyNoteLink() {
            if (!this.currentNote) return;
            
            // Build the full URL
            const pathWithoutExtension = this.currentNote.replace('.md', '');
            const encodedPath = encodeVaultPath(pathWithoutExtension);
            const url = `${window.location.origin}/${encodedPath}`;
            
            try {
                await navigator.clipboard.writeText(url);
            } catch (error) {
                // Fallback for older browsers
                const textArea = document.createElement('textarea');
                textArea.value = url;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
            }
            
            // Show brief "Copied!" feedback
            this.linkCopied = true;
            setTimeout(() => {
                this.linkCopied = false;
            }, 1500);
        },
        
        // Toggle Zen Mode (full immersive writing experience)
        async toggleZenMode() {
            if (!this.zenMode) {
                // Entering Zen Mode
                this.previousViewMode = this.viewMode;
                this.viewMode = 'edit';
                this.mobileSidebarOpen = false;
                this.zenMode = true;
                
                // Request fullscreen
                try {
                    const elem = document.documentElement;
                    if (elem.requestFullscreen) {
                        await elem.requestFullscreen();
                    } else if (elem.webkitRequestFullscreen) {
                        await elem.webkitRequestFullscreen();
                    } else if (elem.msRequestFullscreen) {
                        await elem.msRequestFullscreen();
                    }
                } catch (e) {
                    // Fullscreen not supported or denied, continue anyway
                    console.log('Fullscreen not available:', e);
                }
                
                // Focus editor after transition
                setTimeout(() => {
                    const editor = document.getElementById('note-editor');
                    if (editor) editor.focus();
                }, 300);
            } else {
                // Exiting Zen Mode
                this.zenMode = false;
                this.viewMode = this.previousViewMode;
                
                // Exit fullscreen
                try {
                    if (document.exitFullscreen) {
                        await document.exitFullscreen();
                    } else if (document.webkitExitFullscreen) {
                        await document.webkitExitFullscreen();
                    } else if (document.msExitFullscreen) {
                        await document.msExitFullscreen();
                    }
                } catch (e) {
                    console.log('Exit fullscreen error:', e);
                }
            }
        },
    };
}
