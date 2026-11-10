import test from 'node:test';
import assert from 'node:assert/strict';

import { createPreview } from '../src/app/preview.js';
import { createPreviewDiagrams } from '../src/app/preview-diagrams.js';

test('diagram theme follows the selected theme metadata and legacy fallback', () => {
    const diagrams = Object.assign(createPreviewDiagrams(), {
        currentTheme: 'paper',
        availableThemes: [{ id: 'paper', type: 'light' }],
    });
    assert.equal(diagrams.getThemeType(), 'light');

    diagrams.currentTheme = 'vs-blue';
    diagrams.availableThemes = [];
    assert.equal(diagrams.getThemeType(), 'light');

    diagrams.currentTheme = 'unknown';
    assert.equal(diagrams.getThemeType(), 'dark');
});

test('diagram theme follows the system color preference', () => {
    const originalWindow = globalThis.window;
    globalThis.window = {
        matchMedia: () => ({ matches: true }),
    };
    try {
        const diagrams = Object.assign(createPreviewDiagrams(), {
            currentTheme: 'system',
        });
        assert.equal(diagrams.getThemeType(), 'dark');
    } finally {
        if (originalWindow === undefined) delete globalThis.window;
        else globalThis.window = originalWindow;
    }
});

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

test('debounces preview rendering and keeps only the latest scheduled render', () => {
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
            renderPreview() { renderCount++; },
        });

        preview.schedulePreviewRender();
        preview.schedulePreviewRender();

        assert.equal(scheduled.size, 1);
        const [timer] = scheduled.values();
        assert.equal(timer.delay, 120);
        assert.equal(renderCount, 0);

        timer.callback();
        assert.equal(renderCount, 1);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
});

test('an immediate preview render cancels a pending debounced render', () => {
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
            noteContent: '',
            clearMarkmap() {},
        });
        preview.schedulePreviewRender();
        preview.renderPreview();

        assert.equal(scheduled.size, 0);
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
