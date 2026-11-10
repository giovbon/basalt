import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDB } from 'idb';

import {
    createOfflineStore,
    OfflineUnavailableError,
} from '../src/lib/offline-store.js';

function dbName() {
    return `basalt-test-${crypto.randomUUID()}`;
}

// Deterministic clock: the store accepts now() as an option, so createdAt and
// updatedAt assertions do not depend on how fast the test runs.
function clock(start = 1000) {
    let value = start;
    const now = () => value;
    now.tick = (ms = 1) => {
        value += ms;
        return value;
    };
    return now;
}

function storeFor(t, options = {}) {
    const store = createOfflineStore({ dbName: dbName(), ...options });
    t.after(() => store.close());
    return store;
}

test('reports unavailable when IndexedDB cannot be opened', async (t) => {
    const store = createOfflineStore({
        dbName: dbName(),
        openDatabase: () => {
            throw new ReferenceError('indexedDB is not defined');
        },
    });
    t.after(() => store.close());

    assert.equal(store.isAvailable, null);
    assert.equal(await store.open(), false);
    assert.equal(store.isAvailable, false);

    await assert.rejects(() => store.getSummary('a.md'), OfflineUnavailableError);
    await assert.rejects(
        () => store.queueSave({ path: 'a.md', content: 'x' }),
        OfflineUnavailableError,
    );
});

test('retries after a failed open instead of caching the failure', async (t) => {
    let attempts = 0;
    const store = createOfflineStore({
        dbName: dbName(),
        openDatabase: (...args) => {
            attempts += 1;
            if (attempts === 1) return Promise.reject(new Error('blocked'));
            return openDB(...args);
        },
    });
    t.after(() => store.close());

    assert.equal(await store.open(), false);
    assert.equal(store.isAvailable, false);

    assert.equal(await store.open(), true);
    assert.equal(store.isAvailable, true);
    assert.equal(attempts, 2);
});

test('caches note summaries without their content', async (t) => {
    const now = clock(100);
    const store = storeFor(t, { now });

    const saved = await store.putSummary({
        path: 'a.md',
        name: 'a',
        folder: '',
        content: '# A',
        tags: ['one'],
        modified: '2026-01-01T00:00:00Z',
    });
    assert.equal(saved.cachedAt, 100);
    assert.equal(saved.content, undefined);

    now.tick(50);
    await store.putSummary({ path: 'folder/b.md', content: '# B' });

    assert.equal((await store.getSummary('a.md')).tags[0], 'one');
    assert.equal(await store.getSummary('missing.md'), undefined);

    assert.deepEqual((await store.listSummaries()).map((n) => n.path), [
        'a.md',
        'folder/b.md',
    ]);
    assert.equal(await store.countSummaries(), 2);

    await store.putSummaries([
        { path: 'c.md', content: '# C' },
        { path: 'd.md', content: '# D' },
    ]);
    assert.equal(await store.countSummaries(), 4);
    assert.equal((await store.getSummary('c.md')).content, undefined);
});

test('caches full note documents separately from summaries', async (t) => {
    const now = clock(200);
    const store = storeFor(t, { now });

    const doc = await store.putDocument({
        path: 'a.md',
        content: '# A',
        hash: 'hash-a',
        outline: [{ level: 1, text: 'A' }],
    });
    assert.equal(doc.cachedAt, 200);

    const loaded = await store.getDocument('a.md');
    assert.equal(loaded.content, '# A');
    assert.equal(loaded.hash, 'hash-a');
    assert.deepEqual(loaded.outline, [{ level: 1, text: 'A' }]);
    assert.equal(await store.getDocument('missing.md'), undefined);

    await assert.rejects(
        () => store.putDocument({ path: 'empty.md' }),
        TypeError,
    );
});

test('replaceSummaries mirrors the listing and drops vanished notes', async (t) => {
    const store = storeFor(t);

    await store.putSummaries([
        { path: 'a.md', name: 'a' },
        { path: 'gone.md', name: 'gone' },
    ]);
    assert.equal(await store.countSummaries(), 2);

    await store.replaceSummaries([
        { path: 'a.md', name: 'a', content: '# A' },
        { path: 'b.md', name: 'b', content: '# B' },
    ]);

    assert.deepEqual(
        (await store.listSummaries()).map((note) => note.path).sort(),
        ['a.md', 'b.md'],
    );
    assert.equal((await store.getSummary('a.md')).content, undefined);
    assert.equal(await store.getSummary('gone.md'), undefined);

    await assert.rejects(() => store.replaceSummaries('nope'), TypeError);
});

test('deleteNote and clearNotes drop summaries and documents together', async (t) => {
    const store = storeFor(t);

    await store.putSummary({ path: 'a.md', content: '# A' });
    await store.putSummary({ path: 'b.md', content: '# B' });
    await store.putDocument({ path: 'a.md', content: '# A' });
    await store.putDocument({ path: 'b.md', content: '# B' });

    await store.deleteNote('a.md');
    assert.equal(await store.getSummary('a.md'), undefined);
    assert.equal(await store.getDocument('a.md'), undefined);
    assert.equal(await store.countSummaries(), 1);

    await store.clearNotes();
    assert.equal(await store.countSummaries(), 0);
    assert.equal(await store.getDocument('b.md'), undefined);
});

test('rejects malformed notes before touching the database', async (t) => {
    const store = storeFor(t);

    await assert.rejects(() => store.putSummary({ content: 'no path' }), TypeError);
    await assert.rejects(() => store.putSummary({ path: '' }), TypeError);
    await assert.rejects(() => store.putSummaries('not an array'), TypeError);
    await assert.rejects(() => store.putSummaries([{ content: 'no path' }]), TypeError);
    assert.equal(await store.putSummaries([]), 0);
});

test('coalesces repeated saves of the same note into one outbox entry', async (t) => {
    const now = clock(1000);
    const store = storeFor(t, { now });

    const first = await store.queueSave({
        path: 'a.md',
        content: 'v1',
        baseHash: 'hash-0',
    });
    now.tick(10);
    const second = await store.queueSave({
        path: 'a.md',
        content: 'v2',
        baseHash: 'hash-1',
    });

    assert.equal(second.opId, first.opId);
    assert.equal(second.seq, first.seq);
    assert.equal(second.content, 'v2');
    // The first base hash is the version the offline edit started from; the
    // second one refers to content the server has not seen yet.
    assert.equal(second.baseHash, 'hash-0');
    assert.equal(second.createdAt, 1000);
    assert.equal(second.updatedAt, 1010);
    assert.equal(await store.pendingCount(), 1);

    const [stored] = await store.pendingOps();
    assert.equal(stored.content, 'v2');
});

test('keeps different notes separate and replays them in insertion order', async (t) => {
    const now = clock(2000);
    const store = storeFor(t, { now });

    const a = await store.queueSave({ path: 'a.md', content: 'a1', baseHash: 'a0' });
    now.tick(10);
    const b = await store.queueSave({ path: 'b.md', content: 'b1', baseHash: 'b0' });
    now.tick(10);
    const aAgain = await store.queueSave({ path: 'a.md', content: 'a2' });

    assert.notEqual(a.opId, b.opId);
    assert.equal(aAgain.seq, a.seq);

    const ops = await store.pendingOps();
    assert.deepEqual(ops.map((op) => op.path), ['a.md', 'b.md']);
    assert.deepEqual(ops.map((op) => op.seq), [a.seq, b.seq]);
    assert.deepEqual(ops.map((op) => op.content), ['a2', 'b1']);
});

test('ackOp refuses to drop content coalesced while the request was in flight', async (t) => {
    const now = clock(3000);
    const store = storeFor(t, { now });

    const op = await store.queueSave({ path: 'a.md', content: 'v1', baseHash: 'h0' });
    now.tick(10);
    const merged = await store.queueSave({ path: 'a.md', content: 'v2' });

    // The replay holds the old snapshot, so its ack must not delete v2.
    assert.equal(await store.ackOp(op.opId, { updatedAt: op.updatedAt }), false);
    assert.equal(await store.pendingCount(), 1);
    assert.equal((await store.getOp(op.opId)).content, 'v2');

    // Replaying again (or the caller passing no guard) removes it.
    assert.equal(await store.ackOp(op.opId, { updatedAt: merged.updatedAt }), true);
    assert.equal(await store.pendingCount(), 0);
    assert.equal(await store.ackOp(op.opId), false);
});

test('rebasePath points queued saves at the version the server accepted', async (t) => {
    const now = clock(3500);
    const store = storeFor(t, { now });

    const op = await store.queueSave({ path: 'a.md', content: 'v1', baseHash: 'h0' });
    now.tick(10);
    await store.queueSave({ path: 'a.md', content: 'v2' });
    await store.queueSave({ path: 'b.md', content: 'b', baseHash: 'other' });

    assert.equal(await store.rebasePath('a.md', 'h1'), 1);
    const rebased = await store.getOp(op.opId);
    assert.equal(rebased.baseHash, 'h1');
    assert.equal(rebased.content, 'v2');
    assert.equal(rebased.createdAt, op.createdAt);
    // Other notes keep their own base version.
    const other = (await store.pendingOps()).find((o) => o.path === 'b.md');
    assert.equal(other.baseHash, 'other');

    // No queued work for the path is a no-op, not an error.
    assert.equal(await store.rebasePath('missing.md', 'h2'), 0);
    await assert.rejects(() => store.rebasePath('', 'h2'), TypeError);
});

test('failOp records the attempt and keeps the operation queued', async (t) => {
    const now = clock(4000);
    const store = storeFor(t, { now });

    const op = await store.queueSave({ path: 'a.md', content: 'v1', baseHash: 'h0' });
    const failed = await store.failOp(op.opId, new Error('network down'));

    assert.equal(failed.attempts, 1);
    assert.equal(failed.lastError, 'network down');
    assert.equal(failed.updatedAt, op.updatedAt);
    assert.equal(failed.lastAttemptAt, 4000);

    now.tick(100);
    const again = await store.failOp(op.opId, 'still offline');
    assert.equal(again.attempts, 2);
    assert.equal(again.lastError, 'still offline');
    assert.equal(again.lastAttemptAt, 4100);

    assert.equal(await store.failOp('missing-op', 'x'), null);
    assert.equal(await store.pendingCount(), 1);
});

test('removeOp and clearOutbox drop queued work', async (t) => {
    const store = storeFor(t);

    const a = await store.queueSave({ path: 'a.md', content: 'a' });
    await store.queueSave({ path: 'b.md', content: 'b' });

    assert.equal(await store.removeOp(a.opId), true);
    assert.equal(await store.removeOp(a.opId), false);
    assert.equal(await store.pendingCount(), 1);

    await store.clearOutbox();
    assert.equal(await store.pendingCount(), 0);
});

test('stores sync metadata with a fallback', async (t) => {
    const store = storeFor(t);

    assert.equal(await store.getMeta('lastSyncAt', 0), 0);
    await store.setMeta('lastSyncAt', 1234);
    assert.equal(await store.getMeta('lastSyncAt'), 1234);

    await store.deleteMeta('lastSyncAt');
    assert.equal(await store.getMeta('lastSyncAt', null), null);
});

test('clearAll wipes summaries, documents, outbox and metadata', async (t) => {
    const store = storeFor(t);

    await store.putSummary({ path: 'a.md', content: '# A' });
    await store.putDocument({ path: 'a.md', content: '# A' });
    await store.queueSave({ path: 'a.md', content: '# A' });
    await store.setMeta('lastSyncAt', 42);

    await store.clearAll();

    assert.equal(await store.countSummaries(), 0);
    assert.equal(await store.getDocument('a.md'), undefined);
    assert.equal(await store.pendingCount(), 0);
    assert.equal(await store.getMeta('lastSyncAt'), null);
});

test('data survives closing and reopening the same database', async (t) => {
    const name = dbName();
    const first = createOfflineStore({ dbName: name });
    await first.putSummary({ path: 'a.md', name: 'a' });
    await first.putDocument({ path: 'a.md', content: '# A', hash: 'h1' });
    const op = await first.queueSave({
        path: 'a.md',
        content: '# A edited',
        baseHash: 'h1',
    });
    await first.close();

    const second = createOfflineStore({ dbName: name });
    t.after(() => second.close());

    assert.equal(await second.open(), true);
    assert.equal((await second.getDocument('a.md')).content, '# A');
    assert.equal((await second.getSummary('a.md')).name, 'a');
    const [stored] = await second.pendingOps();
    assert.equal(stored.opId, op.opId);
    assert.equal(stored.content, '# A edited');
});
