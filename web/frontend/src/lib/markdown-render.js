const INLINE_RENDER_THRESHOLD = 100_000;
const MARKDOWN_BLOCK_START_RE = /^[ \t]{0,3}(?:#{1,6}[ \t]+|>|[-+*][ \t]+|\d+[.)][ \t]+|`{3,}|~{3,}|<\/?(?:address|article|aside|blockquote|div|dl|fieldset|figure|footer|form|h[1-6]|header|hr|iframe|main|nav|ol|p|pre|section|script|style|table|ul)\b)/im;
const MARKDOWN_BLOCK_RULE_RE = /^[ \t]{0,3}(?:={2,}|(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$/m;
const MARKDOWN_TABLE_ROW_RE = /^[ \t]*\|.*(?:\||$)/m;
const MARKDOWN_TABLE_DIVIDER_RE = /^[ \t]*:?-{1,}:?[ \t]*\|(?:[ \t]*:?-{1,}:?[ \t]*\|?)+[ \t]*$/m;
const MARKDOWN_REFERENCE_RE = /^[ \t]{0,3}\[[^\]]+\]:[ \t]/m;

// Synchronous markdown rendering pipeline for the preview pane.
//
// Extracted from the getter in preview.js so it can be unit tested without
// Alpine or a DOM. The pure function takes the note content, current note path,
// note lookup maps, and theme type; it returns the sanitized HTML string.
//
// Async post-processing (MathJax, Mermaid, syntax highlighting, video metadata)
// is NOT done here; callers schedule that work after setting the HTML.
export function renderMarkdownSync({
    noteContent,
    currentNote,
    noteLookupByPath,
    noteLookupByPathLower,
    mediaLookup,
    mediaLookupStem,
    resolveWikiLink,
    resolveMediaWikilink,
    resolveMarkdownMediaPathForNote,
    encodeVaultRelativePathForMediaApi,
    getMediaType,
    typeIconSvg,
    escapeHtml,
}) {
    if (!noteContent) {
        return '<p style="color: var(--text-tertiary);">Nothing to preview yet...</p>';
    }

    // Strip YAML frontmatter from content before rendering
    let contentToRender = noteContent;
    if (contentToRender.trim().startsWith('---')) {
        const lines = contentToRender.split('\n');
        if (lines[0].trim() === '---') {
            let endIdx = -1;
            for (let i = 1; i < lines.length; i++) {
                if (lines[i].trim() === '---') {
                    endIdx = i;
                    break;
                }
            }
            if (endIdx !== -1) {
                contentToRender = lines.slice(endIdx + 1).join('\n').trim();
            }
        }
    }

    // Helper: parse Obsidian-style inline image size spec
    const parseImageSizeSpec = (text, opts = {}) => {
        const allowSolo = opts.allowSolo === true;
        if (!text) return { alt: '', width: null, height: null };
        const trimmed = text.trim();
        if (allowSolo) {
            const solo = trimmed.match(/^(\d+)(?:[xX](\d+))?$/);
            if (solo) {
                const w = parseInt(solo[1], 10);
                const h = solo[2] !== undefined ? parseInt(solo[2], 10) : null;
                return {
                    alt: '',
                    width: w > 0 ? w : null,
                    height: (h !== null && h > 0) ? h : null,
                };
            }
        }
        const idx = trimmed.lastIndexOf('|');
        if (idx === -1) return { alt: trimmed, width: null, height: null };
        const size = trimmed.slice(idx + 1).trim();
        const m = size.match(/^(\d+)(?:[xX](\d+))?$/);
        if (!m) return { alt: trimmed, width: null, height: null };
        const w = parseInt(m[1], 10);
        const h = m[2] !== undefined ? parseInt(m[2], 10) : null;
        return {
            alt: trimmed.slice(0, idx).trim(),
            width: w > 0 ? w : null,
            height: (h !== null && h > 0) ? h : null,
        };
    };

    // Step 0: GFM/GLFM callouts. Runs BEFORE code-block extraction so
    // fences nested in a callout blockquote lose their `> ` prefix on
    // the closer — otherwise CommonMark won't see a valid fence closer
    // once restored inside <div class="callout-body"> and the block
    // runs unclosed. Fence-aware so `> [!TIP]` literal inside a
    // top-level code block is not misread as a callout.
    {
        const CALLOUT_RE = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i;
        const svg = (paths) => '<svg class="callout-icon-svg" viewBox="0 0 24 24" '
            + 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" '
            + 'stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
        const CALLOUT_ICONS = {
            note: svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
            tip: svg('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>'),
            important: svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>'),
            warning: svg('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
            caution: svg('<path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86L7.86 2z"/><path d="M12 8v4"/><path d="M12 16h.01"/>'),
        };
        const CALLOUT_TITLES = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };
        const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})/;
        const escapeAttr = (s) => s.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');

        const srcLines = contentToRender.split('\n');
        const outLines = [];
        let li = 0;
        let fenceChar = null;
        let fenceLen = 0;
        while (li < srcLines.length) {
            const line = srcLines[li];

            if (fenceChar) {
                outLines.push(line);
                const closeRe = new RegExp('^\\s{0,3}' + (fenceChar === '`' ? '`' : '~') + '{' + fenceLen + ',}\\s*$');
                if (closeRe.test(line)) { fenceChar = null; fenceLen = 0; }
                li++;
                continue;
            }

            const fenceOpen = line.match(FENCE_OPEN_RE);
            if (fenceOpen) {
                fenceChar = fenceOpen[1][0];
                fenceLen = fenceOpen[1].length;
                outLines.push(line);
                li++;
                continue;
            }

            const m = line.match(CALLOUT_RE);
            if (!m) {
                outLines.push(line);
                li++;
                continue;
            }
            const type = m[1].toLowerCase();
            const title = escapeAttr((m[2] || '').trim() || CALLOUT_TITLES[type]);
            const icon = CALLOUT_ICONS[type];
            const bodyLines = [];
            li++;
            while (li < srcLines.length && srcLines[li].startsWith('>')) {
                bodyLines.push(srcLines[li].replace(/^>\s?/, ''));
                li++;
            }
            outLines.push(
                '',
                `<div class="callout callout-${type}">`,
                `<div class="callout-title"><span class="callout-icon" aria-hidden="true">${icon}</span><span class="callout-title-text">${title}</span></div>`,
                `<div class="callout-body">`,
                '',
                bodyLines.join('\n'),
                '',
                `</div>`,
                `</div>`,
                ''
            );
        }
        contentToRender = outLines.join('\n');
    }

    // Step 1: Temporarily replace code blocks and inline code with rendered
    // HTML so note/media link substitutions do not modify their contents.
    const codeBlocks = [];
    const preserveRenderedHtml = (html) => {
        codeBlocks.push(html);
        return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
    };
    contentToRender = contentToRender.replace(/```[\s\S]*?```/g, (match) => {
        codeBlocks.push(typeof marked !== 'undefined'
            ? marked.parse(match, { async: false })
            : `<pre><code>${escapeHtml(match.slice(3, -3))}</code></pre>`);
        return `<!--CODEBLOCK${codeBlocks.length - 1}-->`;
    });
    contentToRender = contentToRender.replace(/`([^`\n]+)`/g, (match, code) => {
        codeBlocks.push(`<code>${escapeHtml(code)}</code>`);
        return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
    });

    // Step 2: Convert media wikilinks FIRST: ![[file.png]] or ![[file.png|alt text]]
    contentToRender = contentToRender.replace(
        /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
        (match, mediaName, altText) => {
            const filename = mediaName.trim();
            const rawAlt = altText ? altText.trim() : '';
            const spec = parseImageSizeSpec(rawAlt, { allowSolo: true });
            const alt = spec.alt || filename.replace(/\.[^/.]+$/, '');
            const stylePieces = [];
            if (spec.width) stylePieces.push(`width:${spec.width}px`);
            if (spec.height) stylePieces.push(`height:${spec.height}px`);
            const sizeAttrs = (spec.width ? ` width="${spec.width}"` : '') +
                              (spec.height ? ` height="${spec.height}"` : '') +
                              (stylePieces.length ? ` style="${stylePieces.join(';')}"` : '');

            const mediaPath = resolveMediaWikilink(filename);

            if (mediaPath) {
                const encodedPath = mediaPath.split('/').map(segment => {
                    try {
                        return encodeURIComponent(decodeURIComponent(segment));
                    } catch (e) {
                        return encodeURIComponent(segment);
                    }
                }).join('/');

                const safeAlt = alt.replace(/"/g, '"');
                const mediaSrc = `/api/media/${encodedPath}`;
                const mediaType = getMediaType(filename);

                switch (mediaType) {
                    case 'audio':
                        return `<div class="media-embed media-audio"><audio controls preload="none" src="${mediaSrc}" title="${safeAlt}"></audio><span class="media-caption">${safeAlt}</span></div>`;
                    case 'video':
                        return `<div class="media-embed media-video"><video controls preload="none" poster="" src="${mediaSrc}" title="${safeAlt}"></video></div>`;
                    case 'document':
                        return `<span class="md-pdf-embed" data-src="${mediaSrc}" data-alt="${safeAlt}"></span>`;
                    default: // image
                        return `<img src="${mediaSrc}" alt="${safeAlt}" title="${safeAlt}"${sizeAttrs}>`;
                }
            }

            const safeFilename = filename.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
            const mediaType = getMediaType(filename);
            const icon = typeIconSvg(mediaType || 'image');
            return `<span class="wikilink-broken" title="Media not found">${icon} ${safeFilename}</span>`;
        }
    );

    // Step 3: Convert note wikilinks: [[note]] or [[note|display text]]
    contentToRender = contentToRender.replace(
        /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
        (match, target, displayText) => {
            const linkTarget = target.trim();
            const display = displayText ? displayText.trim() : linkTarget;
            const hashIndex = linkTarget.indexOf('#');
            const noteTarget = hashIndex === -1 ? linkTarget : linkTarget.substring(0, hashIndex);
            const anchor = hashIndex === -1 ? null : linkTarget.substring(hashIndex + 1);
            const resolved = resolveWikiLink(
                noteTarget,
                currentNote ? currentNote.split('/').slice(0, -1).join('/') : '',
            );
            if (resolved) {
                const safeDisplay = display.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
                const href = `/${resolved}${anchor === null ? '' : `#${encodeURIComponent(anchor)}`}`;
                return preserveRenderedHtml(`<a href="${href}" class="wikilink" data-wikilink="${linkTarget.replace(/"/g, '"')}">${safeDisplay}</a>`);
            }
            const safeDisplay = display.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
            return preserveRenderedHtml(`<span class="wikilink-broken" title="Note not found">${safeDisplay}</span>`);
        }
    );

    // Step 4: Render markdown with marked
    // We need marked to be available globally
    let html;
    if (typeof marked !== 'undefined') {
        const options = { async: false };
        if (typeof marked.Renderer === 'function') {
            const renderer = new marked.Renderer();
            const renderDefaultImage = renderer.image.bind(renderer);
            renderer.image = (image, title, text) => {
                const href = typeof image === 'string' ? image : (image.href || '');
                const imageTitle = typeof image === 'string' ? title : image.title;
                const imageText = typeof image === 'string' ? text : image.text;
                if (
                    !href ||
                    /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href) ||
                    href.startsWith('/api/media/')
                ) {
                    return renderDefaultImage(image, title, text);
                }

                const mediaPath = resolveMarkdownMediaPathForNote(currentNote, href);
                if (!mediaPath) return renderDefaultImage(image, title, text);
                const encodedPath = encodeVaultRelativePathForMediaApi(mediaPath);
                const src = `/api/media/${encodedPath}`;
                const alt = escapeHtml(imageText || '').replace(/"/g, '&quot;');
                const titleAttribute = imageTitle
                    ? ` title="${escapeHtml(imageTitle).replace(/"/g, '&quot;')}"`
                    : '';
                return `<img src="${src}" alt="${alt}"${titleAttribute}>`;
            };
            options.renderer = renderer;
        }
        const isOneLargeParagraph = contentToRender.length >= INLINE_RENDER_THRESHOLD
            && !/\n[ \t]*\r?\n/.test(contentToRender)
            && !MARKDOWN_BLOCK_START_RE.test(contentToRender)
            && !MARKDOWN_BLOCK_RULE_RE.test(contentToRender)
            && !MARKDOWN_TABLE_ROW_RE.test(contentToRender)
            && !MARKDOWN_TABLE_DIVIDER_RE.test(contentToRender)
            && !MARKDOWN_REFERENCE_RE.test(contentToRender)
            && !/^[ \t]{0,3}<!--/m.test(contentToRender)
            && !/<!--CODEBLOCK\d+-->/.test(contentToRender);
        html = isOneLargeParagraph && typeof marked.parseInline === 'function'
            ? `<p>${marked.parseInline(contentToRender, options)}</p>\n`
            : marked.parse(contentToRender, options);
    } else {
        html = contentToRender; // fallback if marked not loaded yet
    }

    // Step 5: Restore code blocks
    html = html.replace(/<!--CODEBLOCK(\d+)-->/g, (match, index) => codeBlocks[parseInt(index, 10)]);
    html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (match, index) => codeBlocks[parseInt(index, 10)]);

    // Step 6: Sanitize with DOMPurify (must run after marked to clean the output)
    if (typeof DOMPurify !== 'undefined') {
        html = DOMPurify.sanitize(html, {
            ADD_TAGS: ['span', 'svg', 'path', 'circle', 'audio', 'video', 'source', 'iframe'],
            ADD_ATTR: ['class', 'data-*', 'style', 'controls', 'preload', 'src', 'poster', 'title', 'alt', 'width', 'height', 'frameborder', 'allowfullscreen'],
        });
    }

    return html;
}