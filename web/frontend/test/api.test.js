import test from 'node:test';
import assert from 'node:assert/strict';

import * as api from '../src/core/api.js';

/**
 * Replace globalThis.fetch for one test. Returns the recorded calls and a
 * restore function so a failing assertion cannot leak the stub.
 */
function stubFetch(handler) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (path, init = {}) => {
        calls.push({ path, init });
        return handler(path, init);
    };
    return {
        calls,
        restore() { globalThis.fetch = original; },
    };
}

function jsonResponse(status, body, headers = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const response = {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(headers),
        text: async () => text,
        json: async () => JSON.parse(text),
        blob: async () => new Blob([text]),
        clone() { return this; },
    };
    return response;
}

test('getJSON issues a GET and parses the payload', async () => {
    const stub = stubFetch(() => jsonResponse(200, { notes: [] }));
    try {
        const data = await api.getJSON('/api/notes');
        assert.deepEqual(data, { notes: [] });
        assert.equal(stub.calls[0].path, '/api/notes');
        assert.equal(stub.calls[0].init.method, 'GET');
    } finally {
        stub.restore();
    }
});

test('json payloads are serialized with a Content-Type header', async () => {
    const stub = stubFetch(() => jsonResponse(200, { hash: 'abc' }));
    try {
        const data = await api.sendJSON('/api/notes/a.md', 'POST', { content: 'oi', base_hash: null });
        assert.deepEqual(data, { hash: 'abc' });
        assert.equal(stub.calls[0].init.method, 'POST');
        assert.equal(stub.calls[0].init.body, JSON.stringify({ content: 'oi', base_hash: null }));
        assert.equal(stub.calls[0].init.headers['Content-Type'], 'application/json');
    } finally {
        stub.restore();
    }
});

test('a caller-provided Content-Type is not overwritten', async () => {
    const stub = stubFetch(() => jsonResponse(200, {}));
    try {
        await api.request('/api/x', { method: 'POST', json: {}, headers: { 'content-type': 'application/merge-patch+json' } });
        assert.equal(stub.calls[0].init.headers['content-type'], 'application/merge-patch+json');
        assert.equal('Content-Type' in stub.calls[0].init.headers, false);
    } finally {
        stub.restore();
    }
});

test('non-2xx JSON responses become ApiError with status and detail', async () => {
    const stub = stubFetch(() => jsonResponse(409, { detail: 'já existe', hash: 'disk' }));
    try {
        await assert.rejects(
            () => api.getJSON('/api/notes/a.md'),
            (error) => {
                assert.ok(error instanceof api.ApiError);
                assert.equal(error.message, 'já existe');
                assert.equal(error.detail, 'já existe');
                assert.equal(error.status, 409);
                assert.equal(error.body.hash, 'disk');
                assert.equal(error.path, '/api/notes/a.md');
                return true;
            },
        );
    } finally {
        stub.restore();
    }
});

test('non-JSON and empty error bodies fall back to the status message', async () => {
    const stub = stubFetch(() => jsonResponse(502, '<html>bad gateway</html>'));
    try {
        await assert.rejects(
            () => api.getJSON('/api/notes'),
            (error) => {
                assert.ok(error instanceof api.ApiError);
                assert.equal(error.message, 'HTTP 502');
                assert.equal(error.detail, null);
                return true;
            },
        );
    } finally {
        stub.restore();
    }
});

test('getText returns the body and throws on error', async () => {
    let stub = stubFetch(() => jsonResponse(200, 'body { color: red }'));
    try {
        assert.equal(await api.getText('/api/themes/dark'), 'body { color: red }');
    } finally {
        stub.restore();
    }

    stub = stubFetch(() => jsonResponse(404, { detail: 'sem tema' }));
    try {
        await assert.rejects(() => api.getText('/api/themes/nope'), /sem tema/);
    } finally {
        stub.restore();
    }
});

test('sendJSON returns null for 204 and otherwise parses the body', async () => {
    let stub = stubFetch(() => jsonResponse(204, ''));
    try {
        assert.equal(await api.sendJSON('/api/folders', 'POST', { path: 'a' }), null);
    } finally {
        stub.restore();
    }

    stub = stubFetch(() => jsonResponse(200, { ok: true }));
    try {
        assert.deepEqual(await api.sendJSON('/api/folders', 'POST', { path: 'a' }), { ok: true });
    } finally {
        stub.restore();
    }
});

test('FormData passes through untouched (browser sets the boundary)', async () => {
    const form = new FormData();
    form.append('file', new Blob(['x']), 'a.txt');
    const stub = stubFetch(() => jsonResponse(200, { path: 'a.txt' }));
    try {
        const data = await api.sendJSON('/api/upload-media', 'POST', form);
        assert.deepEqual(data, { path: 'a.txt' });
        assert.equal(stub.calls[0].init.body, form);
        assert.deepEqual(stub.calls[0].init.headers, {});
    } finally {
        stub.restore();
    }
});

test('raw never throws on non-2xx so callers can inspect the status', async () => {
    const stub = stubFetch(() => jsonResponse(404, { detail: 'missing' }));
    try {
        const response = await api.raw('/api/notes/gone.md');
        assert.equal(response.status, 404);
        assert.equal(response.ok, false);
        assert.deepEqual(await response.json(), { detail: 'missing' });
    } finally {
        stub.restore();
    }
});

test('raw and request prepare the same method, headers, body, and signal', async () => {
    const stub = stubFetch(() => jsonResponse(200, {}));
    const signal = new AbortController().signal;
    const options = {
        method: 'PATCH',
        json: { value: 1 },
        headers: { authorization: 'Bearer test', 'content-type': 'application/custom+json' },
        signal,
    };
    try {
        await api.request('/api/request', options);
        await api.raw('/api/raw', options);
        assert.deepEqual(stub.calls[0].init, stub.calls[1].init);
        assert.equal(stub.calls[0].init.signal, signal);
        assert.equal(stub.calls[1].init.body, JSON.stringify(options.json));
    } finally {
        stub.restore();
    }
});

test('send resolves with the response for fire-and-forget writes', async () => {
    const stub = stubFetch(() => jsonResponse(200, ''));
    try {
        const response = await api.send('/api/notes/a.md', 'DELETE');
        assert.equal(response.status, 200);
        assert.equal(stub.calls[0].init.method, 'DELETE');
        assert.equal(stub.calls[0].init.body, undefined);
    } finally {
        stub.restore();
    }
});
