import { isMarkmapNote } from '../lib/markmap-note.js';

export function createPreviewDiagrams() {
    return {
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
                        window.mermaidReady = null;
                        return null;
                    });
            }
            return window.mermaidReady;
        },

        async renderMermaid() {
            requestAnimationFrame(async () => {
                const previewContent = document.querySelector('.markdown-preview');
                if (!previewContent) return;

                const mermaidBlocks = previewContent.querySelectorAll('pre code.language-mermaid');
                if (mermaidBlocks.length === 0) return;

                if (!(await this.loadMermaid())) return;

                const mermaidTheme = this.getThemeType() === 'light' ? 'default' : 'dark';
                if (this.lastMermaidTheme !== mermaidTheme) {
                    window.mermaid.initialize({
                        startOnLoad: false,
                        theme: mermaidTheme,
                        securityLevel: 'strict',
                        fontFamily: 'inherit',
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
                    if (pre.querySelector('.mermaid-rendered')) continue;

                    try {
                        const code = block.textContent;
                        const id = `mermaid-diagram-${Date.now()}-${i}`;
                        const { svg } = await window.mermaid.render(id, code);

                        const container = document.createElement('div');
                        container.className = 'mermaid-rendered';
                        container.style.cssText = 'background-color: transparent; padding: 20px 0; width: 100%; text-align: center; overflow-x: auto;';
                        container.innerHTML = svg;
                        container.dataset.originalCode = code;
                        // Keep the source anchor when replacing the code block so scroll sync
                        // still has a landmark for the rendered diagram.
                        const anchorLine = pre.getAttribute('data-source-line');
                        if (anchorLine) container.setAttribute('data-source-line', anchorLine);

                        pre.parentElement.replaceChild(container, pre);
                    } catch (error) {
                        console.error('Mermaid rendering error:', error);
                        const errorMsg = document.createElement('div');
                        errorMsg.style.cssText = 'color: var(--error); padding: 10px; border-left: 3px solid var(--error); margin-top: 10px;';
                        errorMsg.textContent = `Mermaid diagram error: ${error.message}`;
                        pre.parentElement.insertBefore(errorMsg, pre.nextSibling);
                    }
                }
            });
        },

        getThemeType() {
            if (this.currentTheme === 'system') {
                const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
                return isDark ? 'dark' : 'light';
            }

            const currentThemeData = this.availableThemes.find(t => t.id === this.currentTheme);
            if (currentThemeData && currentThemeData.type) {
                return currentThemeData.type;
            }

            const fallbackMap = {
                'light': 'light',
                'vs-blue': 'light'
            };

            return fallbackMap[this.currentTheme] || 'dark';
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
    };
}
