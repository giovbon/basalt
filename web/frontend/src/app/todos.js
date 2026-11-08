// TODO list scanning and navigation.

import { LOCAL_SETTINGS } from '../core/config.js';
import * as api from '../core/api.js';
import { saveSetting } from '../core/settings.js';

export function createTodos() {
    return {
        async loadTodos() {
            this.todosLoading = true;
            this.todosError = '';
            try {
                const params = new URLSearchParams({ keywords: this.todoKeywords || '' });
                const data = await api.getJSON(`/api/todos?${params}`);
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

        saveTodoKeywords() {
            saveSetting('todoKeywords', this.todoKeywords, LOCAL_SETTINGS);
            if (this.todosLoaded) this.loadTodos();
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
