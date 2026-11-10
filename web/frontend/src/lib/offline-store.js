// Offline cache and outbox.
//
// IndexedDB is wrapped behind intention-level methods so no Alpine component
// has to know about database names, object stores, transactions or the idb
// API. This module is additive: callers that never touch it keep the current
// online-only behaviour, and nothing here runs at import time.
//
// Contract:
// - open() resolves true when IndexedDB is usable and false when the browser
//   cannot provide it (private mode, disabled, tests without a fake). It never
//   throws, so callers can fall back to online-only without a try/catch.
// - Every other method rejects with OfflineUnavailableError when the store is
//   unavailable. That keeps "not cached" (undefined) distinct from "there is
//   no cache", which a silent no-op would conflate.
// - queueSave() coalesces consecutive saves of the same note into one outbox
//   entry, keeping the first opId and the first baseHash. baseHash is the
//   server version the local edit started from, so replay stays a
//   compare-and-swap (see vault.SaveNoteIfHash on the Go side).
// - The outbox is ordered by the auto-increment seq key, i.e. insertion order.
//   createdAt is informational; it must not be used for ordering because two
//   operations can land in the same millisecond.
//
// Schema (version 1):
//   notes     : { path, name, folder, type, size, modified, tags, cachedAt }
//   documents : { path, content, hash, outline, frontmatter, metadata,
//                 tags, backlinks, cachedAt }
//   outbox    : { seq, opId, type: 'save', path, baseHash, content,
//                 createdAt, updatedAt, attempts, lastError, lastAttemptAt }
//   meta      : { key, value }
//
// Summaries and full documents live in separate stores on purpose: the sidebar
// needs every note's metadata on startup, but pulling every note's text out of
// IndexedDB would be wasteful on a large vault. listSummaries() stays small;
// getDocument() is only called when a note is opened.
//
// Usage (see app/notes.js and app/bootstrap.js for the real call sites):
//   const store = createOfflineStore();
//   if (await store.open()) await store.replaceSummaries(notes);
//   await store.putDocument(note);
//   await store.queueSave({ path, content, baseHash });
//   for (const op of await store.pendingOps()) {
//       const result = await post(op);                    // POST /api/notes/{path}
//       if (result.ok) await store.ackOp(op.opId, { updatedAt: op.updatedAt });
//       else await store.failOp(op.opId, result.error);
//   }

import { openDB } from 'idb';

export const DB_NAME = 'basalt-offline';
export const DB_VERSION = 1;

export const STORE_NOTES = 'notes';
export const STORE_DOCUMENTS = 'documents';
export const STORE_OUTBOX = 'outbox';
export const STORE_META = 'meta';

export const OP_SAVE = 'save';

export class OfflineUnavailableError extends Error {
    constructor(cause) {
        super('Offline storage is unavailable');
        this.name = 'OfflineUnavailableError';
        if (cause !== undefined) this.cause = cause;
    }
}

function newOpId() {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
    return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function upgrade(db) {
    if (!db.objectStoreNames.contains(STORE_NOTES)) {
        // path is the identity used by every API and by the save protocol, so
        // the local cache is keyed the same way.
        db.createObjectStore(STORE_NOTES, { keyPath: 'path' });
    }
    if (!db.objectStoreNames.contains(STORE_DOCUMENTS)) {
        db.createObjectStore(STORE_DOCUMENTS, { keyPath: 'path' });
    }
    if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        const outbox = db.createObjectStore(STORE_OUTBOX, {
            keyPath: 'seq',
            autoIncrement: true,
        });
        // opId is the idempotency key sent to the server; pendingOps() uses the
        // primary key order, so no extra index is needed for FIFO.
        outbox.createIndex('by-opId', 'opId', { unique: true });
        outbox.createIndex('by-path', 'path');
    }
    if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
    }
}

export function createOfflineStore({
    // Injection point for tests. The default is idb's openDB, which uses the
    // global indexedDB; passing a function keeps the module testable without
    // installing globals.
    openDatabase = openDB,
    dbName = DB_NAME,
    version = DB_VERSION,
    // Injection point for tests that need deterministic timestamps.
    now = Date.now,
} = {}) {
    const usesDefaultOpener = openDatabase === openDB;

    let dbPromise = null;
    // null = not probed yet, true/false = result of the last attempt.
    let available = null;
    let unsupported = false;

    function resetConnection() {
        const pending = dbPromise;
        dbPromise = null;
        available = null;
        // Close asynchronously: blocking()/terminated() and close() must not
        // throw if the connection never finished opening. Returning the
        // promise lets callers await the close when they need to.
        if (!pending) return Promise.resolve();
        return pending.then((db) => db.close()).catch(() => {});
    }

    function schema() {
        return {
            upgrade,
            // Another tab wants to upgrade the schema: release this connection
            // so it does not stay blocked. The next call reopens it.
            blocking() {
                resetConnection();
            },
            terminated() {
                resetConnection();
            },
        };
    }

    async function getDB() {
        if (unsupported) throw new OfflineUnavailableError();

        let connection = dbPromise;
        if (!connection) {
            if (usesDefaultOpener && typeof globalThis.indexedDB === 'undefined') {
                unsupported = true;
                available = false;
                throw new OfflineUnavailableError();
            }
            try {
                connection = openDatabase(dbName, version, schema());
            } catch (error) {
                available = false;
                throw new OfflineUnavailableError(error);
            }
            dbPromise = connection;
            // A rejected open is usually transient (blocked upgrade while
            // another tab holds an old version), so do not cache the failure:
            // the next call retries. The catch also prevents an unhandled
            // rejection warning. Comparing against `connection` avoids wiping
            // a newer attempt started after this one.
            connection.catch(() => {
                if (dbPromise === connection) dbPromise = null;
                available = false;
            });
        }

        // Read the snapshot captured above: the catch handler may have reset
        // dbPromise before this continuation runs.
        try {
            const db = await connection;
            available = true;
            return db;
        } catch (error) {
            available = false;
            throw new OfflineUnavailableError(error);
        }
    }

    async function open() {
        try {
            await getDB();
            return true;
        } catch {
            return false;
        }
    }

    function assertNote(note) {
        if (!note || typeof note.path !== 'string' || note.path === '') {
            throw new TypeError('note requires a non-empty path');
        }
    }

    // ---------------------------------------------------------------------
    // Note summaries (sidebar metadata) and full documents (offline reading)
    // ---------------------------------------------------------------------

    async function getSummary(path) {
        const db = await getDB();
        return db.get(STORE_NOTES, path);
    }

    async function putSummary(note) {
        assertNote(note);
        const { content, ...summary } = note;
        const db = await getDB();
        const record = { ...summary, cachedAt: now() };
        await db.put(STORE_NOTES, record);
        return record;
    }

    async function putSummaries(notes) {
        if (!Array.isArray(notes)) {
            throw new TypeError('putSummaries requires an array');
        }
        notes.forEach(assertNote);
        if (notes.length === 0) return 0;

        const db = await getDB();
        const cachedAt = now();
        // Content belongs to the documents store; dropping it here keeps the
        // listing payload small even when callers pass full records.
        const tx = db.transaction(STORE_NOTES, 'readwrite');
        await Promise.all(notes.map((note) => {
            const { content, ...summary } = note;
            return tx.store.put({ ...summary, cachedAt });
        }));
        await tx.done;
        return notes.length;
    }

    // replaceSummaries mirrors a full /api/notes listing: notes that no longer
    // exist on the server are dropped from the cache too, so the offline
    // sidebar does not keep showing deleted files.
    async function replaceSummaries(notes) {
        if (!Array.isArray(notes)) {
            throw new TypeError('replaceSummaries requires an array');
        }
        notes.forEach(assertNote);

        const db = await getDB();
        const cachedAt = now();
        const keep = new Set(notes.map((note) => note.path));
        const tx = db.transaction(STORE_NOTES, 'readwrite');
        const stalePaths = (await tx.store.getAllKeys()).filter((path) => !keep.has(path));
        await Promise.all(stalePaths.map((path) => tx.store.delete(path)));
        await Promise.all(notes.map((note) => {
            const { content, ...summary } = note;
            return tx.store.put({ ...summary, cachedAt });
        }));
        await tx.done;
        return notes.length;
    }

    async function listSummaries() {
        const db = await getDB();
        return db.getAll(STORE_NOTES);
    }

    async function countSummaries() {
        const db = await getDB();
        return db.count(STORE_NOTES);
    }

    async function getDocument(path) {
        const db = await getDB();
        return db.get(STORE_DOCUMENTS, path);
    }

    // putDocument stores whatever GET /api/notes/{path} returned, so an
    // offline open can hydrate the editor, outline, frontmatter and backlinks
    // without the server.
    async function putDocument(note) {
        assertNote(note);
        if (typeof note.content !== 'string') {
            throw new TypeError('document requires string content');
        }
        const db = await getDB();
        const record = { ...note, cachedAt: now() };
        await db.put(STORE_DOCUMENTS, record);
        return record;
    }

    async function deleteNote(path) {
        const db = await getDB();
        const tx = db.transaction([STORE_NOTES, STORE_DOCUMENTS], 'readwrite');
        await Promise.all([
            tx.objectStore(STORE_NOTES).delete(path),
            tx.objectStore(STORE_DOCUMENTS).delete(path),
        ]);
        await tx.done;
    }

    async function clearNotes() {
        const db = await getDB();
        const tx = db.transaction([STORE_NOTES, STORE_DOCUMENTS], 'readwrite');
        await Promise.all([
            tx.objectStore(STORE_NOTES).clear(),
            tx.objectStore(STORE_DOCUMENTS).clear(),
        ]);
        await tx.done;
    }

    // ---------------------------------------------------------------------
    // Outbox
    // ---------------------------------------------------------------------

    // queueSave records the latest content for a note and returns the stored
    // operation. Repeated calls for the same path (the normal case while
    // offline) update the pending entry instead of appending, so reconnecting
    // sends one save per note rather than one per autosave tick.
    async function queueSave({ path, content, baseHash = '' } = {}) {
        if (typeof path !== 'string' || path === '') {
            throw new TypeError('queueSave requires a non-empty path');
        }
        if (typeof content !== 'string') {
            throw new TypeError('queueSave requires string content');
        }
        if (typeof baseHash !== 'string') {
            throw new TypeError('queueSave requires a string baseHash');
        }

        const db = await getDB();
        const tx = db.transaction(STORE_OUTBOX, 'readwrite');
        const existing = await tx.store.index('by-path').getAll(path);
        const pendingSave = existing
            .filter((op) => op.type === OP_SAVE)
            .sort((a, b) => a.seq - b.seq)[0];

        const timestamp = now();
        let op;
        if (pendingSave) {
            op = {
                ...pendingSave,
                content,
                updatedAt: timestamp,
            };
        } else {
            op = {
                opId: newOpId(),
                type: OP_SAVE,
                path,
                // Keep the version the first offline edit was based on. A
                // later baseHash belongs to content the server has not seen
                // yet, so replacing it would turn the CAS into an overwrite.
                baseHash,
                content,
                createdAt: timestamp,
                updatedAt: timestamp,
                attempts: 0,
                lastError: null,
                lastAttemptAt: null,
            };
        }

        // add() assigns seq for new entries; put() keeps the existing one.
        if (pendingSave) {
            await tx.store.put(op);
        } else {
            op.seq = await tx.store.add(op);
        }
        await tx.done;
        return op;
    }

    // pendingOps returns the outbox in insertion order, ready to replay.
    async function pendingOps() {
        const db = await getDB();
        return db.getAll(STORE_OUTBOX);
    }

    async function pendingCount() {
        const db = await getDB();
        return db.count(STORE_OUTBOX);
    }

    async function getOp(opId) {
        const db = await getDB();
        const tx = db.transaction(STORE_OUTBOX, 'readonly');
        const seq = await tx.store.index('by-opId').getKey(opId);
        if (seq === undefined) {
            await tx.done;
            return undefined;
        }
        const op = await tx.store.get(seq);
        await tx.done;
        return op;
    }

    // ackOp removes an operation after the server accepted it. Pass the
    // updatedAt value that was sent: if the user coalesced newer content into
    // the entry while the request was in flight, the entry is kept and false
    // is returned, so the new content is not lost.
    async function ackOp(opId, { updatedAt } = {}) {
        const db = await getDB();
        const tx = db.transaction(STORE_OUTBOX, 'readwrite');
        const seq = await tx.store.index('by-opId').getKey(opId);
        if (seq === undefined) {
            await tx.done;
            return false;
        }
        const op = await tx.store.get(seq);
        if (updatedAt !== undefined && op.updatedAt > updatedAt) {
            await tx.done;
            return false;
        }
        await tx.store.delete(seq);
        await tx.done;
        return true;
    }

    // rebasePath points still-queued saves of a note at the version the server
    // just accepted. It matters when newer content was coalesced while a
    // request was in flight: that text was typed on top of the accepted
    // version, so using the old baseHash would turn the next replay into a
    // false conflict. Keyed by path (not opId) because the operation may have
    // been acked and recreated between the request and this call.
    async function rebasePath(path, baseHash) {
        if (typeof path !== 'string' || path === '') {
            throw new TypeError('rebasePath requires a non-empty path');
        }
        const db = await getDB();
        const tx = db.transaction(STORE_OUTBOX, 'readwrite');
        const ops = await tx.store.index('by-path').getAll(path);
        const next = typeof baseHash === 'string' ? baseHash : '';
        await Promise.all(ops.map((op) => tx.store.put({ ...op, baseHash: next })));
        await tx.done;
        return ops.length;
    }

    // failOp records a failed replay attempt and keeps the operation queued.
    // updatedAt stays untouched so an ack guard from the in-flight attempt
    // keeps working.
    async function failOp(opId, error) {
        const db = await getDB();
        const tx = db.transaction(STORE_OUTBOX, 'readwrite');
        const seq = await tx.store.index('by-opId').getKey(opId);
        if (seq === undefined) {
            await tx.done;
            return null;
        }
        const op = await tx.store.get(seq);
        op.attempts = (op.attempts || 0) + 1;
        op.lastError = typeof error === 'string'
            ? error
            : (error?.message || 'sync failed');
        op.lastAttemptAt = now();
        await tx.store.put(op);
        await tx.done;
        return op;
    }

    async function removeOp(opId) {
        const db = await getDB();
        const tx = db.transaction(STORE_OUTBOX, 'readwrite');
        const seq = await tx.store.index('by-opId').getKey(opId);
        if (seq === undefined) {
            await tx.done;
            return false;
        }
        await tx.store.delete(seq);
        await tx.done;
        return true;
    }

    async function clearOutbox() {
        const db = await getDB();
        await db.clear(STORE_OUTBOX);
    }

    // ---------------------------------------------------------------------
    // Metadata (last sync time, cursor, ...)
    // ---------------------------------------------------------------------

    async function getMeta(key, fallback = null) {
        const db = await getDB();
        const row = await db.get(STORE_META, key);
        return row === undefined ? fallback : row.value;
    }

    async function setMeta(key, value) {
        const db = await getDB();
        await db.put(STORE_META, { key, value });
        return value;
    }

    async function deleteMeta(key) {
        const db = await getDB();
        await db.delete(STORE_META, key);
    }

    // clearAll wipes the local cache and queue, e.g. on logout.
    async function clearAll() {
        const db = await getDB();
        const tx = db.transaction(
            [STORE_NOTES, STORE_DOCUMENTS, STORE_OUTBOX, STORE_META],
            'readwrite',
        );
        await Promise.all([
            tx.objectStore(STORE_NOTES).clear(),
            tx.objectStore(STORE_DOCUMENTS).clear(),
            tx.objectStore(STORE_OUTBOX).clear(),
            tx.objectStore(STORE_META).clear(),
        ]);
        await tx.done;
    }

    return {
        get isAvailable() {
            return available;
        },
        open,
        close: resetConnection,

        getSummary,
        putSummary,
        putSummaries,
        replaceSummaries,
        listSummaries,
        countSummaries,
        getDocument,
        putDocument,
        deleteNote,
        clearNotes,

        queueSave,
        pendingOps,
        pendingCount,
        getOp,
        ackOp,
        failOp,
        rebasePath,
        removeOp,
        clearOutbox,

        getMeta,
        setMeta,
        deleteMeta,
        clearAll,
    };
}
