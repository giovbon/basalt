import { loadHighlightJs } from '../lib/highlight.js';

export function createPreviewCode() {
    return {
        schedulePreviewCodePostProcessing() {
            setTimeout(() => {
                const previewEl = this._domCache.previewContent || document.querySelector('.markdown-preview');
                if (!previewEl) return;

                const codeBlocks = [...previewEl.querySelectorAll('pre code:not(.language-mermaid)')];
                codeBlocks.forEach((block) => {
                    const pre = block.parentElement;
                    if (pre && !pre.querySelector('.copy-code-button')) {
                        this.addCopyButtonToCodeBlock(pre);
                    }
                });
                if (codeBlocks.length) {
                    loadHighlightJs().then((highlighter) => {
                        codeBlocks.forEach((block) => {
                            if (block.isConnected && !block.classList.contains('hljs')) {
                                highlighter.highlightElement(block);
                            }
                        });
                        if (this.currentSearchHighlight) this._reapplySearchHighlights();
                    }).catch((error) => {
                        console.error('Highlight.js failed to load:', error);
                    });
                }

                if (!this._initializedVideoSources) this._initializedVideoSources = new Set();
                previewEl.querySelectorAll('video[preload="none"]').forEach((video) => {
                    const src = video.getAttribute('src');
                    if (src && !this._initializedVideoSources.has(src)) {
                        this._initializedVideoSources.add(src);
                        video.preload = 'metadata';
                    }
                });
            }, 0);
        },

        addCopyButtonToCodeBlock(preElement) {
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

            const button = document.createElement('button');
            button.className = 'copy-code-button';
            const displayText = language || this.t('common.copy_to_clipboard').split(' ')[0];
            button.innerHTML = `<span>${displayText}</span>`;
            button.dataset.originalText = displayText;
            button.title = this.t('common.copy_to_clipboard');

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

            preElement.style.position = 'relative';
            preElement.addEventListener('mouseenter', () => {
                button.style.opacity = '1';
            });
            preElement.addEventListener('mouseleave', () => {
                button.style.opacity = '0';
            });

            button.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();

                const code = preElement.querySelector('code')?.textContent;
                if (code == null) return;

                const originalText = button.dataset.originalText;
                const copiedText = this.t('common.copied');
                const copyTitle = this.t('common.copy_to_clipboard');

                try {
                    await navigator.clipboard.writeText(code);
                    button.innerHTML = `<span>${copiedText}</span>`;
                    button.style.backgroundColor = 'rgba(34, 197, 94, 0.8)';
                    button.title = copiedText;
                    setTimeout(() => {
                        button.innerHTML = `<span>${originalText}</span>`;
                        button.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
                        button.title = copyTitle;
                    }, 2000);
                } catch (err) {
                    console.error('Failed to copy code:', err);

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

            preElement.appendChild(button);
        },
    };
}
