// Editor input handling, text formatting and undo/redo history.
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import { applyEditorIndent, applyEditorOutdent, applyMarkdownWrap, editorKeyChar } from '../lib/editor.js';
import { highlightMarkdownOverlay } from '../lib/editor-highlight.js';
import { loadHighlightJs } from '../lib/highlight.js';

// Delimiters that wrap an active selection when typed directly in the editor.
// Typing "*" then "*" therefore nests into "**bold**" while the selection stays
// on the text; brackets and quotes behave like a typical auto-pairing editor.
const AUTO_WRAP_PAIRS = {
    '*': ['*', '*'],
    '_': ['_', '_'],
    '~': ['~~', '~~'],
    '`': ['`', '`'],
    '(': ['(', ')'],
    '[': ['[', ']'],
    '{': ['{', '}'],
    '"': ['"', '"'],
    "'": ["'", "'"],
    '<': ['<', '>'],
};

export function createEditor() {
    return {

        // True while a dead key (e.g. the grave accent on ABNT2) is still
        // pending in the browser after wrapping a selection with it.
        _editorDeadKeyPending: false,

        // Handle Tab key in editor (indents; Shift+Tab outdents matching lines).
        // When the "Tab inserts tab" setting is off, Tab keeps its native
        // behaviour and moves focus out of the editor.
        handleTabKey(event) {
            if (!this.tabInsertsTab) return;

            const textarea = event.target;
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;

            if (!event.shiftKey && typeof EditorMarkdownContinue !== 'undefined') {
                const listItem = EditorMarkdownContinue.tryTab(this.noteContent, start, end, event);
                if (listItem.handled) {
                    event.preventDefault();
                    this.noteContent = listItem.text;
                    this.$nextTick(() => {
                        textarea.selectionStart = textarea.selectionEnd = listItem.cursor;
                    });
                    this.autoSave();
                    this.updateSyntaxHighlight();
                    return;
                }
            }

            if (event.shiftKey) {
                // Always keep focus in the editor; without this a line that is
                // already flush-left lets the browser move focus to the toolbar.
                event.preventDefault();
                const result = applyEditorOutdent(this.noteContent, start, end);
                if (!result.changed) return;
                this.noteContent = result.text;
                this.$nextTick(() => {
                    textarea.selectionStart = result.selStart;
                    textarea.selectionEnd = result.selEnd;
                });
                this.autoSave();
                this.updateSyntaxHighlight();
                return;
            }

            event.preventDefault();

            // A selection gets one tab per affected line instead of being
            // replaced by a single tab character.
            const multiline = applyEditorIndent(this.noteContent, start, end);
            if (multiline.changed) {
                this.noteContent = multiline.text;
                this.$nextTick(() => {
                    textarea.selectionStart = multiline.selStart;
                    textarea.selectionEnd = multiline.selEnd;
                });
                this.autoSave();
                this.updateSyntaxHighlight();
                return;
            }

            this.noteContent = this.noteContent.substring(0, start) + '\t' + this.noteContent.substring(end);
            this.$nextTick(() => {
                textarea.selectionStart = textarea.selectionEnd = start + 1;
            });
            this.autoSave();
            this.updateSyntaxHighlight();
        },

        // Single keydown entry point: wikilink autocomplete gets first refusal,
        // then typing a delimiter over a selection wraps that selection.
        handleEditorKeydown(event) {
            if (this._editorDeadKeyPending && this.consumeEditorDeadKey(event)) return;
            this.wlOnKeydown(event);
            if (event.defaultPrevented) return;
            this.wrapSelectionOnType(event);
        },

        wrapSelectionOnType(event) {
            if (event.defaultPrevented) return;
            // A dead key can still report isComposing; it is exactly the case
            // we want to resolve through the physical key code below.
            if (event.isComposing && event.key !== 'Dead') return;
            if (event.ctrlKey || event.metaKey || event.altKey) return;

            const key = editorKeyChar(event);
            if (!key) return;

            const pair = AUTO_WRAP_PAIRS[key];
            if (!pair) return;

            const editor = event.target;
            if (!editor || editor.id !== 'note-editor') return;
            if (editor.selectionStart === editor.selectionEnd) return;

            event.preventDefault();
            // A dead key (e.g. the grave key on ABNT2) stays pending after
            // preventDefault: the next keystroke would commit an accent and
            // overwrite the selection. Collapse the caret after the closing
            // delimiter and consume that next keystroke instead.
            const deadKey = key !== event.key;
            this.wrapSelection(pair[0], pair[1], '', { collapseToEnd: deadKey });
            if (deadKey) this._editorDeadKeyPending = true;
        },

        clearEditorDeadKeyPending() {
            this._editorDeadKeyPending = false;
        },

        // Consume the keystroke that would otherwise commit a pending dead key
        // over the text we just wrapped. Returns true when the event was used.
        consumeEditorDeadKey(event) {
            const key = event.key;

            // Modifiers alone do not commit the accent; keep waiting.
            if (key === 'Shift' || key === 'Control' || key === 'Alt'
                || key === 'AltGraph' || key === 'Meta' || key === 'CapsLock' || key === 'OS') {
                return false;
            }

            // Another dead key (or the same one) commits a literal accent.
            if (key === 'Dead' || key === 'Process' || key === 'Unidentified') {
                event.preventDefault();
                this._editorDeadKeyPending = false;
                return true;
            }

            // Navigation/editing keys cancel the dead accent by themselves.
            if (typeof key !== 'string' || key.length > 1) {
                this._editorDeadKeyPending = false;
                return false;
            }

            // Keep keyboard shortcuts working; the modifier combo cancels it.
            if (event.ctrlKey || event.metaKey || event.altKey) {
                this._editorDeadKeyPending = false;
                return false;
            }

            event.preventDefault();
            this._editorDeadKeyPending = false;

            // Space is the usual "commit" key for a dead accent on ABNT2, so
            // swallow it instead of replacing the selected text. Any other
            // printable key is typed normally, ignoring the pending accent.
            if (key !== ' ') this.insertTextAtSelection(key);
            return true;
        },

        insertTextAtSelection(text) {
            const editor = document.getElementById('note-editor');
            if (!editor) return;

            const start = editor.selectionStart;
            const end = editor.selectionEnd;
            this.noteContent = this.noteContent.substring(0, start) + text + this.noteContent.substring(end);

            this.$nextTick(() => {
                editor.selectionStart = editor.selectionEnd = start + text.length;
            });
            this.autoSave();
            this.updateSyntaxHighlight();
        },

        /**
         * Enter: continue blockquote / bullet / ordered list / task list; second Enter on empty item exits (see editor-markdown-continue.js).
         */
        handleEditorEnterKey(event) {
            if (typeof EditorMarkdownContinue === 'undefined') return;
            const textarea = event.target;
            if (!textarea || textarea.id !== 'note-editor') return;

            const result = EditorMarkdownContinue.tryEnter(
                this.noteContent,
                textarea.selectionStart,
                textarea.selectionEnd,
                event
            );
            if (!result.handled) return;

            event.preventDefault();
            this.noteContent = result.text;
            this.$nextTick(() => {
                textarea.selectionStart = textarea.selectionEnd = result.cursor;
            });
            this.autoSave();
            this.updateSyntaxHighlight();
        },

        // Update syntax highlight overlay (debounced, called on input)
        updateSyntaxHighlight() {
            if (!this.syntaxHighlightEnabled) return;
            
            clearTimeout(this.syntaxHighlightTimeout);
            this.syntaxHighlightTimeout = setTimeout(async () => {
                if (!globalThis.hljs && /^[ \t]{0,3}`{3,}/m.test(this.noteContent)) {
                    try {
                        await loadHighlightJs();
                    } catch (error) {
                        console.error('Highlight.js failed to load:', error);
                        return;
                    }
                }
                const overlay = document.getElementById('syntax-overlay');
                if (overlay) {
                    overlay.innerHTML = this.highlightMarkdown(this.noteContent);
                }
            }, 50); // 50ms debounce
        },

        highlightMarkdown(text) {
            return highlightMarkdownOverlay(text, {
                escapeHtml: this.escapeHtml.bind(this),
                highlighter: globalThis.hljs,
            });
        },
        
        // Mark that we have pending changes (called on each keystroke)
        pushToHistory() {
            this.hasPendingHistoryChanges = true;
        },
        
        // Immediately commit pending changes to history (call before undo/redo)
        flushHistory() {
            if (this.hasPendingHistoryChanges) {
                this.commitToHistory();
            }
        },
        
        // Actually commit to undo history (internal)
        commitToHistory() {
            const editor = document.getElementById('note-editor');
            const cursorPos = editor ? editor.selectionStart : 0;
            
            // Only push if content actually changed from last history entry
            if (this.undoHistory.length > 0 && 
                this.undoHistory[this.undoHistory.length - 1].content === this.noteContent) {
                this.hasPendingHistoryChanges = false;
                return;
            }
            
            this.undoHistory.push({ content: this.noteContent, cursorPos });
            
            // Limit history size
            if (this.undoHistory.length > this.maxHistorySize) {
                this.undoHistory.shift();
            }
            
            // Clear redo history when new change is made
            this.redoHistory = [];
            this.hasPendingHistoryChanges = false;
        },
        
        // Undo last change
        undo() {
            if (!this.currentNote) return;
            
            // Flush any pending history changes first (so we don't lose unsaved edits)
            this.flushHistory();
            
            if (this.undoHistory.length <= 1) return;
            
            const editor = document.getElementById('note-editor');
            
            // Pop current state to redo history
            const currentState = this.undoHistory.pop();
            this.redoHistory.push(currentState);
            
            // Get previous state
            const previousState = this.undoHistory[this.undoHistory.length - 1];
            
            // Apply previous state
            this.isUndoRedo = true;
            this.noteContent = previousState.content;
            this.updateSyntaxHighlight();

            // Restore cursor position from the state we're going back to
            this.$nextTick(() => {
                this.saveNote();
                this.isUndoRedo = false;
                if (editor) {
                    setTimeout(() => {
                        const newPos = Math.min(previousState.cursorPos, this.noteContent.length);
                        editor.setSelectionRange(newPos, newPos);
                        editor.focus();
                    }, 0);
                }
            });
        },
        
        // Redo last undone change
        redo() {
            if (!this.currentNote) return;
            
            // Flush any pending history changes first
            this.flushHistory();
            
            if (this.redoHistory.length === 0) return;
            
            const editor = document.getElementById('note-editor');
            
            // Pop from redo history
            const nextState = this.redoHistory.pop();
            
            // Push to undo history
            this.undoHistory.push(nextState);
            
            // Apply next state
            this.isUndoRedo = true;
            this.noteContent = nextState.content;
            this.updateSyntaxHighlight();

            // Restore cursor position from the state we're going forward to
            this.$nextTick(() => {
                this.saveNote();
                this.isUndoRedo = false;
                if (editor) {
                    setTimeout(() => {
                        const newPos = Math.min(nextState.cursorPos, this.noteContent.length);
                        editor.setSelectionRange(newPos, newPos);
                        editor.focus();
                    }, 0);
                }
            });
        },
        
        // Markdown formatting helpers
        // Trim trailing whitespace from double-click word selections.
        // No-op on browsers that already exclude it (Firefox, Safari).
        trimSelectionTrailingSpace(event) {
            const editor = event && event.target;
            if (!editor) return;
            const start = editor.selectionStart;
            let end = editor.selectionEnd;
            if (start >= end) return;
            const text = editor.value;
            while (end > start && /\s/.test(text.charAt(end - 1))) end--;
            if (end !== editor.selectionEnd) {
                editor.setSelectionRange(start, end);
            }
        },

        wrapSelection(before, after, placeholder, { collapseToEnd = false } = {}) {
            const editor = document.getElementById('note-editor');
            if (!editor) return;

            const result = applyMarkdownWrap(
                this.noteContent,
                editor.selectionStart,
                editor.selectionEnd,
                before,
                after,
                placeholder
            );

            this.noteContent = result.text;
            this.updateSyntaxHighlight();

            // Dead keys collapse the caret after the closing delimiter so the
            // next keystroke continues typing instead of replacing the wrapped
            // selection (toolbar/formatting shortcuts keep it selected).
            const caret = collapseToEnd ? result.selEnd + after.length : result.selStart;
            const selEnd = collapseToEnd ? caret : result.selEnd;

            this.$nextTick(() => {
                editor.setSelectionRange(caret, selEnd);
                editor.focus();
            });

            // Trigger autosave
            this.autoSave();
        },
        
        insertLink() {
            const editor = document.getElementById('note-editor');
            if (!editor) return;
            
            const start = editor.selectionStart;
            const end = editor.selectionEnd;
            const selectedText = this.noteContent.substring(start, end);
            
            // If text is selected, use it as link text; otherwise use placeholder
            const linkText = selectedText || 'link text';
            const linkUrl = 'url';
            
            // Build the markdown link
            const newText = `[${linkText}](${linkUrl})`;
            
            // Update content
            this.noteContent = this.noteContent.substring(0, start) + newText + this.noteContent.substring(end);
            this.updateSyntaxHighlight();
            
            // Set cursor position to select the URL part for easy editing
            this.$nextTick(() => {
                const urlStart = start + linkText.length + 3; // After "[linkText]("
                const urlEnd = urlStart + linkUrl.length;
                editor.setSelectionRange(urlStart, urlEnd);
                editor.focus();
            });
            
            // Trigger autosave
            this.autoSave();
        },
        
        // Insert a markdown table placeholder
        insertTable() {
            const editor = document.getElementById('note-editor');
            if (!editor) return;
            
            const cursorPos = editor.selectionStart;
            
            // Basic 3x3 table placeholder
            const table = `| Header 1 | Header 2 | Header 3 |
|----------|----------|----------|
| Cell 1   | Cell 2   | Cell 3   |
| Cell 4   | Cell 5   | Cell 6   |
`;
            
            // Add newline before if not at start of line
            const textBefore = this.noteContent.substring(0, cursorPos);
            const needsNewlineBefore = textBefore.length > 0 && !textBefore.endsWith('\n');
            const prefix = needsNewlineBefore ? '\n\n' : '';
            
            // Insert the table
            this.noteContent = textBefore + prefix + table + this.noteContent.substring(cursorPos);
            this.updateSyntaxHighlight();
            
            // Position cursor at first header for easy editing
            this.$nextTick(() => {
                const newPos = cursorPos + prefix.length + 2; // After "| "
                editor.setSelectionRange(newPos, newPos + 8); // Select "Header 1"
                editor.focus();
            });
            
            // Trigger autosave
            this.autoSave();
        },
        
        // Format selected text or insert formatting at cursor
        formatText(type) {
            // Simple wrap cases - reuse wrapSelection()
            const wrapFormats = {
                'bold': ['**', '**', 'bold'],
                'italic': ['*', '*', 'italic'],
                'strikethrough': ['~~', '~~', 'strikethrough'],
                'code': ['`', '`', 'code']
            };
            
            if (wrapFormats[type]) {
                const [before, after, placeholder] = wrapFormats[type];
                this.wrapSelection(before, after, placeholder);
                return;
            }
            
            // Special cases that need custom handling
            switch (type) {
                case 'heading':
                    this.insertLinePrefix('## ', 'Heading');
                    break;
                case 'quote':
                    this.insertLinePrefix('> ', 'quote');
                    break;
                case 'bullet':
                    this.insertLinePrefix('- ', 'item');
                    break;
                case 'numbered':
                    this.insertLinePrefix('1. ', 'item');
                    break;
                case 'checkbox':
                    this.insertLinePrefix('- [ ] ', 'task');
                    break;
                case 'link':
                    this.insertLink();
                    break;
                case 'image':
                    this.wrapSelection('![', '](image-url)', 'alt text');
                    break;
                case 'codeblock':
                    this.wrapSelection('```\n', '\n```', 'code');
                    break;
                case 'table':
                    this.insertTable();
                    break;
            }
        },
        
        // Insert a line prefix (for headings, lists, quotes)
        insertLinePrefix(prefix, placeholder) {
            const editor = document.getElementById('note-editor');
            if (!editor) return;
            
            const start = editor.selectionStart;
            const end = editor.selectionEnd;
            const selectedText = this.noteContent.substring(start, end);
            const beforeText = this.noteContent.substring(0, start);
            const afterText = this.noteContent.substring(end);
            
            // Check if at start of line
            const atLineStart = beforeText.endsWith('\n') || beforeText === '';
            const newline = atLineStart ? '' : '\n';
            
            let replacement;
            if (selectedText) {
                // Prefix each line of selection
                replacement = newline + selectedText.split('\n').map((line, i) => {
                    // For numbered lists, increment the number
                    if (prefix === '1. ') return `${i + 1}. ${line}`;
                    return prefix + line;
                }).join('\n');
            } else {
                replacement = newline + prefix + placeholder;
            }
            
            this.noteContent = beforeText + replacement + afterText;
            this.updateSyntaxHighlight();
            
            this.$nextTick(() => {
                if (selectedText) {
                    editor.setSelectionRange(start + newline.length, start + replacement.length);
                } else {
                    const placeholderStart = start + newline.length + prefix.length;
                    editor.setSelectionRange(placeholderStart, placeholderStart + placeholder.length);
                }
                editor.focus();
            });
            
            this.autoSave();
        },
    };
}
