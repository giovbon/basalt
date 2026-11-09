import test from 'node:test';
import assert from 'node:assert/strict';

import { createWikilink } from '../src/app/wikilink.js';

// The lookup maps live on the Alpine component's state (src/app/state.js,
// which reads localStorage and therefore cannot be imported under node --test),
// so the context is assembled by hand here.
function makeVault(notes) {
    return {
        notes,
        _noteLookup: {
            byPath: new Map(),
            byPathLower: new Map(),
            byName: new Map(),
            byNameLower: new Map(),
        },
        _mediaLookup: new Map(),
        _mediaLookupStem: new Map(),
        _noteNameCounts: new Map(),
        _wikilinkOutlineCache: new Map(),
        wikilinkAutocomplete: {
            mode: 'note', query: '', items: [], headingItems: [], activeIndex: 0, open: false,
        },
        ...createWikilink(),
    };
}

const note = (path) => ({
    path,
    name: path.split('/').pop().replace(/\.md$/i, ''),
    folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
    type: 'note',
    modified: '2024-01-01',
});

const media = (path, type = 'document') => ({
    path,
    name: path.split('/').pop().replace(/\.[^.]+$/, ''),
    folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
    type,
    modified: '2024-02-02',
});

function build(notes) {
    const ctx = makeVault(notes);
    ctx.buildNoteLookupMaps();
    return ctx;
}

test('a wikilink with a .pdf extension resolves to the file itself', () => {
    const ctx = build([note('notas/relatorio.md'), media('docs/orcamento.pdf')]);

    assert.equal(ctx.resolveWikiLink('orcamento.pdf'), 'docs/orcamento.pdf');
    assert.equal(ctx.resolveWikiLink('docs/orcamento.pdf'), 'docs/orcamento.pdf');
    assert.equal(ctx.resolveWikiLink('ORCAMENTO.PDF'), 'docs/orcamento.pdf');
});

test('a bare stem resolves to the media file when no note owns the name', () => {
    const ctx = build([note('notas/relatorio.md'), media('docs/orcamento.pdf')]);

    assert.equal(ctx.resolveWikiLink('orcamento'), 'docs/orcamento.pdf');
    // relative to the source note's folder
    assert.equal(ctx.resolveWikiLink('orcamento', 'docs'), 'docs/orcamento.pdf');
});

test('notes always win over a media file with the same name', () => {
    const ctx = build([note('orcamento.md'), media('docs/orcamento.pdf')]);

    assert.equal(ctx.resolveWikiLink('orcamento'), 'orcamento');
    assert.equal(ctx.resolveWikiLink('orcamento.pdf'), 'docs/orcamento.pdf');
});

test('the resolved media path keeps its extension for the click handler', () => {
    const ctx = build([media('anexo.pdf', 'document'), media('img.png', 'image')]);

    assert.equal(ctx.resolveWikiLink('anexo.pdf'), 'anexo.pdf');
    assert.equal(ctx.resolveWikiLink('img.png'), 'img.png');
    assert.equal(ctx.resolveWikiLink('ainda-nao-existe.pdf'), null);
});

test('resolveMediaWikilink accepts filename, path and stem', () => {
    const ctx = build([media('docs/orcamento.pdf'), media('img.png', 'image')]);

    assert.equal(ctx.resolveMediaWikilink('orcamento.pdf'), 'docs/orcamento.pdf');
    assert.equal(ctx.resolveMediaWikilink('docs/orcamento.pdf'), 'docs/orcamento.pdf');
    assert.equal(ctx.resolveMediaWikilink('orcamento'), 'docs/orcamento.pdf');
    assert.equal(ctx.resolveMediaWikilink('nao-existe.png'), null);
});

test('[[ autocomplete offers media files as link targets, notes first', () => {
    const ctx = build([
        note('notas/orcamento-2024.md'),
        media('docs/orcamento.pdf'),
        media('img.png', 'image'),
    ]);

    ctx.wikilinkAutocomplete.mode = 'note';
    ctx.wikilinkAutocomplete.query = 'orcamento';
    ctx.wlComputeItems();
    const labels = ctx.wikilinkAutocomplete.items.map((i) => i.label);
    assert.ok(labels.includes('orcamento-2024'), 'note suggested');
    assert.ok(labels.includes('orcamento.pdf'), 'pdf suggested');
    assert.equal(labels[0], 'orcamento-2024', 'notes rank ahead of media');
    assert.equal(
        ctx.wikilinkAutocomplete.items.find((i) => i.label === 'orcamento.pdf').insert,
        'orcamento.pdf',
        'media inserts the filename so the link resolves',
    );
});

test('![[ autocomplete keeps suggesting media only', () => {
    const ctx = build([note('nota.md'), media('img.png', 'image')]);

    ctx.wikilinkAutocomplete.mode = 'media';
    ctx.wikilinkAutocomplete.query = '';
    ctx.wlComputeItems();

    assert.deepEqual(
        ctx.wikilinkAutocomplete.items.map((i) => i.label),
        ['img.png'],
    );
});

test('heading autocomplete filters and inserts the page path with its heading slug', () => {
    const ctx = build([note('Projects/Roadmap.md')]);
    ctx.wikilinkAutocomplete.mode = 'heading';
    ctx.wikilinkAutocomplete.query = 'phase';
    ctx.wikilinkAutocomplete.headingItems = [
        { label: 'Phase 1', slug: 'phase-1', insert: 'Roadmap#phase-1', kind: 'heading' },
        { label: 'Search navigation', slug: 'search-navigation', insert: 'Roadmap#search-navigation', kind: 'heading' },
    ];

    ctx.wlComputeItems();

    assert.deepEqual(ctx.wikilinkAutocomplete.items.map((item) => item.label), ['Phase 1']);
    assert.equal(ctx.wikilinkAutocomplete.items[0].insert, 'Roadmap#phase-1');
});
