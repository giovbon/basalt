// Task checkbox behavior for the rendered Markdown preview.

import * as api from '../core/api.js';
import { scanTaskLines, toggleTaskAt, setAllTasks } from '../lib/tasks.js';

export function createPreviewTasks() {
    return {
        handlePreviewClick(event) {
            this.activateSearchMatch(event.target);
            if (this.toggleTaskFromPreview(event)) return;
            this.handleInternalLink(event);
        },

        _taskBoxForClick(event) {
            const target = event.target;
            if (!target || !target.closest) return null;

            if (target.tagName === 'INPUT' && target.type === 'checkbox') return target;
            if (target.closest('a, img, video, audio, iframe, pre, button, label, summary')) return null;
            if (event.detail !== 1) return null;
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed) return null;

            const item = target.closest('li');
            if (!item) return null;
            const box = item.querySelector('input[type="checkbox"][data-task-index]');
            return box && box.closest('li') === item ? box : null;
        },

        _toggleAllTasksFromPreview(box) {
            const index = parseInt(box.getAttribute('data-task-index'), 10);
            if (!Number.isInteger(index)) return false;

            const result = setAllTasks(this.noteContent, index);
            if (!result.found) return false;
            if (!result.changed) return true;

            this.noteContent = result.text;
            this.autoSave();
            this.toast(
                this.t(result.nextState === 'x' ? 'editor.tasks_all_checked' : 'editor.tasks_all_unchecked',
                    { changed: result.changeCount, total: result.total })
            );
            return true;
        },

        async _persistTaskToggle(oldLine, newLine) {
            try {
                const response = await api.raw('/api/notes/replace', {
                    method: 'POST',
                    json: { path: this.currentNote, old_str: oldLine, new_str: newLine }
                });
                if (!response.ok) {
                    this.autoSave();
                    return;
                }
                const result = await response.json();
                this.noteBaseHash = result.hash || null;
                this.lastSaved = true;
            } catch (error) {
                console.error('Failed to replace task line:', error);
                this.autoSave();
            }
        },

        toggleTaskFromPreview(event) {
            const box = this._taskBoxForClick(event);
            if (!box) return false;
            if (event.ctrlKey || event.metaKey) return this._toggleAllTasksFromPreview(box);

            const index = parseInt(box.getAttribute('data-task-index'), 10);
            if (!Number.isInteger(index)) return false;

            const result = toggleTaskAt(this.noteContent, index);
            if (!result.changed) return false;

            this.noteContent = result.text;
            if (!this.isUndoRedo) this.pushToHistory();
            this.lastSaved = false;
            this._persistTaskToggle(result.oldLine, result.newLine);
            return true;
        },

        _scanTaskLines(source) {
            return scanTaskLines(source);
        },
    };
}
