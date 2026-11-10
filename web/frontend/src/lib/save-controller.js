// Save/autosave state machine.
//
// Extracted from app/notes.js so queueing and the 409 "changed elsewhere"
// flow can be tested without Alpine, a DOM or a running server. The controller
// owns sequencing only: content, hashes and UI updates arrive through the
// callbacks below.
//
// Contract:
// - capture() returns {notePath, content, baseHash} for the note to save now,
//   or null when there is nothing to save.
// - send(payload) resolves to {ok, status, hash?, outline?, frontmatter?, tags?}.
//   It must not throw for HTTP 409; a 409 is returned like any other status.
// - askConflict(notePath) resolves true to overwrite with the editor content,
//   false to reload the version on disk.
// - isCurrent(notePath) tells whether the user is still on that note.

export function createSaveController({
    capture,
    send,
    askConflict,
    reload,
    onSaved,
    onUnsaved,
    onError,
    onBusyChange,
    isCurrent,
} = {}) {
    if (typeof capture !== 'function' || typeof send !== 'function') {
        throw new TypeError('createSaveController requires capture and send');
    }

    let pending = false;
    let conflictOpen = false;
    let overrideHash;
    let overrideHashSet = false;
    let pumpPromise = null;

    const stillOn = typeof isCurrent === 'function' ? isCurrent : () => true;

    async function pump() {
        onBusyChange?.(true);
        try {
            while (pending) {
                pending = false;

                // capture() is called at send time, not at request time: a save
                // queued behind another one always writes the latest keystrokes.
                const payload = capture();
                if (!payload || !payload.notePath) continue;

                if (overrideHashSet) {
                    payload.baseHash = overrideHash;
                    overrideHashSet = false;
                }

                let result;
                try {
                    result = await send(payload);
                } catch (error) {
                    onError?.(error);
                    continue;
                }

                if (result.status === 409) {
                    if (!stillOn(payload.notePath)) {
                        // The user already moved on: that note's base hash is
                        // not ours to overwrite.
                        onUnsaved?.(payload.notePath);
                        continue;
                    }

                    // Nothing is in flight while the user decides, and new
                    // save requests are ignored until the prompt closes.
                    conflictOpen = true;
                    onBusyChange?.(false);
                    let overwrite = false;
                    try {
                        overwrite = Boolean(await askConflict?.(payload.notePath, {
                            deleted: Boolean(result.deleted),
                        }));
                    } finally {
                        conflictOpen = false;
                    }

                    if (!overwrite) {
                        // Drop any queued save: reloading replaces the buffer.
                        pending = false;
                        try {
                            await reload?.(payload.notePath);
                        } catch (error) {
                            onError?.(error);
                        }
                        return;
                    }

                    // Overwrite: take the disk version as the base and re-send
                    // the editor content. Re-capture first in case the user
                    // typed (or switched notes) while the prompt was open.
                    const retry = capture();
                    if (!retry || !retry.notePath || retry.notePath !== payload.notePath) {
                        pending = false;
                        return;
                    }
                    overrideHash = result.hash ?? null;
                    overrideHashSet = true;
                    pending = true;
                    onBusyChange?.(true);
                    continue;
                }

                if (result.ok) {
                    onSaved?.(payload, result);
                } else {
                    onError?.(new Error(`save failed with status ${result.status}`));
                }
            }
        } finally {
            pumpPromise = null;
            onBusyChange?.(false);
        }
    }

    return {
        // Coalesces concurrent requests into one in-flight write plus at most
        // one queued follow-up. Returns the promise for the whole drain, which
        // is convenient in tests; callers in the app may ignore it.
        request() {
            if (conflictOpen) return Promise.resolve();
            pending = true;
            if (!pumpPromise) {
                pumpPromise = pump().catch((error) => {
                    onError?.(error);
                });
            }
            return pumpPromise;
        },

        get busy() {
            return pumpPromise !== null;
        },

        get conflictOpen() {
            return conflictOpen;
        },
    };
}
