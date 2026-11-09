import test from 'node:test';
import assert from 'node:assert/strict';

import {
    searchHiddenRegions,
    spanOverlapsRegions,
    sourceOffsetForLineColumn,
    previewMarkIndexForSourceOffset,
    previewMarkIndexForSourceOffsetBestEffort,
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

test('frontmatter is hidden but code bodies are visible', () => {
    const frontmatter = '---\ntitle: alpha\n---\nalpha';
    assert.ok(isHidden(frontmatter, 'title: alpha'));
    assert.ok(!isHidden(frontmatter, '\nalpha'));

    // The fence line (including its language) is not rendered, but the code
    // body is: highlightInPreview marks it too.
    const fenced = 'alpha\n```js\nalpha\n```';
    const regions = searchHiddenRegions(fenced);
    const visible = fenced.indexOf('alpha');
    const code = fenced.lastIndexOf('alpha');
    assert.equal(spanOverlapsRegions(regions, visible, visible + 5), false);
    assert.equal(spanOverlapsRegions(regions, code, code + 5), false);
    assert.ok(isHidden(fenced, '```js'));

    // Fences the renderer replaces are entirely hidden.
    assert.ok(isHidden('```mermaid\ngraph TD\nalpha\n```', 'graph TD'));
    assert.ok(isHidden('```query\ntype: table\nalpha\n```', 'type: table'));
    assert.ok(isHidden('```basalt-query\nlimit: 1\nalpha\n```', 'limit: 1'));
});

test('indented code is visible text, not markup', () => {
    const content = 'intro\n\n    alpha <b>beta</b>\n';
    assert.ok(!isHidden(content, 'alpha'));
    assert.ok(!isHidden(content, '<b>'));
});

test('inline code, HTML and comments are handled', () => {
    // Inline code is rendered, so its text is highlightable. Markdown-looking
    // content inside it is literal, though.
    assert.ok(!isHidden('a `alpha` b', 'alpha'));
    assert.ok(!isHidden('a `<span class="alpha">` b', 'span class='));
    assert.ok(!isHidden('a `[alpha](x)` b', '[alpha](x)'));
    assert.ok(!isHidden('a `alpha` b', ' b'));
    assert.ok(isHidden('a <span class="alpha">x</span>', 'span class='));
    assert.ok(isHidden('a <!-- alpha --> b', '<!-- alpha -->'));
    assert.ok(isHidden('a <!DOCTYPE alpha>', '<!DOCTYPE alpha>'));
});

test('task markers are hidden because they render as checkboxes', () => {
    assert.ok(isHidden('- [x] done', '[x]'));
    assert.ok(isHidden('- [ ] open', '[ ]'));
    assert.ok(!isHidden('- [x] done', 'done'));
});

test('link and image destinations are hidden but visible text is not', () => {
    assert.ok(isHidden('[text](https://alpha.example)', 'https://alpha.example'));
    assert.ok(!isHidden('[alpha](x)', '[alpha'));
    assert.ok(isHidden('![alt alpha](img.png)', '![alt alpha]'));
    assert.ok(isHidden('![alt alpha](img-alpha.png)', 'img-alpha.png'));
    assert.ok(isHidden('![[alpha.png]]', '![[alpha.png]]'));
});

test('the target half of a wikilink alias is hidden', () => {
    assert.ok(isHidden('[[alpha|display]]', '[[alpha|'));
    assert.ok(!isHidden('[[alpha|display]]', 'display'));
    assert.ok(!isHidden('[[alpha]]', '[[alpha]]'), 'without an alias the target is visible');
});

test('reference definitions and reference labels are hidden', () => {
    assert.ok(isHidden('[ref]: https://alpha.example', '[ref]:'));
    assert.ok(isHidden('see [alpha text][alpha-ref]', '[alpha-ref]'));
    assert.ok(!isHidden('see [alpha text][alpha-ref]', 'alpha text'));
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
    const code = content.lastIndexOf('alpha');

    assert.equal(previewMarkIndexForSourceOffset(content, first, 'alpha', 3), 0);
    assert.equal(previewMarkIndexForSourceOffset(content, second, 'alpha', 3), 1);
    assert.equal(previewMarkIndexForSourceOffset(content, code, 'alpha', 3), 2);
    assert.equal(previewMarkIndexForSourceOffset(content, first, 'alpha', 2), -2, 'count mismatch');
    assert.equal(previewMarkIndexForSourceOffset('', 0, 'alpha', 1), -2);
});

test('best-effort mapping keeps the source rank when only the total disagrees', () => {
    const content = 'alpha beta alpha `alpha`';
    const second = content.indexOf('alpha', content.indexOf('alpha') + 1);

    assert.equal(previewMarkIndexForSourceOffset(content, second, 'alpha', 2), -2);
    assert.equal(previewMarkIndexForSourceOffsetBestEffort(content, second, 'alpha', 2), 1);

    const hidden = '---\nalpha\n---\nalpha';
    const hiddenOffset = hidden.indexOf('alpha');
    assert.equal(previewMarkIndexForSourceOffsetBestEffort(hidden, hiddenOffset, 'alpha', 1), -1);
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
