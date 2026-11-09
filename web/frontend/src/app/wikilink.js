// Wikilink/media lookup maps, resolution and [[ autocomplete.
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import * as api from '../core/api.js';
import { encodeVaultPath } from '../core/utils.js';

function extractHeadingOutline(content) {
    const lines = content.split('\n');
    let start = 0;
    if (lines[0]?.trim() === '---') {
        const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
        if (end !== -1) start = end + 1;
    }

    const outline = [];
    const slugCounts = new Map();
    let inCodeBlock = false;
    for (let index = start; index < lines.length; index++) {
        const line = lines[index];
        if (/^\s{0,3}(?:```|~~~)/.test(line)) {
            inCodeBlock = !inCodeBlock;
            continue;
        }
        if (inCodeBlock) continue;

        const match = line.match(/^(#{1,6})\s+(.+)$/);
        if (!match) continue;
        const text = match[2].trim();
        const baseSlug = text.toLowerCase().replace(/[^a-z0-9_ -]/g, '').replace(/ +/g, '-').replace(/-+/g, '-');
        const duplicateCount = slugCounts.get(baseSlug) || 0;
        slugCounts.set(baseSlug, duplicateCount + 1);
        outline.push({
            level: match[1].length,
            text,
            slug: duplicateCount ? `${baseSlug}-${duplicateCount}` : baseSlug,
        });
    }
    return outline;
}

export function createWikilink() {
    return {
        
        // Build lookup maps for O(1) wikilink resolution
        buildNoteLookupMaps() {
            // Clear existing maps
            this._noteLookup.byPath.clear();
            this._noteLookup.byPathLower.clear();
            this._noteLookup.byName.clear();
            this._noteLookup.byNameLower.clear();
            this._mediaLookup.clear();
            this._mediaLookupStem.clear();
            this._noteNameCounts.clear();
            
            const setFirst = (map, key, value) => {
                if (!map.has(key)) map.set(key, value);
            };
            
            for (const note of this.notes) {
                const path = note.path;
                const pathLower = path.toLowerCase();
                const name = note.name;
                const nameLower = name.toLowerCase();
                
                // Handle media files separately - build media lookup map
                if (note.type !== 'note') {
                    // Map filename WITH extension (case-insensitive) to full path
                    // Use path to get filename with extension (note.name is stem without extension)
                    const filenameWithExt = path.split('/').pop().toLowerCase();
                    // First match wins if there are duplicates
                    if (!this._mediaLookup.has(filenameWithExt)) {
                        this._mediaLookup.set(filenameWithExt, path);
                    }
                    // Full path as well, so a wikilink written from another folder
                    // (folder/report.pdf) and folder-relative resolution both hit.
                    if (!this._mediaLookup.has(pathLower)) {
                        this._mediaLookup.set(pathLower, path);
                    }
                    // Extension-less keys, so [[report]] resolves to report.pdf
                    // when no note owns that name (notes are matched first).
                    const stem = filenameWithExt.replace(/\.[^.]+$/, '');
                    if (stem && !this._mediaLookupStem.has(stem)) {
                        this._mediaLookupStem.set(stem, path);
                    }
                    const folder = note.folder || '';
                    const relStem = folder ? `${folder.toLowerCase()}/${stem}` : stem;
                    if (stem && !this._mediaLookupStem.has(relStem)) {
                        this._mediaLookupStem.set(relStem, path);
                    }
                    continue;
                }
                
                // Notes only from here
                const nameWithoutMd = name.replace(/\.md$/i, '');
                const nameWithoutMdLower = nameWithoutMd.toLowerCase();
                const urlPath = path.replace(/\.md$/i, '');

                // Count notes per stem so autocomplete can insert a bare name when
                // unique and a folder-relative path when ambiguous.
                this._noteNameCounts.set(nameWithoutMdLower, (this._noteNameCounts.get(nameWithoutMdLower) || 0) + 1);
                
                // Store all variations for fast lookup. The value is the note's URL
                // path, so a wikilink can be resolved to a href and not just tested
                // for existence. Name keys collide when two folders hold the same
                // note name, so first match wins — the same rule the media map
                // above uses.
                setFirst(this._noteLookup.byPath, path, urlPath);
                setFirst(this._noteLookup.byPath, urlPath, urlPath);
                setFirst(this._noteLookup.byPathLower, pathLower, urlPath);
                setFirst(this._noteLookup.byPathLower, pathLower.replace(/\.md$/i, ''), urlPath);
                setFirst(this._noteLookup.byName, name, urlPath);
                setFirst(this._noteLookup.byName, nameWithoutMd, urlPath);
                setFirst(this._noteLookup.byNameLower, nameLower, urlPath);
                setFirst(this._noteLookup.byNameLower, nameWithoutMdLower, urlPath);
            }
        },
        
        // Resolve a wikilink or markdown-link target to the target note's URL
        // path (path without .md), or to the media file's path (extension
        // kept), or null when nothing matches.
        //
        // The single rule set for every client-side resolution (preview
        // renderer, click navigation), mirroring the backend's
        // vault.LinkResolver in the same order:
        //   1. relative to the source note's folder (plain names only),
        //   2. path from the vault root (exact, then case-insensitive),
        //   3. note stem, so [[My Note]] works from anywhere,
        //   4. media files, so [[report.pdf]] links to the PDF (notes win
        //      when both a note and a media file share the name).
        // It stays client-side because the live preview resolves links on
        // every keystroke, where a round trip would be visible.
        resolveWikiLink(linkTarget, sourceFolder = '') {
            const target = (linkTarget || '').trim();
            if (!target) return null;
            const targetLower = target.toLowerCase();
            const byPath = this._noteLookup.byPath;
            const byPathLower = this._noteLookup.byPathLower;
            const hasExt = /\.[a-z0-9]+$/i.test(target);

            // 1. Relative to the source note's folder
            if (sourceFolder && !target.includes('/')) {
                const rel = sourceFolder + '/' + target;
                const relLower = rel.toLowerCase();
                const relHit =
                    byPath.get(rel) ??
                    byPath.get(rel + '.md') ??
                    byPathLower.get(relLower) ??
                    byPathLower.get(relLower + '.md');
                if (relHit) return relHit;
                const relMedia =
                    this._mediaLookup.get(relLower) ??
                    (hasExt ? null : this._mediaLookupStem.get(relLower));
                if (relMedia) return relMedia;
            }

            // 2. Vault root  3. note stem
            const noteHit =
                byPath.get(target) ??
                byPath.get(target + '.md') ??
                byPathLower.get(targetLower) ??
                byPathLower.get(targetLower + '.md') ??
                this._noteLookup.byName.get(target) ??
                this._noteLookup.byNameLower.get(targetLower) ??
                null;
            if (noteHit) return noteHit;

            // 4. Media files (PDF, images, audio, video). The path keeps its
            // extension: callers look the result up in `notes` and hand media
            // entries to openItem()/viewMedia() instead of loadNote().
            return (
                this._mediaLookup.get(targetLower) ??
                this._mediaLookupStem.get(targetLower) ??
                null
            );
        },
        
        // Resolve media wikilink to full path (O(1) lookup)
        // Accepts the filename with extension, the vault path, or the bare
        // stem ([[report]] -> report.pdf), mirroring resolveWikiLink's rules.
        // Returns the full path if found, null otherwise
        resolveMediaWikilink(mediaName) {
            const nameLower = mediaName.toLowerCase();
            return this._mediaLookup.get(nameLower)
                ?? this._mediaLookupStem.get(nameLower)
                ?? null;
        },

        // ---- Wikilink / media autocomplete -------------------------------------
        // Note/media suggestions use the loaded vault list. Heading suggestions
        // load and cache the target note's outline when the query contains `#`.

        // Inspect the text before the caret and open/refresh the popup when the
        // caret sits inside an unfinished [[ / ![[ token.
        wlDetectToken() {
            const textarea = document.getElementById('note-editor');
            if (!textarea) { this.wlClose(); return; }
            if (document.activeElement !== textarea) { this.wlClose(); return; }
            if (textarea.selectionStart !== textarea.selectionEnd) { this.wlClose(); return; }

            const caret = textarea.selectionStart;
            const before = this.noteContent.substring(0, caret);
            const idx = before.lastIndexOf('[[');
            if (idx === -1) { this.wlClose(); return; }

            const query = before.substring(idx + 2);
            // A valid in-progress target has no bracket, pipe, or newline, and stays short.
            if (query.length > 100 || /[\[\]\n|]/.test(query)) { this.wlClose(); return; }

            const isMedia = idx > 0 && before[idx - 1] === '!';
            if (!isMedia && query.includes('#')) {
                const hashIndex = query.indexOf('#');
                const pageTarget = query.substring(0, hashIndex);
                const headingQuery = query.substring(hashIndex + 1);
                const sourceFolder = this.currentNote && this.currentNote.includes('/')
                    ? this.currentNote.substring(0, this.currentNote.lastIndexOf('/'))
                    : '';
                this.wikilinkAutocomplete.mode = 'heading';
                this.wikilinkAutocomplete.tokenStart = idx + 2;
                this.wikilinkAutocomplete.query = headingQuery;
                this.wlClose();
                const generation = this._wlHeadingGeneration;
                this.wlLoadHeadingItems(pageTarget, sourceFolder, headingQuery, idx + 2, generation);
                return;
            }

            this.wikilinkAutocomplete.mode = isMedia ? 'media' : 'note';
            this.wikilinkAutocomplete.tokenStart = idx + 2;
            this.wikilinkAutocomplete.query = query;
            this.wlComputeItems();

            if (this.wikilinkAutocomplete.items.length === 0) { this.wlClose(); return; }
            this.wikilinkAutocomplete.activeIndex = 0;
            this.wikilinkAutocomplete.open = true;
            this._wlPosRetries = 0;
            this.$nextTick(() => this.wlUpdatePosition());
        },

        async wlLoadHeadingItems(pageTarget, sourceFolder, query, tokenStart, generation) {
            let note;
            if (pageTarget) {
                const resolved = this.resolveWikiLink(pageTarget, sourceFolder);
                note = this.notes.find((item) =>
                    item.type === 'note' &&
                    item.path.replace(/\.md$/i, '').toLowerCase() === (resolved || '').toLowerCase()
                );
            } else {
                note = this.notes.find((item) => item.path === this.currentNote);
            }
            if (!note) return;

            let outlinePromise;
            if (note.path === this.currentNote) {
                outlinePromise = Promise.resolve(extractHeadingOutline(this.noteContent || ''));
            } else {
                if (!this._wikilinkOutlineCache.has(note.path)) {
                    const request = api.getJSON(`/api/notes/${encodeVaultPath(note.path)}`)
                        .then((data) => {
                            if (!Array.isArray(data.outline)) {
                                throw new Error(`Note response did not include an outline: ${note.path}`);
                            }
                            return data.outline;
                        })
                        .catch((error) => {
                            if (this._wikilinkOutlineCache.get(note.path) === request) {
                                this._wikilinkOutlineCache.delete(note.path);
                            }
                            throw error;
                        });
                    this._wikilinkOutlineCache.set(note.path, request);
                }
                outlinePromise = this._wikilinkOutlineCache.get(note.path);
            }

            try {
                const outline = await outlinePromise;
                const wa = this.wikilinkAutocomplete;
                const textarea = document.getElementById('note-editor');
                const expectedTarget = `${pageTarget}#${query}`;
                if (generation !== this._wlHeadingGeneration
                    || document.activeElement !== textarea
                    || textarea.selectionStart !== textarea.selectionEnd
                    || wa.mode !== 'heading'
                    || wa.query !== query
                    || wa.tokenStart !== tokenStart
                    || this.noteContent.substring(tokenStart, textarea.selectionStart) !== expectedTarget) return;

                wa.headingItems = outline.map((heading) => ({
                    label: heading.text,
                    secondary: `#${heading.slug}`,
                    insert: `${pageTarget ? `${pageTarget}#` : '#'}${heading.slug}`,
                    kind: 'heading',
                    slug: heading.slug,
                }));
                this.wlComputeItems();
                if (wa.items.length === 0) { this.wlClose(); return; }
                wa.activeIndex = 0;
                wa.open = true;
                this._wlPosRetries = 0;
                this.$nextTick(() => this.wlUpdatePosition());
            } catch (error) {
                console.error('Failed to load wikilink heading suggestions:', error);
            }
        },

        // Build the (capped) suggestion list for the current query and mode.
        // `![[` suggests media only; `[[` suggests notes as link targets plus
        // media files (label keeps the extension, so accepting one inserts
        // [[report.pdf]] — a link, not an embed).
        wlComputeItems() {
            const WL_LIMIT = 8;
            const q = this.wikilinkAutocomplete.query.trim().toLowerCase();
            const isMedia = this.wikilinkAutocomplete.mode === 'media';
            const results = [];

            if (this.wikilinkAutocomplete.mode === 'heading') {
                for (const item of this.wikilinkAutocomplete.headingItems || []) {
                    const labelLower = item.label.toLowerCase();
                    const slugLower = item.slug.toLowerCase();
                    if (q && !labelLower.includes(q) && !slugLower.includes(q)) continue;
                    results.push({
                        ...item,
                        prefix: q ? labelLower.startsWith(q) || slugLower.startsWith(q) : true,
                    });
                }
                results.sort((a, b) => (b.prefix - a.prefix) || a.label.localeCompare(b.label));
                this.wikilinkAutocomplete.items = results.slice(0, WL_LIMIT);
                return;
            }

            for (const note of this.notes) {
                const isNote = note.type === 'note';
                if (isMedia && isNote) continue;

                const path = note.path;
                const folder = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';

                let label, insert;
                if (!isNote) {
                    label = path.split('/').pop();   // filename with extension
                    insert = label;
                } else {
                    const stem = note.name.replace(/\.md$/i, '');
                    label = stem;
                    // Bare name when unique, else folder-relative path (no extension).
                    insert = (this._noteNameCounts.get(stem.toLowerCase()) || 0) > 1
                        ? path.replace(/\.md$/i, '')
                        : stem;
                }

                const labelLower = label.toLowerCase();
                const pathLower = path.toLowerCase();
                if (q && !labelLower.includes(q) && !pathLower.includes(q)) continue;

                results.push({
                    label,
                    secondary: folder,
                    insert,
                    kind: note.type,
                    prefix: q ? labelLower.startsWith(q) : false,
                    modified: note.modified || '',
                });
            }

            // Prefix matches first, then notes ahead of media files, then
            // most-recently-modified, then alphabetical. `modified` is an ISO
            // timestamp, so lexical compare orders by time.
            const rank = (item) => (item.kind === 'note' ? 0 : 1);
            results.sort((a, b) =>
                (b.prefix - a.prefix) ||
                (rank(a) - rank(b)) ||
                b.modified.localeCompare(a.modified) ||
                a.label.localeCompare(b.label));
            this.wikilinkAutocomplete.items = results.slice(0, WL_LIMIT);
        },

        // Keyboard handling while the popup is open. Runs before the editor's
        // Enter/Tab handlers (registered later on the same element), so
        // stopImmediatePropagation keeps list-continuation and indent from firing.
        wlOnKeydown(event) {
            if (!this.wikilinkAutocomplete.open) return;
            const wa = this.wikilinkAutocomplete;

            switch (event.key) {
                case 'ArrowDown':
                    event.preventDefault(); event.stopImmediatePropagation();
                    this.wlMove(1);
                    return;
                case 'ArrowUp':
                    event.preventDefault(); event.stopImmediatePropagation();
                    this.wlMove(-1);
                    return;
                case 'Enter':
                case 'Tab':
                    event.preventDefault(); event.stopImmediatePropagation();
                    if (wa.items[wa.activeIndex]) this.wlAccept(wa.items[wa.activeIndex]);
                    return;
                case 'Escape':
                    event.preventDefault(); event.stopImmediatePropagation();
                    this.wlClose();
                    return;
                case 'ArrowLeft':
                case 'ArrowRight':
                case 'Home':
                case 'End':
                    this.wlClose();
                    return;
            }
        },

        wlMove(delta) {
            const n = this.wikilinkAutocomplete.items.length;
            if (!n) return;
            this.wikilinkAutocomplete.activeIndex =
                (this.wikilinkAutocomplete.activeIndex + delta + n) % n;
        },

        // Replace the in-progress token with the chosen target and close it off
        // with ]] (reusing an existing trailing ]] if present).
        wlAccept(item) {
            if (!item) return;
            const textarea = document.getElementById('note-editor');
            if (!textarea) return;

            const caret = textarea.selectionStart;
            const before = this.noteContent.substring(0, this.wikilinkAutocomplete.tokenStart);
            const after = this.noteContent.substring(caret);
            const head = before + item.insert;

            const hasClosing = after.startsWith(']]');
            this.noteContent = hasClosing ? (head + after) : (head + ']]' + after);
            const newCaret = head.length + 2; // after the ]]

            this.wlClose();
            this.$nextTick(() => {
                textarea.focus();
                textarea.selectionStart = textarea.selectionEnd = newCaret;
                this.autoSave();
                this.updateSyntaxHighlight();
            });
        },

        wlClose() {
            this._wlHeadingGeneration = (this._wlHeadingGeneration || 0) + 1;
            this.wikilinkAutocomplete.open = false;
        },

        // Position the popup just below the caret, clamped to the viewport.
        // The suggestion count varies with the query (1-8 rows), so the popup's
        // real size is measured from the DOM instead of guessed: a fixed guess
        // made the flip-to-above math place the popup a fixed distance above the
        // caret, leaving a visible gap whenever the list was shorter than the
        // guess (the popup then floated well above the [[ being typed).
        wlUpdatePosition() {
            const textarea = document.getElementById('note-editor');
            if (!textarea) return;
            const popup = document.getElementById('wikilink-autocomplete');
            const coords = this.wlCaretCoords(textarea, textarea.selectionStart);

            // On the tick the popup opens it can still be display:none, in which
            // case the rect is all zeros: fall back to a conservative estimate so
            // it never flashes at the top of the window, then re-measure on the
            // next frame once it is rendered.
            const pRect = popup ? popup.getBoundingClientRect() : null;
            const measured = !!(pRect && pRect.height);
            const popupW = measured ? pRect.width : 240;
            const popupH = measured ? pRect.height : 200;

            let left = coords.left;
            if (left + popupW > window.innerWidth - 4) left = window.innerWidth - popupW - 4;
            if (left < 4) left = 4;

            // Below the caret line by default; flip above only when it really
            // does not fit below, and only as high as its own height requires.
            let top = coords.top;
            if (popupH > window.innerHeight - top - 4) {
                const above = coords.top - coords.height - popupH;
                if (above >= 4) top = above;
            }
            if (top < 4) top = 4;

            this.wikilinkAutocomplete.position = { top, left };

            if (!measured && this.wikilinkAutocomplete.open && (this._wlPosRetries || 0) < 3) {
                this._wlPosRetries = (this._wlPosRetries || 0) + 1;
                requestAnimationFrame(() => {
                    if (this.wikilinkAutocomplete.open) this.wlUpdatePosition();
                });
            }
            if (measured) this._wlPosRetries = 0;
        },

        // Caret pixel coordinates inside a textarea via a hidden mirror element.
        // Mirrors the textarea-caret-position technique (a plain textarea exposes
        // no native caret geometry). Returns viewport-relative top/left of the line
        // below the caret, plus the line height.
        wlCaretCoords(textarea, position) {
            const props = [
                'direction', 'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
                'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
                'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
                'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontSizeAdjust',
                'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'textDecoration',
                'letterSpacing', 'wordSpacing', 'tabSize', 'MozTabSize',
            ];
            const computed = window.getComputedStyle(textarea);
            const div = document.createElement('div');
            const style = div.style;
            style.position = 'absolute';
            style.visibility = 'hidden';
            style.whiteSpace = 'pre-wrap';
            style.wordWrap = 'break-word';
            props.forEach(p => { style[p] = computed[p]; });

            div.textContent = textarea.value.substring(0, position);
            const span = document.createElement('span');
            span.textContent = textarea.value.substring(position) || '.';
            div.appendChild(span);
            document.body.appendChild(div);

            const lineHeight = parseInt(computed.lineHeight, 10) || parseInt(computed.fontSize, 10) * 1.2;
            const top = span.offsetTop + parseInt(computed.borderTopWidth, 10);
            const left = span.offsetLeft + parseInt(computed.borderLeftWidth, 10);
            document.body.removeChild(div);

            const rect = textarea.getBoundingClientRect();
            return {
                top: rect.top + top - textarea.scrollTop + lineHeight,
                left: rect.left + left - textarea.scrollLeft,
                height: lineHeight,
            };
        },
        
        // Resolve a Markdown image path to a vault-relative path (forward slashes).
        // Relative paths use the note file's directory as base (same rules as CommonMark / browsers).
        // A leading "/" (not "//") means vault-root-relative.
        resolveMarkdownMediaPathForNote(noteVaultPath, rawSrc) {
            const pathPart = rawSrc.split('#')[0].split('?')[0];
            if (!pathPart) return '';
            if (pathPart.startsWith('/') && !pathPart.startsWith('//')) {
                return pathPart.replace(/^\/+/, '');
            }
            if (!noteVaultPath) {
                return pathPart;
            }
            const dir = noteVaultPath.includes('/')
                ? noteVaultPath.slice(0, noteVaultPath.lastIndexOf('/'))
                : '';
            const base = `https://vn.invalid/${dir ? `${dir}/` : ''}`;
            try {
                const u = new URL(pathPart, base);
                let p = u.pathname;
                if (p.startsWith('/')) p = p.slice(1);
                return p.split('/').filter(seg => seg !== '').map(seg => {
                    try {
                        return decodeURIComponent(seg);
                    } catch (e) {
                        return seg;
                    }
                }).join('/');
            } catch (e) {
                return pathPart;
            }
        },
        
        encodeVaultRelativePathForMediaApi(vaultRelativePath) {
            if (!vaultRelativePath) return '';
            return vaultRelativePath.split('/').map(segment => {
                try {
                    return encodeURIComponent(decodeURIComponent(segment));
                } catch (e) {
                    return encodeURIComponent(segment);
                }
            }).join('/');
        },
    };
}
