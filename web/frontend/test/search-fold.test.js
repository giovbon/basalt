import test from 'node:test';
import assert from 'node:assert/strict';

import { foldForSearch, foldedIndexForOriginal, isWholeWordMatch, lineStartOffset } from '../src/lib/search-fold.js';

test('ASCII text folds to lowercase with an identity map', () => {
    const { text, map } = foldForSearch('AbC');
    assert.equal(text, 'abc');
    assert.deepEqual(map, [0, 1, 2, 3]);
});

test('empty string keeps one map entry so the last index is addressable', () => {
    const { text, map } = foldForSearch('');
    assert.equal(text, '');
    assert.deepEqual(map, [0]);
});

test('accents are stripped and the map points back to the original rune', () => {
    const { text, map } = foldForSearch('coração');
    assert.equal(text, 'coracao');
    // 'ç' and 'ã' are single JS code units, so the map stays 1:1 here.
    assert.equal(map.length, 'coração'.length + 1);
    assert.equal(map[3], 3);
    assert.equal(map[4], 4);
});

test('decomposed input keeps every folded char pointing at its source', () => {
    const decomposed = 'cac\u0327a\u0303o'; // cac + combining cedilla + a + combining tilde + o
    const { text, map } = foldForSearch(decomposed);
    assert.equal(text, 'cacao');
    assert.equal(map[map.length - 1], decomposed.length);
    for (let i = 0; i < map.length - 1; i++) {
        assert.ok(map[i] >= 0 && map[i] < decomposed.length);
        assert.ok(map[i] <= map[i + 1], 'map must be non-decreasing');
    }
});

test('foldedIndexForOriginal finds the first folded position at or after an offset', () => {
    const { map } = foldForSearch('coração');
    assert.equal(foldedIndexForOriginal(map, 0), 0);
    assert.equal(foldedIndexForOriginal(map, 3), 3);
    assert.equal(foldedIndexForOriginal(map, 7), 7);
    // Past the end the binary search clamps to the last map entry.
    assert.equal(foldedIndexForOriginal(map, 7 + 1), map.length - 1);
});

test('lineStartOffset maps 1-based lines to character offsets', () => {
    const content = 'linha1\nlinha2\nlinha3';
    assert.equal(lineStartOffset(content, 1), 0);
    assert.equal(lineStartOffset(content, 2), 7);
    assert.equal(lineStartOffset(content, 3), 14);
    assert.equal(lineStartOffset(content, 0), 0);
    assert.equal(lineStartOffset(content, 42), content.length, 'past the end clamps to length');
});

test('whole-word matching respects Unicode letters, digits, and underscores', () => {
    assert.equal(isWholeWordMatch('mesma ESM', 6, 9), true);
    assert.equal(isWholeWordMatch('mesma', 1, 4), false);
    assert.equal(isWholeWordMatch('_ESM ESM2', 1, 4), false);
    assert.equal(isWholeWordMatch('coração', 0, 7), true);
    assert.equal(isWholeWordMatch('éESM', 1, 4), false);
});
