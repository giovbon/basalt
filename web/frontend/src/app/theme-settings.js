// Theme loading and application for the Alpine root.
//
// Kept as a separate feature slice so bootstrap.js can focus on startup order.

import * as api from '../core/api.js';
import { saveSetting } from '../core/settings.js';

export function createThemeSettings() {
    return {
        async loadThemes() {
            try {
                const data = await api.getJSON('/api/themes');

                // Theme names are plain text; the optional icon field is not
                // rendered in the select because a native <option> cannot hold SVG.
                this.availableThemes = data.themes;
            } catch (error) {
                console.error('Failed to load themes:', error);
                this.availableThemes = [
                    { id: 'light', name: 'Light' },
                    { id: 'dark', name: 'Dark' }
                ];
            }
        },

        async initTheme() {
            const savedTheme = localStorage.getItem('noteDiscoveryTheme') || this.defaultTheme;
            this.currentTheme = savedTheme;
            await this.applyTheme(savedTheme);
        },

        async setTheme(themeId) {
            this.currentTheme = themeId;
            saveSetting('noteDiscoveryTheme', themeId);
            await this.applyTheme(themeId);
        },

        async applyTheme(themeId) {
            // The blocking stylesheet in index.html handles first paint. Runtime
            // changes retarget it; the style-element fallback supports other pages.
            try {
                const link = document.getElementById('theme-stylesheet');
                const styleEl = document.getElementById('dynamic-theme');
                const alreadyLoaded =
                    document.documentElement.getAttribute('data-theme') === themeId &&
                    (link !== null || (styleEl !== null && styleEl.textContent));

                if (!alreadyLoaded) {
                    if (link) {
                        link.href = '/api/themes/' + encodeURIComponent(themeId);
                        document.documentElement.setAttribute('data-theme', themeId);
                    } else {
                        const body = await api.getText(`/api/themes/${themeId}`);
                        let css = body;
                        try {
                            css = JSON.parse(body).css;
                        } catch (_) {
                            // Raw CSS response; keep the body as-is.
                        }

                        let el = styleEl;
                        if (!el) {
                            el = document.createElement('style');
                            el.id = 'dynamic-theme';
                            document.head.appendChild(el);
                        }
                        el.textContent = css;
                        document.documentElement.setAttribute('data-theme', themeId);
                    }
                }

                const highlightTheme = document.getElementById('highlight-theme');
                if (highlightTheme) {
                    highlightTheme.href = themeId === 'light'
                        ? '/static/vendor/highlight.js/styles/github.min.css'
                        : '/static/vendor/highlight.js/styles/github-dark.min.css';
                }

                if (this.currentNote) {
                    setTimeout(() => {
                        const previewContent = document.querySelector('.markdown-preview');
                        if (previewContent) {
                            const mermaidContainers = previewContent.querySelectorAll('.mermaid-rendered');
                            mermaidContainers.forEach(container => {
                                const parent = container.parentElement;
                                if (parent && container.dataset.originalCode) {
                                    const pre = document.createElement('pre');
                                    const code = document.createElement('code');
                                    code.className = 'language-mermaid';
                                    code.textContent = container.dataset.originalCode;
                                    pre.appendChild(code);
                                    parent.replaceChild(pre, container);
                                }
                            });
                        }
                        this.renderMermaid();
                    }, 100);
                }

                if (this.showGraph) {
                    setTimeout(() => this.initGraph(), 300);
                }

                const themeColorMeta = document.querySelector('meta[name="theme-color"]');
                if (themeColorMeta) {
                    const accentColor = getComputedStyle(document.documentElement)
                        .getPropertyValue('--accent-primary').trim() || '#7c3aed';
                    themeColorMeta.setAttribute('content', accentColor);
                }
            } catch (error) {
                console.error('Failed to load theme:', error);
            }
        },
    };
}
