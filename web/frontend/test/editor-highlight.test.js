import test from 'node:test';
import assert from 'node:assert/strict';

import { createEditor } from '../src/app/editor.js';

const escapeHtml = (text) => text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function visibleText(html) {
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

function withHighlighter(highlighter, run) {
    const original = globalThis.hljs;
    globalThis.hljs = highlighter;
    try {
        run();
    } finally {
        if (original === undefined) delete globalThis.hljs;
        else globalThis.hljs = original;
    }
}

function makeEditor() {
    return Object.assign(createEditor(), { escapeHtml });
}

test('highlights supported fenced languages while preserving overlay text', () => {
    const calls = [];
    withHighlighter({
        getLanguage: (language) => language === 'js',
        highlight(code, options) {
            calls.push(options);
            return { value: `<span class="hljs-keyword">${escapeHtml(code)}</span>` };
        },
    }, () => {
        const source = '```js\nconst value = "<tag>";\n```';
        const html = makeEditor().highlightMarkdown(source);

        assert.deepEqual(calls, [{ language: 'js', ignoreIllegals: true }]);
        assert.match(html, /class="md-codeblock hljs"/);
        assert.match(html, /class="hljs-keyword"/);
        assert.equal(visibleText(html), `${source}\n `);
    });
});

test('leaves unknown-language blocks unhighlighted and safely escaped', () => {
    withHighlighter({
        getLanguage: () => false,
        highlight() {
            assert.fail('unknown languages must not be sent to the highlighter');
        },
    }, () => {
        const source = '```made-up\n<script>alert(1)</script>\n```';
        const html = makeEditor().highlightMarkdown(source);

        assert.match(html, /class="md-codeblock"/);
        assert.doesNotMatch(html, /class="md-codeblock hljs"/);
        assert.match(html, /&lt;script&gt;/);
        assert.equal(visibleText(html), `${source}\n `);
    });
});

test('highlights an unfinished code fence without applying Markdown formatting', () => {
    withHighlighter({
        getLanguage: () => true,
        highlight: (code) => ({ value: escapeHtml(code) }),
    }, () => {
        const source = '```js\n**not bold**';
        const html = makeEditor().highlightMarkdown(source);

        assert.match(html, /class="md-codeblock hljs"/);
        assert.doesNotMatch(html, /class="md-bold"/);
        assert.equal(visibleText(html), `${source}\n `);
    });
});
