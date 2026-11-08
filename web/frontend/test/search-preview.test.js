import test from 'node:test';
import assert from 'node:assert/strict';

import {
    searchHiddenRegions,
    spanOverlapsRegions,
    sourceOffsetForLineColumn,
    previewMarkIndexForSourceOffset,
} from '../src/lib/search-preview.js';

/** True when `needle` at its first occurrence is inside a hidden region. */
function isHidden(content, needle) {
    const at = content.indexOf(needle);
    assert.notEqual(at, -1, `fixture does not contain ${needle}`);
    return spanOverlapsRegions(searchHiddenRegions(content), at, at + needle.length);
}

test('sourceOffsetForLineColumn walks lines and runes, clamping at newlines', () => {
    const content = 'ab\ncd\nef';
    assert.equal(sourceOffsetForLineColumn(content, 1, 1), 0);
    assert.equal(sourceOffsetForLineColumn(content, 2, 1), 3);
    assert.equal(sourceOffsetForLineColumn(content, 2, 2), 4);
    assert.equal(sourceOffsetForLineColumn(content, 2, 99), 5, 'clamped to the newline');
    assert.equal(sourceOffsetForLineColumn(content, 99), content.length);

    const astral = 'a😀b';
    assert.equal(sourceOffsetForLineColumn(astral, 1, 2), 1);
    assert.equal(sourceOffsetForLineColumn(astral, 1, 3), 3, 'emoji is one rune but two code units');
});

test('frontmatter and fenced code are hidden', () => {
    const frontmatter = '---\ntitle: alpha\n---\nalpha';
    assert.ok(isHidden(frontmatter, 'title: alpha'));
    assert.ok(!isHidden(frontmatter, '\nalpha'));

    const fenced = 'alpha\n```js\nalpha\n```';
    const regions = searchHiddenRegions(fenced);
    const visible = fenced.indexOf('alpha');
    const hidden = fenced.lastIndexOf('alpha');
    assert.equal(spanOverlapsRegions(regions, visible, visible + 5), false);
    assert.equal(spanOverlapsRegions(regions, hidden, hidden + 5), true);
});

test('inline code, HTML and comments are hidden', () => {
    assert.ok(isHidden('a `alpha` b', '`alpha`'));
    assert.ok(!isHidden('a `alpha` b', ' b'));
    assert.ok(isHidden('a <span class="alpha">x</span>', 'span class='));
    assert.ok(isHidden('a <!-- alpha --> b', '<!-- alpha -->'));
    assert.ok(isHidden('a <!DOCTYPE alpha>', '<!DOCTYPE alpha>'));
});

test('link and image destinations are hidden but visible text is not', () => {
    assert.ok(isHidden('[text](https://alpha.example)', 'https://alpha.example'));
    assert.ok(!isHidden('[alpha](x)', '[alpha'));
    assert.ok(isHidden('![alt alpha](img.png)', '![alt alpha]'));
    assert.ok(isHidden('![[alpha.png]]', '![[alpha.png]]'));
});

test('the target half of a wikilink alias is hidden', () => {
    assert.ok(isHidden('[[alpha|display]]', '[[alpha|'));
    assert.ok(!isHidden('[[alpha|display]]', 'display'));
    assert.ok(!isHidden('[[alpha]]', '[[alpha]]'), 'without an alias the target is visible');
});

test('reference definitions are hidden', () => {
    assert.ok(isHidden('[ref]: https://alpha.example', '[ref]:'));
});

test('spanOverlapsRegions treats the end as exclusive', () => {
    const regions = [[2, 5]];
    assert.equal(spanOverlapsRegions(regions, 1, 2), false);
    assert.equal(spanOverlapsRegions(regions, 1, 3), true);
    assert.equal(spanOverlapsRegions(regions, 4, 9), true);
    assert.equal(spanOverlapsRegions(regions, 5, 9), false);
    assert.equal(spanOverlapsRegions([], 0, 10), false);
});

test('previewMarkIndexForSourceOffset numbers only highlightable occurrences', () => {
    const content = 'alpha beta alpha `alpha`';
    const first = content.indexOf('alpha');
    const second = content.indexOf('alpha', first + 1);
    const hidden = content.lastIndexOf('alpha');

    assert.equal(previewMarkIndexForSourceOffset(content, first, 'alpha', 2), 0);
    assert.equal(previewMarkIndexForSourceOffset(content, second, 'alpha', 2), 1);
    assert.equal(previewMarkIndexForSourceOffset(content, hidden, 'alpha', 2), -1);
    assert.equal(previewMarkIndexForSourceOffset(content, first, 'alpha', 3), -2, 'count mismatch');
    assert.equal(previewMarkIndexForSourceOffset('', 0, 'alpha', 1), -2);
});

test('previewMarkIndexForSourceOffset folds accents when counting', () => {
    const content = 'coração e coracao';
    const accented = content.indexOf('coração');
    assert.equal(previewMarkIndexForSourceOffset(content, accented, 'coracao', 2), 0);
});

test('previewMarkIndexForSourceOffset ignores partial matches in exact mode', () => {
    const content = 'semestres, semestre, semestre';
    const firstExact = content.indexOf('semestre', 1);
    const secondExact = content.indexOf('semestre', firstExact + 1);

    assert.equal(previewMarkIndexForSourceOffset(content, firstExact, 'semestre', 2, true), 0);
    assert.equal(previewMarkIndexForSourceOffset(content, secondExact, 'semestre', 2, true), 1);
});
