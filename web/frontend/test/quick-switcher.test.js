import test from 'node:test';
import assert from 'node:assert/strict';

import { createQuickSwitcher } from '../src/app/quick-switcher.js';

const item = (path, type) => ({
    path,
    name: path.split('/').pop(),
    type,
});

function quickSwitcher(notes) {
    return {
        ...createQuickSwitcher(),
        notes,
        quickSwitcherResults: [],
        quickSwitcherIndex: 0,
        showQuickSwitcher: true,
        quickSwitcherQuery: '',
    };
}

test('quick switcher finds PDFs by filename and folder, but excludes other media', () => {
    const app = quickSwitcher([
        item('guides/Manual.pdf', 'document'),
        item('guides/overview.md', 'note'),
        item('images/Manual.png', 'image'),
    ]);

    assert.deepEqual(app.filterQuickSwitcher('manual').map(note => note.path), [
        'guides/Manual.pdf',
    ]);
    assert.deepEqual(app.filterQuickSwitcher('guides').map(note => note.path), [
        'guides/Manual.pdf',
        'guides/overview.md',
    ]);
});

test('quick switcher opens PDFs through the media handler', () => {
    const app = quickSwitcher([item('guides/Manual.pdf', 'document')]);
    const opened = [];
    app.openItem = (...args) => opened.push(args);

    app.selectQuickSwitcherNote(app.notes[0]);

    assert.deepEqual(opened, [['guides/Manual.pdf', 'document']]);
    assert.equal(app.showQuickSwitcher, false);
});

test('Enter opens a selected PDF through the media handler', () => {
    const app = quickSwitcher([item('guides/Manual.pdf', 'document')]);
    const opened = [];
    app.openItem = (...args) => opened.push(args);
    app.quickSwitcherResults = app.notes;

    app.handleQuickSwitcherKeydown({
        key: 'Enter',
        preventDefault() {},
    });

    assert.deepEqual(opened, [['guides/Manual.pdf', 'document']]);
    assert.equal(app.showQuickSwitcher, false);
});
