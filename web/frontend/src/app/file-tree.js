// File-tree rendering, row interactions, and multi-selection.
//
// The tree uses x-html for recursive rows because Alpine does not compile
// directives in dynamically inserted markup. Keep its rendering and delegated
// event handlers together here.

import { treeIconSvg, treeIconKind, treeKindClass } from '../lib/file-icons.js';

export function createFileTree() {
    return {
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

        escapeHtmlAttr(str) {
            if (!str) return '';
            return str
                .replace(/&/g, '&amp;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        },

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
            if (!this.draggedItem) return;
            event.preventDefault();
            this.dropTarget = null;
            this.dragOverFolder = el.dataset.path;
            el.classList.add('drag-over');
        },

        handleFolderDragLeave(el) {
            this.dragOverFolder = null;
            el.classList.remove('drag-over');
        },

        handleFolderDrop(el, event) {
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

        renderFolderRecursive(folder) {
            if (!folder) return '';

            let html = '';
            const isExpanded = this.expandedFolders.has(folder.path);
            const esc = str => this.escapeHtmlAttr(str);
            const isEmpty = folder.notes.length === 0 &&
                (!folder.children || Object.keys(folder.children).length === 0);

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
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 0 0-1 1v3M4 7h16"></path>
                                </svg>
                            </button>
                        </span>
                    </div>
            `;

            if (isExpanded) {
                html += '<div class="folder-contents">';
                if (folder.children && Object.keys(folder.children).length > 0) {
                    const children = Object.entries(folder.children)
                        .filter(([, child]) => !this.hideUnderscoreFolders || !child.name.startsWith('_'))
                        .sort((a, b) => this.getFolderSortComparator()(a[1], b[1]));
                    children.forEach(([, childFolder]) => {
                        html += this.renderFolderRecursive(childFolder);
                    });
                }
                if (folder.notes && folder.notes.length > 0) {
                    folder.notes.forEach(note => {
                        html += this.renderNoteItem(note);
                    });
                }
                html += '</div>';
            }

            html += '</div>';
            return html;
        },

        renderNoteItem(note) {
            const esc = str => this.escapeHtmlAttr(str);
            const isMediaFile = note.type !== 'note';
            const isCurrentNote = this.currentNote === note.path;
            const isCurrentMedia = this.currentMedia === note.path;
            const isCurrent = isMediaFile ? isCurrentMedia : isCurrentNote;
            const kind = treeIconKind(note.type);
            const icon = kind ? treeIconSvg(kind) : this.getMediaIcon(note.type);
            const isPdf = kind === 'pdf' || /\.pdf$/i.test(note.path);
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

        renderRootItems() {
            const root = this.folderTree['__root__'];
            if (!root || !root.notes || root.notes.length === 0) return '';
            return root.notes.map(note => this.renderNoteItem(note)).join('');
        },
    };
}
