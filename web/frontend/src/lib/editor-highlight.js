export function highlightMarkdownOverlay(text, { escapeHtml, highlighter }) {
    if (!text) return '';

    const codePlaceholders = [];
    const highlightedText = text.replace(
        /(^|\n)([ \t]{0,3})(`{3,})([^\n]*)\n([\s\S]*?)(?:\n([ \t]{0,3})(`{3,})[ \t]*(?=\n|$)|$)/g,
        (match, lineStart, indent, fence, info, code, closingIndent = '', closingFence = '') => {
            const language = info.trim().split(/\s+/, 1)[0].toLowerCase();
            const canHighlight = language
                && highlighter
                && highlighter.getLanguage(language);
            const codeHtml = canHighlight
                ? highlighter.highlight(code, { language, ignoreIllegals: true }).value
                : escapeHtml(code);
            const isQuery = language === 'query' || language === 'basalt-query';
            const className = isQuery
                ? 'md-queryblock'
                : (canHighlight ? 'md-codeblock hljs' : 'md-codeblock');
            const block = escapeHtml(`${indent}${fence}${info}\n`)
                + codeHtml
                + (closingFence ? `\n${escapeHtml(`${closingIndent}${closingFence}`)}` : '');
            codePlaceholders.push(`<span class="${className}">${block}</span>`);
            return `${lineStart}\x00CODE${codePlaceholders.length - 1}\x00`;
        }
    );

    let html = escapeHtml(highlightedText);
    if (html.startsWith('---\n')) {
        html = html.replace(/^(---\n[\s\S]*?\n---)/, (match) => {
            codePlaceholders.push(`<span class="md-frontmatter">${match}</span>`);
            return `\x00CODE${codePlaceholders.length - 1}\x00`;
        });
    }

    html = html.replace(/`([^`\n]+)`/g, (match) => {
        codePlaceholders.push(`<span class="md-code">${match}</span>`);
        return `\x00CODE${codePlaceholders.length - 1}\x00`;
    });
    html = html.replace(/^(#{1,6})(\s)(.*)$/gm, '<span class="md-heading">$1$2$3</span>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<span class="md-bold">**$1**</span>');
    html = html.replace(/__([^_]+)__/g, '<span class="md-bold">__$1__</span>');
    html = html.replace(/(?<![*\\])\*([^*\n]+)\*(?!\*)/g, '<span class="md-italic">*$1*</span>');
    html = html.replace(/(?<![_\\])_([^_\n]+)_(?!_)/g, '<span class="md-italic">_$1_</span>');
    html = html.replace(/\[\[([^\]]+)\]\]/g, '<span class="md-wikilink">[[$1]]</span>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="md-link">[$1]</span><span class="md-link-url">($2)</span>');
    html = html.replace(/^(\s*)([-*+])([ \t])(.*)$/gm, (match, indent, bullet, space, rest) =>
        `${indent}<span class="md-list">${bullet}</span>${space}${rest}`);
    html = html.replace(/^(\s*)(\d+\.)([ \t])(.*)$/gm, (match, indent, bullet, space, rest) =>
        `${indent}<span class="md-list">${bullet}</span>${space}${rest}`);
    html = html.replace(/^(&gt;.*)$/gm, '<span class="md-blockquote">$1</span>');
    html = html.replace(/^([-*_]{3,})$/gm, '<span class="md-hr">$1</span>');
    html = html.replace(/\x00CODE(\d+)\x00/g, (match, index) => codePlaceholders[parseInt(index)]);
    return `${html}\n `;
}
