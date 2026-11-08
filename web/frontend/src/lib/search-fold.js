// Accent-insensitive search helpers.
//
// The editor is a <textarea>, so search highlighting maps between source
// offsets and positions in the accent-folded copy of the text. Keeping the
// mapping here makes the trickiest part of the search UI unit testable.

// Combining marks removed by foldForSearch (accent-insensitive matching).
export const SEARCH_COMBINING_MARKS = /\p{M}/gu;
const SEARCH_WORD_CHARACTER = /^[\p{L}\p{N}_]$/u;

/**
 * Lowercase `text` and strip accents, also returning a byte-for-byte map from
 * folded index back to the original string index.
 *
 * @param {string} text
 * @returns {{ text: string, map: number[] }} map has text.length + 1 entries
 */
export function foldForSearch(text) {
    // Fast path: ASCII lowercases 1:1, so the index map is the identity.
    let ascii = true;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) > 127) {
            ascii = false;
            break;
        }
    }
    if (ascii) {
        const map = new Array(text.length + 1);
        for (let i = 0; i <= text.length; i++) map[i] = i;
        return { text: text.toLowerCase(), map };
    }

    const chars = [];
    const map = [];
    for (let i = 0; i < text.length; i++) {
        const folded = text[i]
            .normalize('NFD')
            .replace(SEARCH_COMBINING_MARKS, '')
            .toLowerCase();
        for (let j = 0; j < folded.length; j++) {
            chars.push(folded[j]);
            map.push(i);
        }
    }
    map.push(text.length);
    return { text: chars.join(''), map };
}

/** First folded index whose original position is >= origIndex. */
export function foldedIndexForOriginal(map, origIndex) {
    let low = 0;
    let high = map.length - 1;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (map[mid] < origIndex) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return low;
}

/** Whether the character at start/end is separated from adjacent word characters. */
export function isWholeWordMatch(text, start, end) {
    const before = start > 0 ? Array.from(text.slice(0, start)).pop() : '';
    const after = end < text.length ? Array.from(text.slice(end))[0] : '';
    return (!before || !SEARCH_WORD_CHARACTER.test(before))
        && (!after || !SEARCH_WORD_CHARACTER.test(after));
}

/** 0-based character offset where a 1-based source line starts. */
export function lineStartOffset(content, line) {
    if (line <= 1) return 0;
    let offset = 0;
    for (let i = 1; i < line; i++) {
        const newline = content.indexOf('\n', offset);
        if (newline === -1) return content.length;
        offset = newline + 1;
    }
    return offset;
}
