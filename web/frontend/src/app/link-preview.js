// Hover preview cards for internal links + link navigation.
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import { CONFIG, LOCAL_SETTINGS } from '../core/config.js';
import * as api from '../core/api.js';
import { ErrorHandler, encodeVaultPath, FilenameValidator } from '../core/utils.js';

export function createLinkPreview() {
    return {

        // ---- Hover previews for internal links --------------------------------
        // A small card next to a link shows the target note (or the linked
        // heading's section) so the user can peek without opening it. Bound
        // once to the document so it also works after Alpine re-renders the
        // preview HTML on every keystroke.
        initLinkPreviews() {
            if (this._linkPreviewBound) return;
            this._linkPreviewBound = true;
            this._linkPreviewCache = new Map();

            const selector = '.markdown-preview a[href]';
            const linkFrom = (event) => {
                const target = event.target;
                return target && target.closest ? target.closest(selector) : null;
            };

            document.addEventListener('mouseover', (event) => {
                const link = linkFrom(event);
                if (!link) return;
                this._scheduleLinkPreview(link);
            });

            document.addEventListener('mouseout', (event) => {
                const link = linkFrom(event);
                if (!link) return;
                if (event.relatedTarget && link.contains(event.relatedTarget)) return;
                this._scheduleLinkPreviewHide();
            });

            // Scrolling the page moves the anchor, so the card would float in
            // the wrong place. Scrolling inside the card itself is fine.
            document.addEventListener('scroll', (event) => {
                if (event.target && event.target.closest && event.target.closest('#link-preview-card')) return;
                this._hideLinkPreview();
            }, true);

            document.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') this._hideLinkPreview();
            });

            document.addEventListener('click', (event) => {
                if (linkFrom(event)) this._hideLinkPreview();
            }, true);
        },

        _ensureLinkPreviewCard() {
            let card = document.getElementById('link-preview-card');
            if (card) return card;

            card = document.createElement('div');
            card.id = 'link-preview-card';
            card.className = 'link-preview-card';
            card.setAttribute('role', 'tooltip');
            card.addEventListener('mouseenter', () => {
                clearTimeout(this._linkPreviewHideTimer);
            });
            card.addEventListener('mouseleave', () => {
                this._scheduleLinkPreviewHide();
            });
            document.body.appendChild(card);
            return card;
        },

        // Resolve an <a> in the preview to the note it points at. Returns null
        // for external/media links and unresolved notes.
        _resolveLinkPreviewTarget(link) {
            const href = (link.getAttribute('href') || '').trim();
            if (!href) return null;

            const externalPrefixes = [
                'http://', 'https://', '//', 'mailto:', 'tel:', 'ssh:', 'ftp:',
                'sftp:', 'slack:', 'discord:', 'teams:', 'vscode:', 'zoom:',
                'whatsapp:', 'telegram:', 'signal:', 'spotify:', 'steam:',
                'magnet:', 'data:', '/api/'
            ];
            if (externalPrefixes.some((prefix) => href.startsWith(prefix))) return null;

            let decodedHref = href;
            try {
                decodedHref = decodeURIComponent(href);
            } catch (e) {
                // A literal '%' in a filename must not break the preview.
            }

            const hashIndex = decodedHref.indexOf('#');
            let rawPath = hashIndex !== -1 ? decodedHref.substring(0, hashIndex) : decodedHref;
            const anchor = hashIndex !== -1 ? decodedHref.substring(hashIndex + 1) : '';
            rawPath = rawPath.split('?')[0];
            const notePath = rawPath.replace(/^\/+/, '');

            // In-page anchor: preview the corresponding section of this note.
            if (!notePath) {
                if (!anchor || !this.currentNote) return null;
                const currentName = this.currentNote.split('/').pop().replace(/\.md$/i, '');
                return {
                    path: this.currentNote,
                    anchor,
                    label: currentName || this.currentNote,
                };
            }

            let targetNote = this.notes.find((note) =>
                note.path === notePath || note.path === notePath + '.md'
            );

            if (!targetNote) {
                const sourceFolder = this.currentNote && this.currentNote.includes('/')
                    ? this.currentNote.substring(0, this.currentNote.lastIndexOf('/'))
                    : '';
                const resolved = this.resolveWikiLink(notePath, sourceFolder);
                if (resolved) {
                    targetNote = this.notes.find((note) =>
                        note.path === resolved || note.path === resolved + '.md'
                    );
                }
            }

            // Media has its own viewer and no markdown text to preview.
            if (!targetNote || (targetNote.type && targetNote.type !== 'note')) return null;

            return {
                path: targetNote.path,
                anchor,
                label: (anchor && link.textContent.includes('#'))
                    ? (targetNote.name || targetNote.path)
                    : (link.textContent.trim() || targetNote.name || targetNote.path),
            };
        },

        _scheduleLinkPreview(link) {
            const target = this._resolveLinkPreviewTarget(link);
            if (!target) {
                this._scheduleLinkPreviewHide();
                return;
            }
            if (this._linkPreviewAnchor === link) {
                clearTimeout(this._linkPreviewHideTimer);
                return;
            }

            // Moving to a different link: drop the previous card right away
            // instead of showing the old link's content while the new delay
            // runs.
            if (this._linkPreviewAnchor) this._hideLinkPreview();

            clearTimeout(this._linkPreviewTimer);
            clearTimeout(this._linkPreviewHideTimer);
            this._linkPreviewAnchor = link;
            this._linkPreviewTimer = setTimeout(() => {
                this._showLinkPreview(link, target);
            }, CONFIG.LINK_PREVIEW_DELAY);
        },

        _scheduleLinkPreviewHide() {
            clearTimeout(this._linkPreviewTimer);
            clearTimeout(this._linkPreviewHideTimer);
            this._linkPreviewHideTimer = setTimeout(() => this._hideLinkPreview(), 180);
        },

        _hideLinkPreview() {
            clearTimeout(this._linkPreviewTimer);
            clearTimeout(this._linkPreviewHideTimer);
            this._linkPreviewAnchor = null;
            this._linkPreviewToken = (this._linkPreviewToken || 0) + 1;
            const card = document.getElementById('link-preview-card');
            if (card) card.classList.remove('is-visible');
        },

        _linkPreviewHeader(label, anchor) {
            const safeLabel = this.escapeHtml(label || '');
            const anchorHtml = anchor
                ? `<span class="link-preview-anchor">#${this.escapeHtml(anchor)}</span>`
                : '';
            return `<div class="link-preview-header"><span class="link-preview-title">${safeLabel}</span>${anchorHtml}</div>`;
        },

        async _showLinkPreview(link, target) {
            this._linkPreviewTimer = null;
            const token = (this._linkPreviewToken || 0) + 1;
            this._linkPreviewToken = token;
            const card = this._ensureLinkPreviewCard();

            card.innerHTML = this._linkPreviewHeader(target.label, target.anchor) +
                `<div class="link-preview-loading">${this.escapeHtml(this.t('common.loading'))}</div>`;
            this._positionLinkPreview(card, link);
            card.classList.add('is-visible');

            try {
                const data = await this._loadLinkPreviewData(target.path);
                if (token !== this._linkPreviewToken || this._linkPreviewAnchor !== link) return;

                card.innerHTML = this._linkPreviewHeader(target.label, target.anchor) +
                    `<div class="link-preview-body markdown-preview">${this._buildLinkPreviewHTML(data, target.anchor)}</div>`;
                this._positionLinkPreview(card, link);
            } catch (error) {
                if (token !== this._linkPreviewToken || this._linkPreviewAnchor !== link) return;
                card.innerHTML = this._linkPreviewHeader(target.label, target.anchor) +
                    `<div class="link-preview-error">${this.escapeHtml(this.t('common.error'))}</div>`;
                this._positionLinkPreview(card, link);
            }
        },

        async _loadLinkPreviewData(notePath) {
            // In-page anchors and self-links should reflect unsaved edits, not
            // the last version written to disk.
            if (notePath === this.currentNote) {
                return {
                    content: this.noteContent || '',
                    outline: this.outline || [],
                    at: Date.now(),
                };
            }

            if (!this._linkPreviewCache) this._linkPreviewCache = new Map();
            const cached = this._linkPreviewCache.get(notePath);
            if (cached && Date.now() - cached.at < 30000) return cached;

            const data = await api.getJSON(`/api/notes/${encodeVaultPath(notePath)}`);
            const entry = {
                content: data.content || '',
                outline: Array.isArray(data.outline) ? data.outline : [],
                at: Date.now(),
            };
            this._linkPreviewCache.set(notePath, entry);
            return entry;
        },

        _linkPreviewSlug(text) {
            return (text || '')
                .toLowerCase()
                .replace(/[^\w\s-]/g, '')
                .replace(/\s+/g, '-')
                .replace(/-+/g, '-');
        },

        // Pick the text to show: the linked heading's section when there is an
        // anchor, otherwise the beginning of the note.
        _linkPreviewExcerpt(content, outline, anchor) {
            const lines = (content || '').split('\n');

            // Keep original line numbers so outline entries (which count from
            // the top of the file) still point at the right place. Only the
            // default start line moves past a leading YAML block.
            let contentStart = 0;
            if (lines.length > 0 && lines[0].trim() === '---') {
                const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
                if (end !== -1) contentStart = end + 1;
            }

            let startLine = contentStart + 1;
            let endLine = lines.length;

            if (anchor) {
                const slug = this._linkPreviewSlug(anchor);
                const items = Array.isArray(outline) ? outline : [];
                const heading = items.find((item) =>
                    item.slug === slug ||
                    this._linkPreviewSlug(item.text) === slug ||
                    (item.text || '').toLowerCase() === anchor.toLowerCase()
                );
                if (heading && heading.line > 0) {
                    startLine = heading.line;
                    const next = items.find((item) =>
                        item.line > heading.line && item.level <= heading.level
                    );
                    if (next) endLine = next.line - 1;
                }
            }

            let excerptLines = lines.slice(startLine - 1, endLine);
            if (excerptLines.join('').trim() === '') {
                excerptLines = lines.slice(contentStart, contentStart + 40);
            }

            return excerptLines.join('\n').trim();
        },

        _buildLinkPreviewHTML(data, anchor) {
            const excerpt = this._linkPreviewExcerpt(data.content, data.outline, anchor);
            if (!excerpt) {
                return '<p class="link-preview-empty">—</p>';
            }

            let html = DOMPurify.sanitize(marked.parse(excerpt));
            const container = document.createElement('div');
            container.innerHTML = html;

            // A card is for reading, not for navigating or loading media.
            container.querySelectorAll('img, video, audio, iframe, input, button, .media-embed, .md-pdf-embed')
                .forEach((el) => el.remove());
            container.querySelectorAll('a').forEach((a) => {
                a.removeAttribute('href');
                a.removeAttribute('target');
                a.removeAttribute('rel');
            });

            return container.innerHTML;
        },

        _positionLinkPreview(card, link) {
            const margin = 10;
            const rect = link.getBoundingClientRect();
            const wasHidden = !card.classList.contains('is-visible');

            if (wasHidden) {
                card.style.visibility = 'hidden';
                card.classList.add('is-visible');
            }

            const cardRect = card.getBoundingClientRect();
            let left = rect.left;
            const maxLeft = window.innerWidth - cardRect.width - margin;
            if (left > maxLeft) left = maxLeft;
            if (left < margin) left = margin;

            let top = rect.bottom + 8;
            if (top + cardRect.height > window.innerHeight - margin) {
                top = rect.top - cardRect.height - 8;
            }
            if (top < margin) top = margin;

            card.style.left = `${Math.round(left)}px`;
            card.style.top = `${Math.round(top)}px`;

            if (wasHidden) card.style.visibility = '';
        },

        // Handle clicks on internal links in preview
        handleInternalLink(event) {
            // Check if clicked element is a link
            const link = event.target.closest('a');
            if (!link) return;
            
            const href = link.getAttribute('href');
            if (!href) return;
            
            // Check if it's an external link or API path (media files, etc.)
            // Safe external protocols: http, https, mailto, tel, ssh, ftp, sftp, and app deep links
            const externalProtocols = ['http://', 'https://', '//', 'mailto:', 'tel:', 'ssh:', 'ftp:', 'sftp:', 'slack:', 'discord:', 'teams:', 'vscode:', 'zoom:', 'whatsapp:', 'telegram:', 'signal:', 'spotify:', 'steam:', 'magnet:', '/api/'];
            if (externalProtocols.some(p => href.startsWith(p))) {
                return; // Let external links and API paths work normally
            }
            
            // Prevent default navigation for internal links
            event.preventDefault();
            
            // Parse href into note path and anchor (e.g., "note.md#section" -> notePath="note.md", anchor="section")
            const decodedHref = decodeURIComponent(href);
            const hashIndex = decodedHref.indexOf('#');
            const rawPath = hashIndex !== -1 ? decodedHref.substring(0, hashIndex) : decodedHref;
            const anchor = hashIndex !== -1 ? decodedHref.substring(hashIndex + 1) : null;

            // Root-relative hrefs like /folder/note are vault paths with a slash bolted
            // on, and vault paths carry none. Protocol-relative //host already returned
            // above as external, so nothing here can be a host.
            const notePath = rawPath.replace(/^\/+/, '');
            
            // If it's just an anchor link (#heading), scroll within current note
            if (!notePath && anchor) {
                this.scrollToAnchor(anchor);
                return;
            }
            
            // Skip if no path
            if (!notePath) return;
            
            // Exact match first (covers media files and direct vault paths).
            let targetNote = this.notes.find(n => 
                n.path === notePath || 
                n.path === notePath + '.md'
            );
            
            if (!targetNote) {
                // Otherwise use the single resolver shared with the preview
                // renderer (relative to the current note's folder, then vault
                // root, then note stem — mirrors vault.LinkResolver).
                const sourceFolder = this.currentNote && this.currentNote.includes('/')
                    ? this.currentNote.substring(0, this.currentNote.lastIndexOf('/'))
                    : '';
                const resolved = this.resolveWikiLink(notePath, sourceFolder);
                if (resolved !== null) {
                    targetNote = this.notes.find(n =>
                        n.path === resolved ||
                        n.path === resolved + '.md'
                    );
                }
            }
            
            if (targetNote) {
                // Media files (PDF, images, audio, video) must open in the media
                // viewer — loadNote() would fetch the raw binary through
                // /api/notes and render it as a garbage "note".
                if (targetNote.type && targetNote.type !== 'note') {
                    this.openItem(targetNote.path, targetNote.type);
                    return;
                }
                // Load the note, then scroll to anchor if present
                this.loadNote(targetNote.path).then(() => {
                    if (anchor) {
                        // Small delay to ensure content is rendered
                        setTimeout(() => this.scrollToAnchor(anchor), 100);
                    }
                });
            } else {
                this.confirmModalAsk({
                    message: this.t('notes.create_from_link', { path: notePath }),
                    danger: false,
                    title: this.t('sidebar.new_note'),
                    confirmLabel: this.t('common.create'),
                }).then((ok) => {
                    if (ok) this.createNote(null, notePath);
                });
            }
        },
        
        // Scroll to an anchor (heading) by slug - reuses outline data
        scrollToAnchor(anchor) {
            // Normalize the anchor (GitHub-style slug)
            const targetSlug = anchor
                .toLowerCase()
                .replace(/[^\w\s-]/g, '')
                .replace(/\s+/g, '-')
                .replace(/-+/g, '-');
            
            // Find matching heading in outline
            const heading = this.outline.find(h => h.slug === targetSlug);
            
            if (heading) {
                this.scrollToHeading(heading);
            } else {
                // Fallback: try to find heading by exact text match
                const headingByText = this.outline.find(h => 
                    h.text.toLowerCase().replace(/\s+/g, '-') === anchor.toLowerCase()
                );
                if (headingByText) {
                    this.scrollToHeading(headingByText);
                }
            }
        },
    };
}
