// Mapping between source offsets and highlighted occurrences in the preview.
//
// The sidebar search returns a line/column in the raw markdown, but the preview
// is rendered HTML: frontmatter, code, link targets and similar constructs
// disappear. These helpers decide which source spans become visible text so a
// clicked result can target the matching <mark> element.

import { foldForSearch, isWholeWordMatch, lineStartOffset } from './search-fold.js';

/** 0-based offset of a 1-based line:column (column in runes, as the API sends). */
export function sourceOffsetForLineColumn(content, line, column = 1) {
    let offset = lineStartOffset(content, line);
    let rune = 1;
    while (offset < content.length && rune < column) {
        const code = content.codePointAt(offset);
        if (code === 10) break; // '\n'
        offset += code > 0xFFFF ? 2 : 1;
        rune++;
    }
    return offset;
}

/**
 * Source spans that never show up as text in the preview.
 *
 * Mirrors highlightInPreview's "skip code" rule plus the constructs the
 * renderer consumes instead of emitting as text: frontmatter, fenced and
 * inline code, HTML tags, link destinations, image alt text, the target half
 * of [[target|display]] and reference definitions.
 *
 * @param {string} content
 * @returns {Array<[number, number]>} sorted-ish, possibly overlapping spans
 */
export function searchHiddenRegions(content) {
    const regions = [];
    const add = (start, end) => {
        if (end > start) regions.push([start, end]);
    };

    // Line starts, so every rule can work with whole lines.
    const lineStarts = [0];
    for (let p = content.indexOf('\n'); p !== -1; p = content.indexOf('\n', p + 1)) {
        lineStarts.push(p + 1);
    }
    const lineEnd = (i) => (i + 1 < lineStarts.length ? lineStarts[i + 1] - 1 : content.length);

    // Frontmatter, fenced code and reference definitions.
    let fence = null;
    for (let i = 0; i < lineStarts.length; i++) {
        const line = content.slice(lineStarts[i], lineEnd(i));

        // The renderer strips YAML frontmatter: opening '---' line,
        // then everything up to the next line that trims to '---'.
        if (i === 0 && line.trim() === '---') {
            let close = -1;
            for (let k = 1; k < lineStarts.length; k++) {
                if (content.slice(lineStarts[k], lineEnd(k)).trim() === '---') {
                    close = k;
                    break;
                }
            }
            if (close !== -1) {
                add(0, lineEnd(close));
                i = close;
                continue;
            }
        }

        if (fence) {
            if (fence.closeRe.test(line)) {
                add(fence.start, lineEnd(i));
                fence = null;
            }
            continue;
        }

        const open = line.match(/^\s{0,3}(`{3,}|~{3,})/);
        if (open) {
            const ch = open[1][0];
            fence = {
                start: lineStarts[i],
                closeRe: new RegExp(
                    '^\\s{0,3}' + (ch === '`' ? '`' : '~') + '{' + open[1].length + ',}\\s*$'
                ),
            };
            continue;
        }

        if (/^\s{0,3}\[[^\]]+\]:/.test(line)) add(lineStarts[i], lineEnd(i));
    }
    if (fence) add(fence.start, content.length);

    // Inline constructs, scanned once over the whole document.
    // Overlapping the line-based regions above is harmless.
    const TAG_RE = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/y;
    let i = 0;
    while (i < content.length) {
        const ch = content[i];

        if (ch === '`') {
            let runLen = 1;
            while (content[i + runLen] === '`') runLen++;
            let j = i + runLen;
            let closed = -1;
            const limit = Math.min(content.length, i + 5000);
            while (j < limit) {
                if (content[j] === '`') {
                    let closeLen = 1;
                    while (content[j + closeLen] === '`') closeLen++;
                    if (closeLen === runLen) {
                        closed = j + closeLen;
                        break;
                    }
                    j += closeLen;
                    continue;
                }
                // An inline code span cannot cross a blank line.
                if (content[j] === '\n' && content[j + 1] === '\n') break;
                j++;
            }
            if (closed !== -1) {
                add(i, closed);
                i = closed;
            } else {
                i += runLen;
            }
            continue;
        }

        if (ch === '<') {
            if (content.startsWith('<!--', i)) {
                const end = content.indexOf('-->', i + 4);
                if (end !== -1) {
                    add(i, end + 3);
                    i = end + 3;
                    continue;
                }
            }
            TAG_RE.lastIndex = i;
            const tag = TAG_RE.exec(content);
            if (tag) {
                add(i, i + tag[0].length);
                i += tag[0].length;
                continue;
            }
            if (content.startsWith('<!', i) || content.startsWith('<?', i)) {
                const gt = content.indexOf('>', i);
                if (gt !== -1) {
                    add(i, gt + 1);
                    i = gt + 1;
                    continue;
                }
            }
            i++;
            continue;
        }

        if (ch === '!' && content[i + 1] === '[') {
            // ![alt](url) and ![[media]]: neither alt text nor the
            // media name is rendered as note text.
            let depth = 0;
            let j = i + 1;
            for (; j < content.length; j++) {
                if (content[j] === '[') depth++;
                else if (content[j] === ']') {
                    depth--;
                    if (depth === 0) break;
                }
            }
            if (j < content.length) {
                add(i, j + 1);
                i = j + 1;
            } else {
                i++;
            }
            continue;
        }

        if (ch === '[' && content[i + 1] === '[') {
            // [[target|display]]: only the display half is rendered.
            const close = content.indexOf(']]', i + 2);
            if (close !== -1) {
                const pipe = content.indexOf('|', i + 2);
                if (pipe !== -1 && pipe < close) add(i, pipe + 1);
                i = close + 2;
                continue;
            }
            i += 2;
            continue;
        }

        if (ch === ']' && content[i + 1] === '(') {
            // Link destination (with optional title), never text.
            let depth = 0;
            let j = i + 1;
            for (; j < content.length; j++) {
                if (content[j] === '(') depth++;
                else if (content[j] === ')') {
                    depth--;
                    if (depth === 0) break;
                }
            }
            if (j < content.length) {
                add(i, j + 1);
                i = j + 1;
            } else {
                i++;
            }
            continue;
        }

        i++;
    }

    return regions;
}

/** True when [start, end) intersects any of the hidden regions. */
export function spanOverlapsRegions(regions, start, end) {
    for (const [regionStart, regionEnd] of regions) {
        if (start < regionEnd && end > regionStart) return true;
    }
    return false;
}

/**
 * Index of the <mark> that corresponds to a source offset, or
 *   -1 when that occurrence never becomes preview text, and
 *   -2 when the source-side count disagrees with the rendered marks.
 */
export function previewMarkIndexForSourceOffset(content, offset, foldedTerm, markCount, exactMatch = false) {
    if (!content) return -2;

    const folded = foldForSearch(content);
    const regions = searchHiddenRegions(content);
    if (spanOverlapsRegions(regions, offset, offset + 1)) return -1;

    let before = 0;
    let total = 0;
    let from = 0;
    while (true) {
        const idx = folded.text.indexOf(foldedTerm, from);
        if (idx === -1) break;
        from = idx + foldedTerm.length;

        const start = folded.map[idx];
        const end = folded.map[idx + foldedTerm.length];
        if (spanOverlapsRegions(regions, start, end)) continue;
        if (exactMatch && !isWholeWordMatch(content, start, end)) continue;

        total++;
        if (start < offset) before++;
    }

    // Only trust the numbering when both sides agree on the amount of
    // highlightable occurrences; a mismatch means one of the hidden
    // region rules above is off for this note.
    if (total !== markCount || before >= markCount) return -2;
    return before;
}
