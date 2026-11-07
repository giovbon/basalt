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
