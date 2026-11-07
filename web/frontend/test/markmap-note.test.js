import test from 'node:test';
import assert from 'node:assert/strict';

import { getFrontmatterAndBody, isMarkmapNote } from '../src/lib/markmap-note.js';

test('identifies markmap note type in frontmatter', () => {
    assert.equal(isMarkmapNote('---\nnote-type: markmap\n---\n# Topic'), true);
    assert.equal(isMarkmapNote('---\ntitle: Mind map\nnote-type: "markmap"\n---\n# Topic'), true);
});

test('does not identify markmap outside frontmatter or in another field', () => {
    assert.equal(isMarkmapNote('# note-type: markmap'), false);
    assert.equal(isMarkmapNote('---\ntitle: markmap\n---\n# Topic'), false);
    assert.equal(isMarkmapNote('---\nnote-type: markdown\n---\n# Topic'), false);
    assert.equal(isMarkmapNote('---\nnote-type: markmap'), false);
});

test('returns markdown body without frontmatter', () => {
    assert.deepEqual(getFrontmatterAndBody('---\ntitle: Topic\n---\n\n# Topic\n\n- Child'), {
        frontmatter: 'title: Topic',
        body: '# Topic\n\n- Child',
    });
    assert.deepEqual(getFrontmatterAndBody('# Topic'), {
        frontmatter: '',
        body: '# Topic',
    });
});
