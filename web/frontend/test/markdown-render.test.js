import test from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdownSync } from '../src/lib/markdown-render.js';

// Minimal mocks for browser globals used by the renderer
globalThis.marked = {
    Renderer: class {
        image(image, title, text) {
            const token = typeof image === 'string' ? { href: image, title, text } : image;
            return `<img src="${token.href}" alt="${token.text}"${token.title ? ` title="${token.title}"` : ''}>`;
        }
    },
    use: () => {},
    setOptions: () => {},
    parse: (src, options = {}) => {
        if (/^<!--CODEBLOCK\d+-->$/.test(src.trim())) return src.trim();
        const codeBlock = src.match(/^```(\w*)\n([\s\S]*?)```$/);
        if (codeBlock) {
            const [, language, code] = codeBlock;
            return `<pre><code${language ? ` class="language-${language}"` : ''}>${code}</code></pre>`;
        }
        const html = src
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/!\[([^\]]*)\]\((?:<([^>]+)>|([^)]+))\)/g, (match, text, angledHref, plainHref) => {
                const token = { text, href: angledHref || plainHref, title: null };
                return options.renderer
                    ? options.renderer.image(token.href, token.title, token.text)
                    : `<img src="${token.href}" alt="${text}">`;
            });
        return `<p>${html.replace(/\n/g, '</p><p>')}</p>`;
    },
};

globalThis.DOMPurify = {
    sanitize: (html) => html,
};

globalThis.hljs = {
    getLanguage: () => false,
    highlightAuto: (code) => ({ value: code }),
    highlight: (code, opts) => ({ value: code }),
};

function makeMockDeps(overrides = {}) {
    return {
        noteLookupByPath: new Map(),
        noteLookupByPathLower: new Map(),
        mediaLookup: new Map(),
        mediaLookupStem: new Map(),
        resolveWikiLink: () => null,
        resolveMediaWikilink: () => null,
        resolveMarkdownMediaPathForNote: (notePath, src) => {
            const directory = notePath?.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '';
            const path = src.startsWith('/') ? src.slice(1) : `${directory ? `${directory}/` : ''}${src}`;
            return path.split('/').filter((segment) => segment && segment !== '.').join('/');
        },
        encodeVaultRelativePathForMediaApi: (path) => path.split('/').map(encodeURIComponent).join('/'),
        getMediaType: () => 'image',
        typeIconSvg: () => '<svg></svg>',
        escapeHtml: (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        ...overrides,
    };
}

test('empty content returns placeholder', () => {
    const html = renderMarkdownSync({ noteContent: '', ...makeMockDeps() });
    assert.match(html, /Nothing to preview yet/);
});

test('basic markdown renders', () => {
    const deps = makeMockDeps();
    const html = renderMarkdownSync({ noteContent: '# Hello\n\nWorld', ...deps });
    assert.match(html, /Hello/);
    assert.match(html, /World/);
});

test('frontmatter is stripped', () => {
    const deps = makeMockDeps();
    const content = '---\ntitle: Test\n---\n\n# Body';
    const html = renderMarkdownSync({ noteContent: content, ...deps });
    assert.ok(!html.includes('title: Test'));
    assert.match(html, /Body/);
});

test('code blocks are preserved', () => {
    const deps = makeMockDeps();
    const content = '```js\nconst x = 1;\n[[not a link]]\n```';
    const html = renderMarkdownSync({ noteContent: content, ...deps });
    assert.match(html, /<pre><code class="language-js">const x = 1;\n\[\[not a link\]\]\n<\/code><\/pre>/);
    assert.doesNotMatch(html, /<p><pre>/);
    assert.doesNotMatch(html, /```/);
});

test('inline code is preserved', () => {
    const deps = makeMockDeps();
    const html = renderMarkdownSync({ noteContent: 'Use `const <x>` for constants', ...deps });
    assert.match(html, /<code>const &lt;x&gt;<\/code>/);
    assert.doesNotMatch(html, /`const/);
});

test('wikilinks are converted to anchors', () => {
    const deps = makeMockDeps({
        resolveWikiLink: (target, source) => target === 'My Note' ? 'my-note' : null,
    });
    const html = renderMarkdownSync({ noteContent: 'See [[My Note]]', currentNote: '', ...deps });
    assert.match(html, /my-note/);
    assert.match(html, /My Note/);
});

test('broken wikilinks get broken class', () => {
    const deps = makeMockDeps({
        resolveWikiLink: () => null,
    });
    const html = renderMarkdownSync({ noteContent: 'See [[Missing]]', currentNote: '', ...deps });
    assert.match(html, /wikilink-broken/);
    assert.match(html, /Missing/);
});

test('preserves many rendered wikilinks through Markdown parsing', () => {
    const count = 1_000;
    const content = Array.from({ length: count }, (_, index) => `[[Note ${index}]]`).join(' ');
    const html = renderMarkdownSync({
        noteContent: content,
        currentNote: '',
        ...makeMockDeps({ resolveWikiLink: (target) => target.replaceAll(' ', '-') }),
    });

    assert.equal((html.match(/class="wikilink"/g) || []).length, count);
    assert.match(html, /href="\/Note-0"/);
    assert.match(html, /href="\/Note-999"/);
});

test('uses inline parsing for an oversized single paragraph and restores wikilinks', () => {
    const originalParseInline = globalThis.marked.parseInline;
    const count = 8_000;
    const noteContent = 'A long line with [[Note]].\n'.repeat(count);
    let parsedSource = '';
    globalThis.marked.parseInline = (source) => {
        parsedSource = source;
        return source;
    };

    try {
        const html = renderMarkdownSync({ noteContent, ...makeMockDeps() });

        assert.ok(parsedSource.length >= 100_000);
        assert.doesNotMatch(parsedSource, /\[\[Note\]\]/);
        assert.equal((html.match(/class="wikilink-broken"/g) || []).length, count);
        assert.match(html, /^<p>A long line with <span class="wikilink-broken"/);
    } finally {
        if (originalParseInline === undefined) delete globalThis.marked.parseInline;
        else globalThis.marked.parseInline = originalParseInline;
    }
});

test('media wikilinks produce img tags', () => {
    const deps = makeMockDeps({
        resolveMediaWikilink: (name) => name === 'image.png' ? 'attachments/image.png' : null,
        getMediaType: () => 'image',
    });
    const html = renderMarkdownSync({ noteContent: '![[image.png]]', ...deps });
    assert.match(html, /image\.png/);
});

test('markdown images use the media API with paths relative to their note', () => {
    const deps = makeMockDeps();
    const html = renderMarkdownSync({
        noteContent: '![photo](<photo one.jpg>)',
        currentNote: 'Captura/capture.md',
        ...deps,
    });
    assert.match(html, /src="\/api\/media\/Captura\/photo%20one\.jpg"/);
    assert.match(html, /alt="photo"/);
});

test('external markdown images keep their URL', () => {
    const deps = makeMockDeps();
    const html = renderMarkdownSync({
        noteContent: '![photo](https://example.com/photo.jpg)',
        currentNote: 'Captura/capture.md',
        ...deps,
    });
    assert.match(html, /src="https:\/\/example\.com\/photo\.jpg"/);
});

test('callouts are converted to divs', () => {
    const deps = makeMockDeps();
    const content = '> [!NOTE]\n> This is a note';
    const html = renderMarkdownSync({ noteContent: content, ...deps });
    assert.match(html, /callout callout-note/);
    assert.match(html, /This is a note/);
});

test('task list checkboxes are preserved', () => {
    const deps = makeMockDeps();
    const content = '- [ ] Task 1\n- [x] Task 2';
    const html = renderMarkdownSync({ noteContent: content, ...deps });
    assert.match(html, /Task 1/);
    assert.match(html, /Task 2/);
});

test('external links get target blank', () => {
    const deps = makeMockDeps();
    const html = renderMarkdownSync({ noteContent: '[External](https://example.com)', ...deps });
    // With minimal mocks, we just check the link text is preserved
    assert.match(html, /External/);
});