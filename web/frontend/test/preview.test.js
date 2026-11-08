import test from 'node:test';
import assert from 'node:assert/strict';

import { createPreview } from '../src/app/preview.js';

test('renderedMarkdown returns the cached HTML without reading live note content', () => {
    const preview = Object.assign(createPreview(), {
        _cachedRenderedHTML: '<div class="cached-preview"></div>',
        noteContent: '---\nnote-type: markmap\n---\n# Topic',
    });

    assert.equal(preview.renderedMarkdown, '<div class="cached-preview"></div>');
});

test('query fences keep their syntax overlay without the code-block background class', () => {
    const originalHighlighter = globalThis.hljs;
    globalThis.hljs = {
        getLanguage: () => false,
        highlight() {
            assert.fail('query fence should not use the code highlighter');
        },
    };
    try {
        const preview = Object.assign(createPreview(), {
            escapeHtml: (text) => text.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        });
        const html = preview.highlightMarkdown('```query\ntype: table\n```');
        assert.match(html, /class="md-queryblock"/);
        assert.doesNotMatch(html, /class="md-codeblock/);
    } finally {
        if (originalHighlighter === undefined) delete globalThis.hljs;
        else globalThis.hljs = originalHighlighter;
    }
});

test('debounces query refreshes while the note is being edited', () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const scheduled = new Map();
    let nextTimerId = 0;
    let refreshCount = 0;

    globalThis.setTimeout = (callback, delay) => {
        const id = ++nextTimerId;
        scheduled.set(id, { callback, delay });
        return id;
    };
    globalThis.clearTimeout = (id) => scheduled.delete(id);

    try {
        const preview = Object.assign(createPreview(), {
            _resolveDataviewQueries() { refreshCount++; },
        });
        const blocks = [{ query: 'type: table' }];
        preview._scheduleDataviewQueries(blocks, 'First edit', 'Note.md', 1);
        preview._scheduleDataviewQueries(blocks, 'Second edit', 'Note.md', 2);

        assert.equal(scheduled.size, 1);
        const [timer] = scheduled.values();
        assert.equal(timer.delay, 300);
        timer.callback();
        assert.equal(refreshCount, 1);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
});

test('Markmap rendering is debounced while note content changes', () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const scheduled = new Map();
    let nextTimerId = 0;
    let renderCount = 0;

    globalThis.setTimeout = (callback, delay) => {
        const id = ++nextTimerId;
        scheduled.set(id, { callback, delay });
        return id;
    };
    globalThis.clearTimeout = (id) => scheduled.delete(id);

    try {
        const preview = Object.assign(createPreview(), {
            noteContent: '---\nnote-type: markmap\n---\n# First',
            renderMarkmap() { renderCount++; },
        });

        preview.schedulePreviewPostProcessing();
        preview.noteContent = '---\nnote-type: markmap\n---\n# Updated';
        preview.schedulePreviewPostProcessing();

        assert.equal(scheduled.size, 1);
        const [timer] = scheduled.values();
        assert.equal(timer.delay, 500);
        assert.equal(renderCount, 0);

        timer.callback();
        assert.equal(renderCount, 1);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
});
