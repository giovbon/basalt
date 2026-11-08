// Markdown preview rendering, math, mermaid and code blocks.
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import * as api from '../core/api.js';
import { encodeVaultPath } from '../core/utils.js';
import { renderMarkdownSync } from '../lib/markdown-render.js';
import { isMarkmapNote } from '../lib/markmap-note.js';
import { scanTaskLines, toggleTaskAt, setAllTasks } from '../lib/tasks.js';
import { typeIconSvg } from '../lib/file-icons.js';

const MARKMAP_RENDER_DEBOUNCE_MS = 500;

export function createPreview() {
    return {
        
        // Highlight markdown syntax
        highlightMarkdown(text) {
            if (!text) return '';
            
            // Store code blocks and inline code with placeholders to protect from other patterns
            const codePlaceholders = [];
            
            // Highlight fenced code before escaping surrounding Markdown. The
            // overlay must retain the textarea's exact visible text so token
            // colors never shift the caret or selection.
            const highlighter = globalThis.hljs;
            const highlightedText = text.replace(
                /(^|\n)([ \t]{0,3})(`{3,})([^\n]*)\n([\s\S]*?)(?:\n([ \t]{0,3})(`{3,})[ \t]*(?=\n|$)|$)/g,
                (match, lineStart, indent, fence, info, code, closingIndent = '', closingFence = '') => {
                    const language = info.trim().split(/\s+/, 1)[0].toLowerCase();
                    const canHighlight = language
                        && highlighter
                        && highlighter.getLanguage(language);
                    const codeHtml = canHighlight
                        ? highlighter.highlight(code, { language, ignoreIllegals: true }).value
                        : this.escapeHtml(code);
                    const className = canHighlight ? 'md-codeblock hljs' : 'md-codeblock';
                    const block = this.escapeHtml(`${indent}${fence}${info}\n`)
                        + codeHtml
                        + (closingFence ? `\n${this.escapeHtml(`${closingIndent}${closingFence}`)}` : '');
                    codePlaceholders.push(`<span class="${className}">${block}</span>`);
                    return `${lineStart}\x00CODE${codePlaceholders.length - 1}\x00`;
                }
            );

            // Escape HTML after code blocks are safely protected.
            let html = this.escapeHtml(highlightedText);
            
            // Frontmatter (must be at VERY start of document, not any line)
            if (html.startsWith('---\n')) {
                html = html.replace(/^(---\n[\s\S]*?\n---)/, (match) => {
                    codePlaceholders.push('<span class="md-frontmatter">' + match + '</span>');
                    return `\x00CODE${codePlaceholders.length - 1}\x00`;
                });
            }
            
            // Inline code - protect it
            html = html.replace(/`([^`\n]+)`/g, (match) => {
                codePlaceholders.push('<span class="md-code">' + match + '</span>');
                return `\x00CODE${codePlaceholders.length - 1}\x00`;
            });
            
            // Now apply other patterns (they won't match inside protected code)
            
            // Headings - capture the whitespace to preserve exact characters (tabs vs spaces)
            // This prevents cursor/selection misalignment
            html = html.replace(/^(#{1,6})(\s)(.*)$/gm, '<span class="md-heading">$1$2$3</span>');
            
            // Bold (must come before italic)
            html = html.replace(/\*\*([^*]+)\*\*/g, '<span class="md-bold">**$1**</span>');
            html = html.replace(/__([^_]+)__/g, '<span class="md-bold">__$1__</span>');
            
            // Italic
            html = html.replace(/(?<![*\\])\*([^*\n]+)\*(?!\*)/g, '<span class="md-italic">*$1*</span>');
            html = html.replace(/(?<![_\\])_([^_\n]+)_(?!_)/g, '<span class="md-italic">_$1_</span>');
            
            // Wikilinks [[...]]
            html = html.replace(/\[\[([^\]]+)\]\]/g, '<span class="md-wikilink">[[$1]]</span>');
            
            // Links [text](url)
            html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="md-link">[$1]</span><span class="md-link-url">($2)</span>');
            
            // Lists - use ([ \t]) to capture the space/tab and preserve exact characters
            // IMPORTANT: Don't add any characters (like \u200B) that aren't in the original,
            // as this breaks cursor/selection alignment between textarea and overlay
            html = html.replace(/^(\s*)([-*+])([ \t])(.*)$/gm, (match, indent, bullet, space, rest) => {
                return `${indent}<span class="md-list">${bullet}</span>${space}${rest}`;
            });
            html = html.replace(/^(\s*)(\d+\.)([ \t])(.*)$/gm, (match, indent, bullet, space, rest) => {
                return `${indent}<span class="md-list">${bullet}</span>${space}${rest}`;
            });
            
            // Blockquotes
            html = html.replace(/^(&gt;.*)$/gm, '<span class="md-blockquote">$1</span>');
            
            // Horizontal rules
            html = html.replace(/^([-*_]{3,})$/gm, '<span class="md-hr">$1</span>');
            
            // Restore protected code blocks
            html = html.replace(/\x00CODE(\d+)\x00/g, (match, index) => codePlaceholders[parseInt(index)]);
            
            // Add trailing space to match textarea's phantom line for cursor
            // This ensures the overlay and textarea have the same content height
            html += '\n ';
            
            return html;
        },
        
        // Single click entry point for the preview pane.
        handlePreviewClick(event) {
            if (this.toggleTaskFromPreview(event)) return;
            this.handleInternalLink(event);
        },

        /**
         * The checkbox a click should toggle: the box itself, or the one belonging to
         * the task item whose text was clicked. Returns null when the click was meant
         * for something else — following a link, playing a video, selecting text.
         */
        _taskBoxForClick(event) {
            const target = event.target;
            if (!target || !target.closest) return null;

            if (target.tagName === 'INPUT' && target.type === 'checkbox') return target;

            // Anything with its own click behaviour, plus code blocks, which people
            // click to read and copy rather than to tick something off.
            if (target.closest('a, img, video, audio, iframe, pre, button, label, summary')) return null;

            // detail > 1 is the second half of a double-click, which is someone
            // selecting a word rather than aiming at the item.
            if (event.detail !== 1) return null;
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed) return null;

            const item = target.closest('li');
            if (!item) return null;

            // First box in document order belongs to this item unless it sits in a
            // nested one, which is the case when a plain bullet has task children.
            const box = item.querySelector('input[type="checkbox"][data-task-index]');
            return box && box.closest('li') === item ? box : null;
        },

        /**
         * Every task in the note to the opposite of the clicked one, so ticking one box
         * off a mixed list ticks the rest. A single assignment, so one Ctrl+Z undoes it.
         *
         * The change touches many lines at once, which the single-shot replace
         * endpoint cannot express, so it goes through the regular (debounced,
         * conflict-checked) whole-note save.
         */
        _toggleAllTasksFromPreview(box) {
            const index = parseInt(box.getAttribute('data-task-index'), 10);
            if (!Number.isInteger(index)) return false;

            const result = setAllTasks(this.noteContent, index);
            if (!result.found) return false;
            if (!result.changed) return true;

            this.noteContent = result.text;
            this.autoSave();
            this.toast(
                this.t(result.nextState === 'x' ? 'editor.tasks_all_checked' : 'editor.tasks_all_unchecked',
                    { changed: result.changeCount, total: result.total })
            );
            return true;
        },

        /**
         * Persist a single toggled task line through /api/notes/replace: the
         * endpoint patches exactly that line against the on-disk content, so a
         * click never overwrites edits made elsewhere (another editor, a sync
         * tool) the way a whole-note save would. Falls back to the regular
         * save when the line is not unique in the note (the endpoint answers
         * 409) or the request fails.
         */
        async _persistTaskToggle(oldLine, newLine) {
            try {
                const response = await api.raw('/api/notes/replace', {
                    method: 'POST',
                    json: { path: this.currentNote, old_str: oldLine, new_str: newLine }
                });
                if (!response.ok) {
                    this.autoSave();
                    return;
                }
                const result = await response.json();
                // The patched line is now the disk state the next whole-note
                // save is compared against.
                this.noteBaseHash = result.hash || null;
                this.lastSaved = true;
            } catch (error) {
                console.error('Failed to replace task line:', error);
                this.autoSave();
            }
        },

        /** Tick/untick the clicked task item in the source. True when it was a task. */
        toggleTaskFromPreview(event) {
            const box = this._taskBoxForClick(event);
            if (!box) return false;

            // Ctrl (Cmd on a Mac) applies the change to every task in the note. Ctrl
            // leaves the text selection alone, unlike Shift, so the guards in
            // _taskBoxForClick hold for the box and the item text alike.
            if (event.ctrlKey || event.metaKey) return this._toggleAllTasksFromPreview(box);

            const index = parseInt(box.getAttribute('data-task-index'), 10);
            if (!Number.isInteger(index)) return false;

            // Rescanned per click: the note can change between render and click.
            const result = toggleTaskAt(this.noteContent, index);
            if (!result.changed) return false;

            this.noteContent = result.text;
            if (!this.isUndoRedo) this.pushToHistory();
            this.lastSaved = false;
            this._persistTaskToggle(result.oldLine, result.newLine);
            return true;
        },
        
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
                        MathJax.typesetPromise([previewContent]).catch((err) => {
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
        
        /**
         * Mermaid's core is ~650 KB across two dozen chunks, so it is fetched on first
         * use rather than at page load: most notes contain no diagrams. Diagram types
         * then load on demand from ./chunks/ next to the module.
         */
        loadMermaid() {
            if (!window.mermaidReady) {
                window.mermaidReady = import('/static/vendor/mermaid/mermaid.esm.min.mjs')
                    .then((module) => (window.mermaid = module.default))
                    .catch((error) => {
                        console.error('Mermaid failed to load:', error);
                        window.mermaidReady = null; // let the next diagram retry
                        return null;
                    });
            }
            return window.mermaidReady;
        },
        
        // Render Mermaid diagrams
        async renderMermaid() {
            // Use requestAnimationFrame for better performance than setTimeout
            requestAnimationFrame(async () => {
                const previewContent = document.querySelector('.markdown-preview');
                if (!previewContent) return;
                
                // Find all code blocks with language 'mermaid'
                const mermaidBlocks = previewContent.querySelectorAll('pre code.language-mermaid');
                
                // Early return if no diagrams to render, before paying for the library
                if (mermaidBlocks.length === 0) return;
                
                if (!(await this.loadMermaid())) return;
                
                // Get the appropriate theme based on current app theme
                const themeType = this.getThemeType();
                const mermaidTheme = themeType === 'light' ? 'default' : 'dark';
                
                // Only reinitialize if theme changed (performance optimization)
                if (this.lastMermaidTheme !== mermaidTheme) {
                    window.mermaid.initialize({ 
                        startOnLoad: false,
                        theme: mermaidTheme,
                        securityLevel: 'strict', // Use strict for better security
                        fontFamily: 'inherit',
                        // v11 changed useMaxWidth defaults - restore responsive behavior
                        flowchart: { useMaxWidth: true },
                        sequence: { useMaxWidth: true },
                        gantt: { useMaxWidth: true },
                        journey: { useMaxWidth: true },
                        timeline: { useMaxWidth: true },
                        class: { useMaxWidth: true },
                        state: { useMaxWidth: true },
                        er: { useMaxWidth: true },
                        pie: { useMaxWidth: true },
                        quadrantChart: { useMaxWidth: true },
                        requirement: { useMaxWidth: true },
                        mindmap: { useMaxWidth: true },
                        gitGraph: { useMaxWidth: true }
                    });
                    this.lastMermaidTheme = mermaidTheme;
                }
                
                for (let i = 0; i < mermaidBlocks.length; i++) {
                    const block = mermaidBlocks[i];
                    const pre = block.parentElement;
                    
                    // Skip if already rendered (performance optimization)
                    if (pre.querySelector('.mermaid-rendered')) continue;
                    
                    try {
                        const code = block.textContent;
                        const id = `mermaid-diagram-${Date.now()}-${i}`;
                        
                        // Render the diagram
                        const { svg } = await window.mermaid.render(id, code);
                        
                        // Create a container for the rendered diagram
                        const container = document.createElement('div');
                        container.className = 'mermaid-rendered';
                        container.style.cssText = 'background-color: transparent; padding: 20px 0; width: 100%; text-align: center; overflow-x: auto;';
                        container.innerHTML = svg;
                        // Store original code for theme re-rendering
                        container.dataset.originalCode = code;
                        // Preserve scroll-sync anchor if the code block was tagged
                        // by _annotateSourceAnchors. Without this the rendered
                        // diagram becomes invisible to _getScrollAnchors and any
                        // fence landmarks that got replaced disappear.
                        const anchorLine = pre.getAttribute('data-source-line');
                        if (anchorLine) container.setAttribute('data-source-line', anchorLine);
                        
                        // Replace the code block with the rendered diagram
                        pre.parentElement.replaceChild(container, pre);
                    } catch (error) {
                        console.error('Mermaid rendering error:', error);
                        // Add error indicator to the code block
                        const errorMsg = document.createElement('div');
                        errorMsg.style.cssText = 'color: var(--error); padding: 10px; border-left: 3px solid var(--error); margin-top: 10px;';
                        errorMsg.textContent = `Mermaid diagram error: ${error.message}`;
                        pre.parentElement.insertBefore(errorMsg, pre.nextSibling);
                    }
                }
            });
        },
        
        // Get current theme type (light or dark)
        // Returns: 'light' or 'dark'
        // Used by features that need to adapt to theme brightness (e.g., Mermaid diagrams, Chart.js)
        getThemeType() {
            // Handle system theme
            if (this.currentTheme === 'system') {
                const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
                return isDark ? 'dark' : 'light';
            }
            
            // Try to get theme type from loaded theme metadata
            const currentThemeData = this.availableThemes.find(t => t.id === this.currentTheme);
            if (currentThemeData && currentThemeData.type) {
                // Use metadata from theme file (light or dark)
                return currentThemeData.type; // Already 'light' or 'dark'
            }
            
            // Backward compatibility: fallback to hardcoded map if metadata not available
            const fallbackMap = {
                'light': 'light',
                'vs-blue': 'light'
            };
            
            return fallbackMap[this.currentTheme] || 'dark';
        },
        
        
        // Computed property for rendered markdown
        
        // Rendered markdown HTML for the preview pane. This is a cached value
        // updated by renderPreview(); the getter just returns it (or a placeholder).
        get renderedMarkdown() {
            return this._cachedRenderedHTML || '<p style="color: var(--text-tertiary);">Nothing to preview yet...</p>';
        },

        // Synchronous markdown rendering + DOM post-processing setup.
        // Call this when noteContent or currentNote changes.
        renderPreview() {
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
            const html = renderMarkdownSync({
                noteContent: this.noteContent,
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

            // Cache immediately so the getter returns the new content
            this._cachedRenderedHTML = html;
            this._lastRenderedContent = this.noteContent;
            this._lastRenderedNote = this.currentNote;

            // Schedule async post-processing (MathJax, Mermaid, syntax highlighting, video)
            this.schedulePreviewPostProcessing();

            return html;
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

            // Apply syntax highlighting and add copy buttons to code blocks
            setTimeout(() => {
                const previewEl = this._domCache.previewContent || document.querySelector('.markdown-preview');
                if (previewEl) {
                    previewEl.querySelectorAll('pre code:not(.language-mermaid)').forEach((block) => {
                        if (!block.classList.contains('hljs')) {
                            hljs.highlightElement(block);
                        }
                        const pre = block.parentElement;
                        if (pre && !pre.querySelector('.copy-code-button')) {
                            this.addCopyButtonToCodeBlock(pre);
                        }
                    });

                    if (!this._initializedVideoSources) this._initializedVideoSources = new Set();
                    previewEl.querySelectorAll('video[preload="none"]').forEach((video) => {
                        const src = video.getAttribute('src');
                        if (src && !this._initializedVideoSources.has(src)) {
                            this._initializedVideoSources.add(src);
                            video.preload = 'metadata';
                        }
                    });
                }
            }, 0);
        },

        loadMarkmap() {
            if (!this._markmapLoadPromise) {
                this._markmapLoadPromise = import('/static/vendor/markmap/markmap.js')
                    .catch((error) => {
                        console.error('Markmap failed to load:', error);
                        this._markmapLoadPromise = null;
                        throw error;
                    });
            }
            return this._markmapLoadPromise;
        },

        clearMarkmap() {
            this._markmapRenderVersion++;
            if (this._markmapDebounceTimeout) clearTimeout(this._markmapDebounceTimeout);
            this._markmapInstance?.destroy();
            this._markmapInstance = null;
            this._markmapSvg = null;
        },

        fitMarkmap() {
            if (!this._markmapInstance || !this._markmapSvg?.isConnected) return;
            this.updateMarkmapTheme(this._markmapSvg);
            this._markmapInstance.fit().catch((error) => {
                console.error('Markmap resize failed:', error);
            });
        },

        updateMarkmapTheme(svg) {
            if (!svg?.isConnected) return;
            const container = svg.closest('.markmap-container');
            if (container) container.classList.toggle('markmap-dark', this.getThemeType() === 'dark');
        },

        async renderMarkmap() {
            const previewEl = this._domCache.previewContent || document.querySelector('.markdown-preview');
            const svg = previewEl && previewEl.querySelector('.markmap-svg');
            if (!svg || !isMarkmapNote(this.noteContent)) return;

            const content = this.noteContent;
            const renderVersion = ++this._markmapRenderVersion;
            try {
                const { renderMarkmap } = await this.loadMarkmap();
                if (!svg.isConnected || renderVersion !== this._markmapRenderVersion || this.noteContent !== content) return;
                this.updateMarkmapTheme(svg);

                if (this._markmapSvg !== svg) {
                    this._markmapInstance?.destroy();
                    this._markmapInstance = null;
                    this._markmapSvg = svg;
                }
                this._markmapInstance = await renderMarkmap(svg, content, this._markmapInstance);
            } catch (error) {
                console.error('Markmap rendering failed:', error);
                if (svg.isConnected && renderVersion === this._markmapRenderVersion && this.noteContent === content) {
                    const message = document.createElement('p');
                    message.className = 'markmap-error';
                    message.textContent = `Não foi possível renderizar o mapa mental: ${error.message}`;
                    svg.replaceWith(message);
                }
            }
        },
        
        // Add copy button to code block
        addCopyButtonToCodeBlock(preElement) {
            // Extract language from code element class (e.g., "language-toml" -> "TOML")
            const codeElement = preElement.querySelector('code');
            let language = '';
            if (codeElement && codeElement.className) {
                const match = codeElement.className.match(/language-(\w+)/);
                if (match) {
                    const langMap = {
                        'js': 'JavaScript', 'ts': 'TypeScript', 'py': 'Python',
                        'rb': 'Ruby', 'cs': 'C#', 'cpp': 'C++', 'sh': 'Shell',
                        'bash': 'Bash', 'zsh': 'Zsh', 'yml': 'YAML', 'md': 'Markdown'
                    };
                    const rawLang = match[1].toLowerCase();
                    language = langMap[rawLang] || match[1].toUpperCase();
                }
            }
            
            // Create copy button with language label
            const button = document.createElement('button');
            button.className = 'copy-code-button';
            const displayText = language || this.t('common.copy_to_clipboard').split(' ')[0]; // Use first word as fallback
            button.innerHTML = `<span>${displayText}</span>`;
            button.dataset.originalText = displayText; // Store for restore after copy
            button.title = this.t('common.copy_to_clipboard');
            
            // Style the button
            button.style.position = 'absolute';
            button.style.top = '8px';
            button.style.right = '8px';
            button.style.padding = '4px 10px';
            button.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
            button.style.border = 'none';
            button.style.borderRadius = '4px';
            button.style.cursor = 'pointer';
            button.style.opacity = '0';
            button.style.transition = 'opacity 0.2s, background-color 0.2s';
            button.style.color = 'white';
            button.style.display = 'flex';
            button.style.alignItems = 'center';
            button.style.justifyContent = 'center';
            button.style.zIndex = '10';
            button.style.fontSize = '11px';
            button.style.fontWeight = '600';
            button.style.fontFamily = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
            button.style.textTransform = 'uppercase';
            button.style.letterSpacing = '0.5px';
            
            // Style the pre element to be relative
            preElement.style.position = 'relative';
            
            // Show button on hover
            preElement.addEventListener('mouseenter', () => {
                button.style.opacity = '1';
            });
            
            preElement.addEventListener('mouseleave', () => {
                button.style.opacity = '0';
            });
            
            // Copy to clipboard on click
            button.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                const codeElement = preElement.querySelector('code');
                if (!codeElement) return;
                
                const code = codeElement.textContent;
                
                const originalText = button.dataset.originalText;
                const copiedText = this.t('common.copied');
                const copyTitle = this.t('common.copy_to_clipboard');
                
                try {
                    await navigator.clipboard.writeText(code);
                    
                    // Visual feedback - show localized "Copied!"
                    button.innerHTML = `<span>${copiedText}</span>`;
                    button.style.backgroundColor = 'rgba(34, 197, 94, 0.8)';
                    button.title = copiedText;
                    
                    // Reset after 2 seconds
                    setTimeout(() => {
                        button.innerHTML = `<span>${originalText}</span>`;
                        button.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
                        button.title = copyTitle;
                    }, 2000);
                } catch (err) {
                    console.error('Failed to copy code:', err);
                    
                    // Fallback for older browsers
                    const textArea = document.createElement('textarea');
                    textArea.value = code;
                    textArea.style.position = 'fixed';
                    textArea.style.left = '-999999px';
                    document.body.appendChild(textArea);
                    textArea.select();
                    
                    try {
                        document.execCommand('copy');
                        button.innerHTML = `<span>${copiedText}</span>`;
                        button.style.backgroundColor = 'rgba(34, 197, 94, 0.8)';
                        setTimeout(() => {
                            button.innerHTML = `<span>${originalText}</span>`;
                            button.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
                        }, 2000);
                    } catch (fallbackErr) {
                        console.error('Fallback copy failed:', fallbackErr);
                    }
                    
                    document.body.removeChild(textArea);
                }
            });
            
            // Add button to pre element
            preElement.appendChild(button);
        },
        
        /**
         * Source line of every task item, in document order. Frontmatter and fenced
         * code are skipped since neither renders a checkbox. Callers pair these with the
         * rendered boxes only when the counts match, which is safe as long as this can
         * over-count but never under-count: a miss here could cancel out a spare and
         * pass that check with everything shifted by one.
         */
        _scanTaskLines(source) {
            return scanTaskLines(source);
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
