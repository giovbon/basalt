// Replays queued saves in order.
//
// Kept out of notes.js (and free of Alpine) so the sequencing rules are
// testable with a fake store: a network failure stops the pass so the queued
// operations stay queued, a 409 is reported to the caller (which decides how to
// preserve the local copy) and other HTTP errors are left for the next pass.
//
// Contract:
// - store: offline-store.js instance (pendingOps, ackOp, failOp).
// - send(op) resolves {ok, status, hash?, ...}; it may throw for transport
//   failures but must return, not throw, for HTTP errors.
// - onSynced/onConflict/onFailed may be async and are awaited, so the summary
//   describes the state after their side effects.
// - sync() is single-flight: concurrent calls share the running pass.

export function createOutboxSync({ store, send, onSynced, onConflict, onFailed } = {}) {
    if (!store || typeof send !== 'function') {
        throw new TypeError('createOutboxSync requires store and send');
    }

    let running = null;

    async function run() {
        const ops = await store.pendingOps();
        const summary = { synced: 0, conflicts: 0, failed: 0, stopped: false };

        for (const op of ops) {
            let result;
            try {
                result = await send(op);
            } catch (error) {
                // Transport failure: the server is unreachable, so stop here
                // instead of burning through the rest of the queue.
                await store.failOp(op.opId, error);
                summary.failed += 1;
                summary.stopped = true;
                break;
            }

            if (result?.ok) {
                // ackOp keeps the entry when newer content was coalesced into
                // it while the request was in flight.
                const removed = await store.ackOp(op.opId, { updatedAt: op.updatedAt });
                if (removed) summary.synced += 1;
                await onSynced?.(op, result);
                continue;
            }

            if (result?.status === 409) {
                await store.failOp(op.opId, 'conflict');
                summary.conflicts += 1;
                await onConflict?.(op, result);
                continue;
            }

            await store.failOp(op.opId, result?.detail || `HTTP ${result?.status || 0}`);
            summary.failed += 1;
            await onFailed?.(op, result);

            // 5xx and missing status mean the server is unhealthy: let the
            // next pass retry the rest instead of hammering it now.
            if (!result || result.status >= 500 || result.status === 0) {
                summary.stopped = true;
                break;
            }
        }

        return summary;
    }

    function sync() {
        if (running) return running;
        running = run().finally(() => {
            running = null;
        });
        return running;
    }

    return {
        sync,
        get isRunning() {
            return running !== null;
        },
    };
}
