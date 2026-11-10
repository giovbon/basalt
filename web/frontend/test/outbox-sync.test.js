import test from 'node:test';
import assert from 'node:assert/strict';

import { createOutboxSync } from '../src/lib/outbox-sync.js';

function fakeStore(ops = []) {
    const pending = new Map(ops.map((op) => [op.opId, { ...op }]));
    const calls = [];
    return {
        pending,
        calls,
        async pendingOps() {
            return [...pending.values()].sort((a, b) => a.seq - b.seq);
        },
        async ackOp(opId, { updatedAt } = {}) {
            const op = pending.get(opId);
            if (!op) return false;
            if (updatedAt !== undefined && op.updatedAt > updatedAt) return false;
            pending.delete(opId);
            calls.push(['ack', opId]);
            return true;
        },
        async failOp(opId, error) {
            const op = pending.get(opId);
            if (!op) return null;
            op.attempts = (op.attempts || 0) + 1;
            op.lastError = typeof error === 'string' ? error : error?.message;
            calls.push(['fail', opId, op.lastError]);
            return op;
        },
    };
}

const op = (seq, path, content = 'x') => ({
    seq,
    opId: `op-${seq}`,
    type: 'save',
    path,
    content,
    baseHash: 'hash',
    createdAt: seq,
    updatedAt: seq,
    attempts: 0,
});

test('replays operations in order and acknowledges each success', async () => {
    const sent = [];
    const store = fakeStore([op(1, 'a.md'), op(2, 'b.md')]);
    const sync = createOutboxSync({
        store,
        send: async (o) => {
            sent.push(o.path);
            return { ok: true, status: 200, hash: `h-${o.path}` };
        },
    });

    const summary = await sync.sync();

    assert.deepEqual(sent, ['a.md', 'b.md']);
    assert.deepEqual(summary, { synced: 2, conflicts: 0, failed: 0, stopped: false });
    assert.equal(store.pending.size, 0);
});

test('a transport failure stops the pass and keeps the rest queued', async () => {
    const sent = [];
    const store = fakeStore([op(1, 'a.md'), op(2, 'b.md')]);
    const sync = createOutboxSync({
        store,
        send: async (o) => {
            sent.push(o.path);
            throw new TypeError('Failed to fetch');
        },
    });

    const summary = await sync.sync();

    assert.deepEqual(sent, ['a.md']);
    assert.equal(summary.stopped, true);
    assert.equal(summary.failed, 1);
    assert.equal(store.pending.size, 2);
    assert.equal(store.pending.get('op-1').attempts, 1);
    assert.equal(store.pending.get('op-1').lastError, 'Failed to fetch');
});

test('a 409 is reported without dropping the local copy', async () => {
    const conflicts = [];
    const store = fakeStore([op(1, 'a.md'), op(2, 'b.md')]);
    const sync = createOutboxSync({
        store,
        send: async (o) => (o.path === 'a.md'
            ? { ok: false, status: 409, hash: 'server-hash' }
            : { ok: true, status: 200, hash: 'new-hash' }),
        onConflict: async (o, result) => conflicts.push([o.path, result.hash]),
    });

    const summary = await sync.sync();

    assert.deepEqual(conflicts, [['a.md', 'server-hash']]);
    assert.equal(summary.conflicts, 1);
    assert.equal(summary.synced, 1);
    assert.equal(store.pending.size, 1);
    assert.equal(store.pending.get('op-1').lastError, 'conflict');
    assert.equal(store.pending.has('op-2'), false);
});

test('a 5xx stops the pass, a 4xx does not', async () => {
    const store = fakeStore([op(1, 'a.md'), op(2, 'b.md')]);
    const sync = createOutboxSync({
        store,
        send: async () => ({ ok: false, status: 500, detail: 'boom' }),
    });

    const stopped = await sync.sync();
    assert.equal(stopped.stopped, true);
    assert.equal(store.pending.size, 2);

    const store2 = fakeStore([op(1, 'a.md'), op(2, 'b.md')]);
    const sent = [];
    const sync2 = createOutboxSync({
        store: store2,
        send: async (o) => {
            sent.push(o.path);
            return o.path === 'a.md'
                ? { ok: false, status: 400, detail: 'invalid path' }
                : { ok: true, status: 200, hash: 'h' };
        },
    });

    const continued = await sync2.sync();
    assert.deepEqual(sent, ['a.md', 'b.md']);
    assert.equal(continued.stopped, false);
    assert.equal(continued.failed, 1);
    assert.equal(store2.pending.size, 1);
});

test('sync is single-flight', async () => {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    let sends = 0;
    const store = fakeStore([op(1, 'a.md')]);
    const sync = createOutboxSync({
        store,
        send: async () => {
            sends += 1;
            await gate;
            return { ok: true, status: 200, hash: 'h' };
        },
    });

    const first = sync.sync();
    const second = sync.sync();
    assert.equal(sync.isRunning, true);
    release();

    const [a, b] = await Promise.all([first, second]);
    assert.equal(sends, 1);
    assert.equal(a, b);
    assert.equal(sync.isRunning, false);
});

test('a coalesced operation is not counted as synced but its callback still runs', async () => {
    const synced = [];
    const store = fakeStore([op(1, 'a.md')]);
    store.ackOp = async (opId, { updatedAt } = {}) => {
        // Simulate newer content arriving while the request was in flight.
        if (opId === 'op-1' && updatedAt !== undefined) return false;
        return true;
    };
    const sync = createOutboxSync({
        store,
        send: async () => ({ ok: true, status: 200, hash: 'h' }),
        onSynced: async (o) => synced.push(o.opId),
    });

    const summary = await sync.sync();

    assert.equal(summary.synced, 0);
    assert.deepEqual(synced, ['op-1']);
    assert.equal(store.pending.size, 1);
});
