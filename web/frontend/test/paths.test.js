import test from 'node:test';
import assert from 'node:assert/strict';

import { folderFromPath, filenameFromPath, inferTypeFromPath, foldersFromNotes, offlineStamp, conflictCopyPath } from '../src/lib/paths.js';

test('folderFromPath returns the parent folder or an empty string', () => {
    assert.equal(folderFromPath('a/b/nota.md'), 'a/b');
    assert.equal(folderFromPath('nota.md'), '');
});

test('filenameFromPath returns the last segment', () => {
    assert.equal(filenameFromPath('a/b/nota.md'), 'nota.md');
    assert.equal(filenameFromPath('nota.md'), 'nota.md');
});

test('inferTypeFromPath classifies supported media', () => {
    assert.equal(inferTypeFromPath('a/nota.md'), 'note');
    assert.equal(inferTypeFromPath('a/sem-extensao'), 'note');
    assert.equal(inferTypeFromPath('a/foto.PNG'), 'image');
    assert.equal(inferTypeFromPath('a/foto.webp'), 'image');
    assert.equal(inferTypeFromPath('a/som.mp3'), 'audio');
    assert.equal(inferTypeFromPath('a/video.webm'), 'video');
    assert.equal(inferTypeFromPath('a/doc.pdf'), 'document');
    assert.equal(inferTypeFromPath('a/arquivo.zip'), 'note');
});

test('foldersFromNotes rebuilds every ancestor folder once', () => {
    assert.deepEqual(
        foldersFromNotes([
            { path: 'a/b/c.md', folder: 'a/b' },
            { path: 'a/d.md', folder: 'a' },
            { path: 'root.md', folder: '' },
            { path: 'x/y.md' },
        ]),
        ['a', 'a/b', 'x'],
    );
});

test('offlineStamp is filename friendly and zero padded', () => {
    assert.equal(
        offlineStamp(new Date(2026, 0, 2, 3, 4, 5)),
        '20260102-030405',
    );
});

test('conflictCopyPath keeps the folder and caps the stem', () => {
    assert.equal(
        conflictCopyPath('a/b/nota.md', '20260102-030405'),
        'a/b/nota.offline-conflict-20260102-030405.md',
    );
    assert.equal(
        conflictCopyPath('nota.md', 'stamp'),
        'nota.offline-conflict-stamp.md',
    );

    const long = conflictCopyPath(`${'x'.repeat(260)}.md`, 'stamp');
    assert.ok(long.length <= 203);
    assert.ok(long.endsWith('.offline-conflict-stamp.md'));
});
