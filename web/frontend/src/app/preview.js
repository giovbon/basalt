// Markdown preview rendering and rich-block post-processing.
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import * as api from '../core/api.js';
import { encodeVaultPath } from '../core/utils.js';
import { renderMarkdownSync } from '../lib/markdown-render.js';
import {
    findDataviewQueries,
    previewSourceWithDataviewResults,
    formatDataviewResult,
    formatDataviewError,
} from '../lib/dataview.js';
import { isMarkmapNote } from '../lib/markmap-note.js';
import { typeIconSvg } from '../lib/file-icons.js';

const MARKMAP_RENDER_DEBOUNCE_MS = 500;
const MAX_DATAVIEW_QUERIES_PER_NOTE = 5;
const DATAVIEW_QUERY_DEBOUNCE_MS = 300;
const PREVIEW_RENDER_DEBOUNCE_MS = 120;

export function createPreview() {
    return {
        // Trigger MathJax typesetting after DOM update.
        // MathJax's combined build (~1 MB) is fetched on the first note that
        // actually contains math — mirrors the lazy loadMermaid() pattern.
        typesetMath() {
            if (typeof MathJax === 'undefined') {
                if (!this._mathLoadPromise) {
                    if (!this._noteHasMath()) return; // most notes have no math
                    this._mathLoadPromise = new Promise((resolve, reject) => {
                        const s = document.createElement('script');
                        // Fonts and TeX extensions resolve relative to this URL.
                        s.src = '/static/vendor/mathjax/tex-mml-chtml.js';
                        s.onload = resolve;
                        s.onerror = reject;
                        document.head.appendChild(s);
                    });
                    this._mathLoadPromise.catch(() => {
                        this._mathLoadPromise = null; // let the next note retry
                    });
                }
                this._mathLoadPromise.then(() => {
                    if (typeof MathJax !== 'undefined') this.typesetMath();
                }).catch(() => {});
                return;
            }
            if (MathJax.typesetPromise) {
                // Use a small delay to ensure DOM is updated
                setTimeout(() => {
                    const previewContent = document.querySelector('.markdown-preview');
                    if (previewContent) {
                        MathJax.typesetPromise([previewContent]).then(() => {
                            // Typesetting replaces the math DOM, dropping any
                            // search mark inside it.
                            if (this.currentSearchHighlight) this._reapplySearchHighlights();
                        }).catch((err) => {
                            console.error('MathJax typesetting failed:', err);
                        });
                    }
                }, 10);
            }
        },

        // Whether the note source plausibly contains TeX math delimiters.
        // False positives (e.g. "$5 or $10" spanning a line) only cost an
        // unnecessary library load; false negatives just skip typesetting a
        // note whose delimiters would not have matched the config anyway.
        _noteHasMath() {
            return /\$\$|\\\(|\\\[|\$[^$\n]+\$/.test(this.noteContent || '');
        },
        
        // Computed property for rendered markdown
        
        // Rendered markdown HTML for the preview pane. This is a cached value
        // updated by renderPreview(); the getter just returns it (or a placeholder).
        get renderedMarkdown() {
            return this._cachedRenderedHTML || '<p style="color: var(--text-tertiary);">Nothing to preview yet...</p>';
        },

        schedulePreviewRender() {
            if (this._previewRenderTimeout != null) {
                clearTimeout(this._previewRenderTimeout);
            }
            this._previewRenderTimeout = setTimeout(() => {
                this._previewRenderTimeout = null;
                this.renderPreview();
            }, PREVIEW_RENDER_DEBOUNCE_MS);
        },

        // Synchronous markdown rendering + DOM post-processing setup.
        // Call this when noteContent or currentNote changes.
        renderPreview() {
            if (this._previewRenderTimeout != null) {
                clearTimeout(this._previewRenderTimeout);
                this._previewRenderTimeout = null;
            }

            const queryGeneration = (this._queryRenderGeneration || 0) + 1;
            this._queryRenderGeneration = queryGeneration;
            const previewGeneration = (this._previewRenderGeneration || 0) + 1;
            this._previewRenderGeneration = previewGeneration;
            if (this._dataviewQueryTimeout) {
                clearTimeout(this._dataviewQueryTimeout);
                this._dataviewQueryTimeout = null;
            }
            if (!this.noteContent) {
                this.clearMarkmap();
                this._cachedRenderedHTML = '<p style="color: var(--text-tertiary);">Nothing to preview yet...</p>';
                return this._cachedRenderedHTML;
            }

            if (isMarkmapNote(this.noteContent)) {
                this._cachedRenderedHTML = '<div class="markmap-container"><svg class="markmap-svg" aria-label="Mapa mental"></svg></div>';
                this._lastRenderedContent = this.noteContent;
                this._lastRenderedNote = this.currentNote;
                this.schedulePreviewPostProcessing();
                return this._cachedRenderedHTML;
            }

            this.clearMarkmap();

            // Build the synchronous HTML using the pure renderer
            const queryBlocks = findDataviewQueries(this.noteContent);
            const previewSource = queryBlocks.length
                ? previewSourceWithDataviewResults(
                    this.noteContent,
                    queryBlocks,
                    this._dataviewResults || {},
                )
                : this.noteContent;
            const html = this._renderMarkdownContent(previewSource);

            // Cache immediately so the getter returns the new content
            this._cachedRenderedHTML = html;
            this._lastRenderedContent = this.noteContent;
            this._lastRenderedNote = this.currentNote;
            this._scheduleSearchHighlightRefresh(previewGeneration);

            if (queryBlocks.length) {
                this._scheduleDataviewQueries(queryBlocks, this.noteContent, this.currentNote, queryGeneration);
            }

            // Schedule async post-processing (MathJax, Mermaid, syntax highlighting, video)
            this.schedulePreviewPostProcessing();

            return html;
        },

        _scheduleSearchHighlightRefresh(generation) {
            if (!this.currentSearchHighlight || typeof this.$nextTick !== 'function') return;
            const notePath = this.currentNote;
            this.$nextTick(() => {
                requestAnimationFrame(() => {
                    if (generation !== this._previewRenderGeneration
                        || notePath !== this.currentNote
                        || !this.currentSearchHighlight) return;

                    const target = this._searchTargetAfterRender;
                    if (target
                        && target.notePath === notePath
                        && target.query === this.currentSearchHighlight) {
                        this.highlightSearchTerm(target.query, false, target.line, target.column);
                        if (this.currentMatchIndex >= 0) this._searchTargetAfterRender = null;
                        return;
                    }

                    this._reapplySearchHighlights();
                });
            });
        },

        _renderMarkdownContent(noteContent) {
            return renderMarkdownSync({
                noteContent,
                currentNote: this.currentNote,
                noteLookupByPath: this._noteLookup.byPath,
                noteLookupByPathLower: this._noteLookup.byPathLower,
                mediaLookup: this._mediaLookup,
                mediaLookupStem: this._mediaLookupStem,
                resolveWikiLink: this.resolveWikiLink.bind(this),
                resolveMediaWikilink: this.resolveMediaWikilink.bind(this),
                resolveMarkdownMediaPathForNote: this.resolveMarkdownMediaPathForNote.bind(this),
                encodeVaultRelativePathForMediaApi: this.encodeVaultRelativePathForMediaApi.bind(this),
                getMediaType: this.getMediaType.bind(this),
                typeIconSvg,
                escapeHtml: this.escapeHtml.bind(this),
            });
        },

        _scheduleDataviewQueries(blocks, source, notePath, generation) {
            if (this._dataviewQueryTimeout) clearTimeout(this._dataviewQueryTimeout);
            this._dataviewQueryTimeout = setTimeout(() => {
                this._dataviewQueryTimeout = null;
                this._resolveDataviewQueries(blocks, source, notePath, generation);
            }, DATAVIEW_QUERY_DEBOUNCE_MS);
        },

        async _resolveDataviewQueries(blocks, source, notePath, generation) {
            const replacements = blocks.length > MAX_DATAVIEW_QUERIES_PER_NOTE
                ? blocks.map(() => formatDataviewError(`Limite de ${MAX_DATAVIEW_QUERIES_PER_NOTE} consultas por nota.`))
                : await Promise.all(blocks.map(async ({ query }) => {
                    try {
                        const response = await api.sendJSON('/api/query', 'POST', { query });
                        return formatDataviewResult(response);
                    } catch (error) {
                        console.error('Basalt query failed:', error);
                        return formatDataviewError(error.detail || error.message || 'Falha ao executar consulta.');
                    }
                }));
            if (generation !== this._queryRenderGeneration || this.noteContent !== source || this.currentNote !== notePath) return;
            if (!this._dataviewResults) this._dataviewResults = Object.create(null);
            for (let i = 0; i < blocks.length; i++) {
                this._dataviewResults[blocks[i].query] = replacements[i];
            }
            const renderedSource = previewSourceWithDataviewResults(source, blocks, this._dataviewResults);
            this._cachedRenderedHTML = this._renderMarkdownContent(renderedSource);
            this._lastRenderedContent = source;
            this._lastRenderedNote = notePath;
            const previewGeneration = (this._previewRenderGeneration || 0) + 1;
            this._previewRenderGeneration = previewGeneration;
            this._scheduleSearchHighlightRefresh(previewGeneration);
            this.schedulePreviewPostProcessing();
        },

        // Schedules the async DOM work that must run after the HTML is in the DOM.
        // Separate from renderPreview() so it can be called independently if needed.
        schedulePreviewPostProcessing() {
            if (this._markmapDebounceTimeout) clearTimeout(this._markmapDebounceTimeout);
            if (isMarkmapNote(this.noteContent)) {
                this._markmapDebounceTimeout = setTimeout(
                    () => this.renderMarkmap(),
                    MARKMAP_RENDER_DEBOUNCE_MS
                );
                return;
            }

            // Debounced MathJax rendering (avoid re-running on every keystroke)
            if (this._mathDebounceTimeout) clearTimeout(this._mathDebounceTimeout);
            this._mathDebounceTimeout = setTimeout(() => this.typesetMath(), 300);

            // Debounced Mermaid rendering
            if (this._mermaidDebounceTimeout) clearTimeout(this._mermaidDebounceTimeout);
            this._mermaidDebounceTimeout = setTimeout(() => this.renderMermaid(), 300);

            this.schedulePreviewCodePostProcessing();
        },

        // Export current note as HTML via backend API
        async exportToHTML() {
            if (!this.currentNote || !this.noteContent) {
                this.toast(this.t('notes.no_content'), { type: 'info' });
                return;
            }
            
            try {
                // Build API URL with current theme
                const currentTheme = this.currentTheme || 'light';
                const encodedPath = encodeVaultPath(this.currentNote);
                const url = `/api/export/${encodedPath}?theme=${encodeURIComponent(currentTheme)}`;
                
                // Fetch the exported HTML from backend
                // Needs the raw response for Content-Disposition + blob().
                const response = await api.raw(url);
                if (!response.ok) {
                    const error = await response.json().catch(() => ({ detail: 'Export failed' }));
                    throw new Error(error.detail || 'Export failed');
                }
                
                // Get filename from Content-Disposition header or use note name
                let filename = (this.currentNoteName || 'note') + '.html';
                const contentDisposition = response.headers.get('Content-Disposition');
                if (contentDisposition) {
                    const match = contentDisposition.match(/filename="([^"]+)"/);
                    if (match) {
                        filename = match[1];
                    }
                }
                
                // Download as blob
                const blob = await response.blob();
                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                
                // Cleanup
                URL.revokeObjectURL(blobUrl);
                document.body.removeChild(a);
                
            } catch (error) {
                console.error('HTML export failed:', error);
                this.toast(this.t('export.failed', { error: error.message }), { type: 'error' });
            }
        },
        
        // Open print preview in new window
        printPreview() {
            if (!this.currentNote || !this.noteContent) {
                this.toast(this.t('notes.no_content'), { type: 'info' });
                return;
            }
            
            // Build API URL with current theme and download=false for inline display
            const currentTheme = this.currentTheme || 'light';
            const encodedPath = encodeVaultPath(this.currentNote);
            const url = `/api/export/${encodedPath}?theme=${encodeURIComponent(currentTheme)}&download=false`;
            
            // Open in new window/tab
            window.open(url, '_blank');
        },
    };
}
