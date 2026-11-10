// Pure path helpers used by the sidebar's optimistic mutations.
//
// Paths are always vault-relative and slash-separated, never OS paths.

/** Folder part of a vault path ('' for a root-level file). */
export function folderFromPath(path) {
    const i = path.lastIndexOf('/');
    return i === -1 ? '' : path.substring(0, i);
}

/** Last segment of a vault path. */
export function filenameFromPath(path) {
    return path.split('/').pop();
}

/** Media type inferred from a vault path's extension. */
export function inferTypeFromPath(path) {
    const m = /\.([^./]+)$/.exec(path);
    const ext = m ? m[1].toLowerCase() : '';
    if (ext === 'md' || ext === '') return 'note';
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'image';
    if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return 'audio';
    if (['mp4', 'webm', 'mov', 'avi'].includes(ext)) return 'video';
    if (ext === 'pdf') return 'document';
    return 'note';
}

/**
 * Every folder path implied by a list of notes, including empty parents.
 * The server sends the full folder list with /api/notes; this rebuilds it for
 * the offline cache, where only note summaries are stored.
 *
 * @param {Array<{path: string, folder?: string}>} notes
 * @returns {string[]} sorted folder paths, e.g. ['a', 'a/b']
 */
export function foldersFromNotes(notes) {
    const folders = new Set();
    for (const note of notes || []) {
        let folder = typeof note.folder === 'string' ? note.folder : folderFromPath(note.path || '');
        while (folder) {
            folders.add(folder);
            folder = folderFromPath(folder);
        }
    }
    return [...folders].sort();
}

/**
 * Filename-friendly timestamp for the conflict copy created when an offline
 * save no longer matches the server version.
 * @param {Date} [date]
 */
export function offlineStamp(date = new Date()) {
    const pad = (n, width = 2) => String(n).padStart(width, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Sibling path that preserves an offline edit that conflicted with the server,
 * e.g. 'a/b.md' + '20260102-030405' -> 'a/b.offline-conflict-20260102-030405.md'.
 * The stem is capped so the result stays under common filename limits.
 *
 * @param {string} path
 * @param {string} stamp
 */
export function conflictCopyPath(path, stamp) {
    const folder = folderFromPath(path);
    const name = filenameFromPath(path);
    const stem = name.replace(/\.md$/i, '');
    const suffix = `.offline-conflict-${stamp}`;
    const maxStem = Math.max(1, 200 - suffix.length);
    const trimmed = stem.length > maxStem ? stem.slice(0, maxStem) : stem;
    return `${folder ? `${folder}/` : ''}${trimmed}${suffix}.md`;
}
