// TODO list scanning and navigation.

import * as api from '../core/api.js';

export function createTodos() {
    return {
        async loadTodos() {
            this.todosLoading = true;
            this.todosError = '';
            try {
                const data = await api.getJSON('/api/todos');
                this.todos = data.todos || [];
                this.todosLoaded = true;
            } catch (error) {
                console.error('Failed to load TODOs:', error);
                this.todosError = error.detail || error.message;
                this.todos = [];
            } finally {
                this.todosLoading = false;
            }
        },

        async saveTodoKeywords() {
            if (this.todoKeywordsSaving) return;
            this.todoKeywordsSaving = true;
            try {
                const result = await api.sendJSON('/api/todos/config', 'POST', {
                    keywords: this.todoKeywords || '',
                });
                this.todoKeywords = result.keywords;
                this.toast(this.t('todos.keywords_saved'), { type: 'success' });
                if (this.todosLoaded) await this.loadTodos();
            } catch (error) {
                this.toast(error.detail || error.message || this.t('todos.keywords_save_failed'), { type: 'error' });
            } finally {
                this.todoKeywordsSaving = false;
            }
        },

        openTodo(todo) {
            this.loadNote(todo.path, true, `${todo.keyword}:`, todo.line_number, todo.column);
        },

        toggleTodoGroup(path) {
            this.expandedTodoNotes = {
                ...this.expandedTodoNotes,
                [path]: !this.expandedTodoNotes[path],
            };
        },

        isTodoGroupExpanded(path) {
            return !!this.expandedTodoNotes[path];
        },

        get todoGroups() {
            const groups = new Map();
            for (const todo of this.todos) {
                if (!groups.has(todo.path)) {
                    groups.set(todo.path, { path: todo.path, name: todo.name, todos: [] });
                }
                groups.get(todo.path).todos.push(todo);
            }
            return [...groups.values()];
        },
    };
}
