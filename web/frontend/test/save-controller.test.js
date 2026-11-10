import test from 'node:test';
import assert from 'node:assert/strict';

import { createSaveController } from '../src/lib/save-controller.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function baseDeps(overrides = {}) {
    return {
        capture: () => ({ notePath: 'notes/a.md', content: 'v1', baseHash: 'h1' }),
        send: async () => ({ ok: true, status: 200, hash: 'h2' }),
        askConflict: async () => false,
        reload: async () => {},
        onSaved: () => {},
        onUnsaved: () => {},
        onError: () => {},
        onBusyChange: () => {},
        isCurrent: () => true,
        ...overrides,
    };
}

test('a save requested during an in-flight write is coalesced and uses the latest content', async () => {
    const sends = [];
    const first = deferred();
    let content = 'v1';

    const controller = createSaveController(baseDeps({
        capture: () => ({ notePath: 'notes/a.md', content, baseHash: 'h1' }),
        send: (payload) => {
            sends.push(payload);
            return sends.length === 1 ? first.promise : Promise.resolve({ ok: true, status: 200, hash: 'h3' });
        },
    }));

    const drain = controller.request();
    assert.equal(sends.length, 1);

    content = 'v2';
    controller.request();
    controller.request();
    assert.equal(sends.length, 1, 'only one write may be in flight');

    first.resolve({ ok: true, status: 200, hash: 'h2' });
    await drain;

    assert.equal(sends.length, 2, 'the queued writes collapse into a single follow-up');
    assert.equal(sends[1].content, 'v2', 'the follow-up captures the buffer at send time');
});

test('accepting the conflict overwrite retries once with the disk hash as base', async () => {
    const sends = [];
    const saved = [];

    const controller = createSaveController(baseDeps({
        capture: () => ({ notePath: 'notes/a.md', content: 'mine', baseHash: 'client-hash' }),
        send: async (payload) => {
            sends.push(payload);
            return sends.length === 1
                ? { ok: false, status: 409, hash: 'disk-hash' }
                : { ok: true, status: 200, hash: 'fresh-hash' };
        },
        askConflict: async () => true,
        onSaved: (payload, result) => saved.push({ payload, result }),
    }));

    await controller.request();

    assert.equal(sends.length, 2);
    assert.equal(sends[0].baseHash, 'client-hash');
    assert.equal(sends[1].baseHash, 'disk-hash');
    assert.equal(sends[1].content, 'mine');
    assert.equal(saved.length, 1);
});

test('a deleted note is a distinct conflict and is recreated only after confirmation', async () => {
    const sends = [];
    const conflicts = [];
    const controller = createSaveController(baseDeps({
        send: async (payload) => {
            sends.push(payload);
            return sends.length === 1
                ? { ok: false, status: 409, deleted: true }
                : { ok: true, status: 200, hash: 'recreated-hash' };
        },
        askConflict: async (notePath, details) => {
            conflicts.push({ notePath, details });
            return true;
        },
    }));

    await controller.request();

    assert.deepEqual(conflicts, [{
        notePath: 'notes/a.md',
        details: { deleted: true },
    }]);
    assert.equal(sends.length, 2);
    assert.equal(sends[1].baseHash, null, 'confirmed recreation should use an empty base hash');
});

test('declining the conflict reloads the disk version and drops the queued save', async () => {
    const sends = [];
    const reloads = [];
    let saved = 0;

    const controller = createSaveController(baseDeps({
        send: async (payload) => {
            sends.push(payload);
            return { ok: false, status: 409, hash: 'disk-hash' };
        },
        askConflict: async () => false,
        reload: async (notePath) => { reloads.push(notePath); },
        onSaved: () => { saved++; },
    }));

    const drain = controller.request();
    controller.request(); // typed while the request was in flight

    await drain;

    assert.equal(sends.length, 1);
    assert.deepEqual(reloads, ['notes/a.md']);
    assert.equal(saved, 0);
});

test('a conflict on a note the user already left does not prompt or overwrite', async () => {
    const unsaved = [];
    let prompted = 0;

    const controller = createSaveController(baseDeps({
        send: async () => ({ ok: false, status: 409, hash: 'disk-hash' }),
        isCurrent: () => false,
        askConflict: async () => { prompted++; return true; },
        onUnsaved: (notePath) => unsaved.push(notePath),
    }));

    await controller.request();

    assert.equal(prompted, 0);
    assert.deepEqual(unsaved, ['notes/a.md']);
});

test('save requests are ignored while the conflict prompt is open', async () => {
    const sends = [];
    const asked = deferred();
    const prompt = deferred();
    const reloads = [];
    let promptCalls = 0;

    const controller = createSaveController(baseDeps({
        send: async (payload) => {
            sends.push(payload);
            return { ok: false, status: 409, hash: 'disk-hash' };
        },
        askConflict: () => {
            promptCalls++;
            asked.resolve();
            return prompt.promise;
        },
        reload: async (notePath) => { reloads.push(notePath); },
    }));

    const drain = controller.request();
    await asked.promise;

    controller.request(); // must be dropped, not queued

    prompt.resolve(false);
    await drain;

    assert.equal(promptCalls, 1);
    assert.equal(sends.length, 1);
    assert.deepEqual(reloads, ['notes/a.md']);
});

test('a failed write reports the error and still drains a queued save', async () => {
    const sends = [];
    const first = deferred();
    const errors = [];
    const saved = [];

    const controller = createSaveController(baseDeps({
        send: (payload) => {
            sends.push(payload);
            return sends.length === 1 ? first.promise : Promise.resolve({ ok: true, status: 200, hash: 'h2' });
        },
        onError: (error) => errors.push(error),
        onSaved: (payload) => saved.push(payload),
    }));

    const drain = controller.request();
    controller.request();
    first.reject(new Error('network down'));

    await drain;

    assert.equal(sends.length, 2);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'network down');
    assert.equal(saved.length, 1);
});
