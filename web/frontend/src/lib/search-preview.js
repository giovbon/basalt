// Mapping between source offsets and highlighted occurrences in the preview.
//
// The sidebar search returns a line/column in the raw markdown, but the preview
// is rendered HTML: frontmatter, link targets and similar constructs disappear,
// while code blocks are shown as text. These helpers decide which source spans
// become visible text so a clicked result can target the matching <mark>.

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
 * Mirrors highlightInPreview's rules plus the constructs the renderer consumes
 * instead of emitting as text: frontmatter, link destinations, image alt text,
 * the target half of [[target|display]], HTML tags and reference definitions.
 *
 * Code is visible in the preview, so its text is NOT hidden. Only the fence
 * line of a regular code block (the info string is not rendered) and the whole
 * body of fences the renderer replaces (mermaid/query) are hidden. Code spans
 * also get their markdown-looking text skipped below, so a literal `<div>` or
 * `[x](y)` inside a code block is not mistaken for markup.
 *
 * @param {string} content
 * @returns {Array<[number, number]>} sorted-ish, possibly overlapping spans
 */
export function searchHiddenRegions(content) {
    const regions = [];
    // Code spans are visible, but their contents are literal: markdown-looking
    // text inside must not be interpreted as HTML/link/wikilink syntax.
    const literalRegions = [];
    const add = (start, end) => {
        if (end > start) regions.push([start, end]);
    };
    const addLiteral = (start, end) => {
        if (end > start) literalRegions.push([start, end]);
    };

    // Line starts, so every rule can work with whole lines.
    const lineStarts = [0];
    for (let p = content.indexOf('\n'); p !== -1; p = content.indexOf('\n', p + 1)) {
        lineStarts.push(p + 1);
    }
    const lineEnd = (i) => (i + 1 < lineStarts.length ? lineStarts[i + 1] - 1 : content.length);

    // Frontmatter, fenced code and reference definitions.
    let fence = null;
    let previousBlank = true;
    let previousIndented = false;
    for (let i = 0; i < lineStarts.length; i++) {
        const start = lineStarts[i];
        const end = lineEnd(i);
        const line = content.slice(start, end);

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
                previousBlank = true;
                previousIndented = false;
                continue;
            }
        }

        if (fence) {
            if (fence.closeRe.test(line)) {
                if (fence.hidden) {
                    add(fence.start, end);
                } else {
                    // The closing fence is not text either.
                    add(start, end);
                    addLiteral(fence.start, end);
                }
                fence = null;
            }
            continue;
        }

        // Indented code blocks are rendered as visible text. Track them as
        // literal so the inline scanner does not treat their contents as markup.
        if ((previousBlank || previousIndented)
            && /^(?: {4}|\t)/.test(line)
            && line.trim() !== '') {
            addLiteral(start, end);
            previousBlank = false;
            previousIndented = true;
            continue;
        }
        previousIndented = false;

        const open = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
        if (open) {
            const info = (open[2] || '').trim();
            // These fences are replaced by rendered output (diagram/table),
            // so none of their source text reaches the preview.
            const hidden = /^(?:basalt-query|query|mermaid)(?:\s|$)/i.test(info);
            const ch = open[1][0];
            fence = {
                start,
                hidden,
                closeRe: new RegExp(
                    '^\\s{0,3}' + (ch === '`' ? '`' : '~') + '{' + open[1].length + ',}\\s*$'
                ),
            };
            // For regular fences only the opening line (info string included)
            // disappears; the code body is rendered as text.
            if (!hidden) add(start, end);
            previousBlank = false;
            continue;
        }

        if (/^\s{0,3}\[[^\]]+\]:/.test(line)) {
            add(start, end);
            previousBlank = false;
            continue;
        }

        // GFM task markers become checkboxes, not text.
        const task = line.match(/^(\s{0,3}[-*+]\s+)\[([ xX])\]/);
        if (task) {
            const markerStart = start + task[1].length;
            add(markerStart, markerStart + 3);
        }

        previousBlank = line.trim() === '';
    }
    if (fence) {
        if (fence.hidden) add(fence.start, content.length);
        else addLiteral(fence.start, content.length);
    }

    // Inline constructs, scanned once over the whole document, skipping code
    // spans (which the renderer fills with literal text).
    literalRegions.sort((a, b) => a[0] - b[0]);
    let literalIndex = 0;

    // Overlapping the line-based regions above is harmless.
    const TAG_RE = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/y;
    let i = 0;
    while (i < content.length) {
        while (literalIndex < literalRegions.length
            && literalRegions[literalIndex][1] <= i) {
            literalIndex++;
        }
        if (literalIndex < literalRegions.length) {
            const [literalStart, literalEnd] = literalRegions[literalIndex];
            if (i >= literalStart && i < literalEnd) {
                i = literalEnd;
                continue;
            }
        }

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
                // Inline code is visible text: skip it for syntax scanning but
                // do not add it as a hidden region.
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
                // Resume at the closing ']' so the generic `]()` rule below
                // also hides the destination of ![alt](url). For ![[media]]
                // the next character is another ']' and nothing else matches.
                i = j;
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

        if (ch === ']' && content[i + 1] === '[') {
            // Reference-style link label: [text][ref] renders only "text".
            const close = content.indexOf(']', i + 2);
            if (close !== -1) {
                add(i, close + 1);
                i = close + 1;
                continue;
            }
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
 * Scan the source occurrences of the term and locate the clicked one relative
 * to the preview marks.
 *
 * @returns {{ hidden: boolean, before: number, total: number }}
 */
function scanPreviewMatches(content, offset, foldedTerm, exactMatch) {
    const folded = foldForSearch(content);
    const regions = searchHiddenRegions(content);
    if (spanOverlapsRegions(regions, offset, offset + 1)) {
        return { hidden: true, before: 0, total: 0 };
    }

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

    return { hidden: false, before, total };
}

/**
 * Index of the <mark> that corresponds to a source offset, or
 *   -1 when that occurrence never becomes preview text, and
 *   -2 when the source-side count disagrees with the rendered marks.
 */
export function previewMarkIndexForSourceOffset(content, offset, foldedTerm, markCount, exactMatch = false) {
    if (!content || !foldedTerm) return -2;

    const scan = scanPreviewMatches(content, offset, foldedTerm, exactMatch);
    if (scan.hidden) return -1;

    // Only trust the numbering when both sides agree on the amount of
    // highlightable occurrences.
    if (scan.total !== markCount || scan.before >= markCount) return -2;
    return scan.before;
}

/**
 * Best-effort version of previewMarkIndexForSourceOffset.
 *
 * One mismatch (a construct the hidden-region scanner does not know, a
 * renderer-generated mark, math typeset after highlighting, …) used to make the
 * whole note fall back to "nearest mark", which often activated the wrong
 * occurrence — or none at all. When only the total disagrees, the rank of the
 * clicked occurrence in source order is still the best guess, so return it
 * instead of discarding the mapping.
 */
export function previewMarkIndexForSourceOffsetBestEffort(content, offset, foldedTerm, markCount, exactMatch = false) {
    if (!content || !foldedTerm) return -2;

    const scan = scanPreviewMatches(content, offset, foldedTerm, exactMatch);
    if (scan.hidden) return -1;
    if (scan.total === 0 || scan.before >= markCount) return -2;
    return scan.before;
}
