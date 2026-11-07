import test from 'node:test';
import assert from 'node:assert/strict';

import {
    EDITOR_DEAD_KEY_CHARS,
    EDITOR_TAB_OUTDENT_MAX_SPACES,
    editorIndentRemoveLen,
    editorKeyChar,
    editorOutdentChunk,
    applyEditorIndent,
    applyEditorOutdent,
    applyMarkdownWrap,
} from '../src/lib/editor.js';
import { createEditor } from '../src/app/editor.js';
import '../editor-markdown-continue.js';

test('indent removal is one tab or up to four spaces', () => {
    assert.equal(EDITOR_TAB_OUTDENT_MAX_SPACES, 4);
    assert.equal(editorIndentRemoveLen('\tabc'), 1);
    assert.equal(editorIndentRemoveLen(' abc'), 1);
    assert.equal(editorIndentRemoveLen('    abc'), 4);
    assert.equal(editorIndentRemoveLen('     abc'), 4, 'only one indent level');
    assert.equal(editorIndentRemoveLen('abc'), 0);
    assert.equal(editorIndentRemoveLen(''), 0);
});

test('outdents every line and reports whether anything changed', () => {
    const changed = editorOutdentChunk('    a\n\tb\nc');
    assert.deepEqual(changed, { newChunk: 'a\nb\nc', changed: true });

    const untouched = editorOutdentChunk('a\nb');
    assert.deepEqual(untouched, { newChunk: 'a\nb', changed: false });

    assert.deepEqual(editorOutdentChunk(''), { newChunk: '', changed: false });
});

test('outdents the line under a collapsed caret', () => {
    const result = applyEditorOutdent('    abc', 0, 0);
    assert.equal(result.changed, true);
    assert.equal(result.text, 'abc');
    assert.equal(result.selStart, 0);
    assert.equal(result.selEnd, 0);
});

test('leaves a line without indent untouched', () => {
    const result = applyEditorOutdent('abc', 1, 1);
    assert.deepEqual(result, { changed: false, text: 'abc', selStart: 1, selEnd: 1 });
});

test('maps a caret inside the line after the indent is removed', () => {
    const text = '  a\n    b';
    const caret = text.length - 1; // on the 'b'
    const result = applyEditorOutdent(text, caret, caret);

    assert.equal(result.text, '  a\nb');
    assert.equal(result.selStart, caret - 4);
});

test('outdents all selected lines and keeps the selection ordered', () => {
    const text = '    a\n    b\nc';
    const result = applyEditorOutdent(text, 10, 0);

    assert.equal(result.text, 'a\nb\nc');
    assert.ok(result.selStart <= result.selEnd);
    assert.equal(result.selStart, 0);
    assert.equal(result.selEnd, 2);
});

test('indents every line touched by a multi-line selection', () => {
    const result = applyEditorIndent('a\nb\nc', 0, 3);

    assert.equal(result.changed, true);
    assert.equal(result.text, '\ta\n\tb\nc');
    assert.deepEqual([result.selStart, result.selEnd], [1, 5]);
});

test('indents the line under a single-line selection without dropping it', () => {
    const result = applyEditorIndent('abc', 1, 2);

    assert.equal(result.changed, true);
    assert.equal(result.text, '\tabc');
    assert.deepEqual([result.selStart, result.selEnd], [2, 3]);
});

test('a collapsed caret is not an indent (the caller inserts one tab)', () => {
    assert.deepEqual(applyEditorIndent('abc', 1, 1), {
        changed: false,
        text: 'abc',
        selStart: 1,
        selEnd: 1,
    });
});

test('wraps the selection and keeps the wrapped text selected', () => {
    const wrapped = applyMarkdownWrap('hello', 0, 5, '(', ')');
    assert.equal(wrapped.text, '(hello)');
    assert.deepEqual([wrapped.selStart, wrapped.selEnd], [1, 6]);

    const italic = applyMarkdownWrap('hello', 0, 5, '*', '*');
    assert.equal(italic.text, '*hello*');
    assert.deepEqual([italic.selStart, italic.selEnd], [1, 6]);
});

test('keeps edge whitespace outside inline wrappers', () => {
    const result = applyMarkdownWrap(' a word ', 0, 8, '*', '*');

    assert.equal(result.text, ' *a word* ');
    assert.equal(result.text.slice(result.selStart, result.selEnd), 'a word');
});

test('uses the placeholder when there is no selection', () => {
    const result = applyMarkdownWrap('abc', 1, 1, '**', '**', 'bold');

    assert.equal(result.text, 'a**bold**bc');
    assert.equal(result.text.slice(result.selStart, result.selEnd), 'bold');
});

test('resolves the typed character, including backtick dead keys', () => {
    assert.equal(editorKeyChar({ key: '(', code: 'Digit9' }), '(');
    assert.equal(editorKeyChar({ key: 'Dead', code: 'Backquote' }), '`');
    assert.equal(editorKeyChar({ key: 'Dead', code: 'BracketLeft' }), '`');
    assert.equal(editorKeyChar({ key: 'Dead', code: 'Equal' }), null);
    assert.equal(editorKeyChar({ key: 'Tab', code: 'Tab' }), null);
    assert.equal(EDITOR_DEAD_KEY_CHARS.BracketLeft, '`');
});

// --- Component-level dead-key handling (fake textarea, no real DOM) ---------

function makeEditorComponent(noteContent, selectionStart, selectionEnd) {
    const editor = {
        id: 'note-editor',
        selectionStart,
        selectionEnd,
        value: noteContent,
        setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
        focus() {},
    };
    const previousDocument = globalThis.document;
    globalThis.document = { getElementById: () => editor };

    const component = Object.assign(createEditor(), {
        noteContent,
        autoSave() {},
        $nextTick(callback) { callback(); },
        wlOnKeydown() {},
    });

    return {
        component,
        editor,
        keyEvent(key, extra = {}) {
            const event = {
                key,
                code: '',
                target: editor,
                isComposing: false,
                defaultPrevented: false,
                ctrlKey: false,
                metaKey: false,
                altKey: false,
                preventDefault() { this.defaultPrevented = true; },
                ...extra,
            };
            return event;
        },
        restore() { globalThis.document = previousDocument; },
    };
}

test('Tab indents an empty Markdown list item as a nested item', () => {
    const text = '# JS\n- reduce\n- ';
    const result = globalThis.EditorMarkdownContinue.tryTab(text, text.length, text.length, {
        key: 'Tab',
        defaultPrevented: false,
        isComposing: false,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
    });

    assert.deepEqual(result, {
        handled: true,
        text: '# JS\n- reduce\n\t- ',
        cursor: text.length + 1,
    });
});

test('Tab keeps its regular behavior outside an empty list item', () => {
    const text = '```md\n- \n```';
    const result = globalThis.EditorMarkdownContinue.tryTab(text, 9, 9, {
        key: 'Tab',
        defaultPrevented: false,
        isComposing: false,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
    });

    assert.deepEqual(result, { handled: false });
});

test('Tab handler applies the nested list edit and moves the caret', () => {
    const text = '# JS\n- reduce\n- ';
    const ctx = makeEditorComponent(text, text.length, text.length);
    try {
        ctx.component.tabInsertsTab = true;
        const event = ctx.keyEvent('Tab');

        ctx.component.handleTabKey(event);

        assert.equal(event.defaultPrevented, true);
        assert.equal(ctx.component.noteContent, '# JS\n- reduce\n\t- ');
        assert.deepEqual([ctx.editor.selectionStart, ctx.editor.selectionEnd], [text.length + 1, text.length + 1]);
    } finally {
        ctx.restore();
    }
});

test('a dead-key wrap collapses the caret and consumes the commit keystroke', () => {
    const ctx = makeEditorComponent('hello', 0, 5);
    try {
        const dead = ctx.keyEvent('Dead', { code: 'BracketLeft' });
        ctx.component.handleEditorKeydown(dead);

        assert.equal(ctx.component.noteContent, '`hello`');
        assert.equal(dead.defaultPrevented, true);
        assert.deepEqual([ctx.editor.selectionStart, ctx.editor.selectionEnd], [7, 7]);
        assert.equal(ctx.component._editorDeadKeyPending, true);

        // On ABNT2, Space is how the pending grave accent is committed.
        const space = ctx.keyEvent(' ');
        ctx.component.handleEditorKeydown(space);

        assert.equal(space.defaultPrevented, true);
        assert.equal(ctx.component.noteContent, '`hello`');
        assert.equal(ctx.component._editorDeadKeyPending, false);
    } finally {
        ctx.restore();
    }
});

test('typing after a dead-key wrap ignores the pending accent', () => {
    const ctx = makeEditorComponent('hello', 0, 5);
    try {
        ctx.component.handleEditorKeydown(ctx.keyEvent('Dead', { code: 'BracketLeft' }));

        const letter = ctx.keyEvent('a');
        ctx.component.handleEditorKeydown(letter);

        assert.equal(letter.defaultPrevented, true);
        assert.equal(ctx.component.noteContent, '`hello`a');
        assert.equal(ctx.component._editorDeadKeyPending, false);
    } finally {
        ctx.restore();
    }
});

test('navigation keys cancel the pending dead key without being swallowed', () => {
    const ctx = makeEditorComponent('hello', 0, 5);
    try {
        ctx.component.handleEditorKeydown(ctx.keyEvent('Dead', { code: 'BracketLeft' }));

        const right = ctx.keyEvent('ArrowRight');
        ctx.component.handleEditorKeydown(right);

        assert.equal(right.defaultPrevented, false);
        assert.equal(ctx.component._editorDeadKeyPending, false);
        assert.equal(ctx.component.noteContent, '`hello`');
    } finally {
        ctx.restore();
    }
});

test('a normal delimiter still keeps the wrapped text selected', () => {
    const ctx = makeEditorComponent('hello', 0, 5);
    try {
        const star = ctx.keyEvent('*');
        ctx.component.handleEditorKeydown(star);

        assert.equal(ctx.component.noteContent, '*hello*');
        assert.deepEqual([ctx.editor.selectionStart, ctx.editor.selectionEnd], [1, 6]);
        assert.equal(ctx.component._editorDeadKeyPending, false);
    } finally {
        ctx.restore();
    }
});
