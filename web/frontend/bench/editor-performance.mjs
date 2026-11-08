import '../vendor/marked/marked.min.js';
import { renderMarkdownSync } from '../src/lib/markdown-render.js';

const escapeHtml = (text) => text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const rendererOptions = {
    currentNote: 'performance-test.md',
    noteLookupByPath: new Map(),
    noteLookupByPathLower: new Map(),
    mediaLookup: new Map(),
    mediaLookupStem: new Map(),
    resolveWikiLink: () => null,
    resolveMediaWikilink: () => null,
    resolveMarkdownMediaPathForNote: () => null,
    encodeVaultRelativePathForMediaApi: () => '',
    getMediaType: () => null,
    typeIconSvg: () => '',
    escapeHtml,
};

const noteLine = 'A representative note line with **bold** text, [[a link]], a task - [ ] and punctuation.\n';
for (const size of [10_000, 100_000, 500_000, 1_000_000, 5_000_000, 10_000_000]) {
    const noteContent = noteLine.repeat(Math.ceil(size / noteLine.length)).slice(0, size);
    const options = { ...rendererOptions, noteContent };

    renderMarkdownSync(options);
    const samples = [];
    for (let iteration = 0; iteration < 3; iteration++) {
        const start = performance.now();
        renderMarkdownSync(options);
        samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    console.log(
        `${size.toLocaleString()} chars (${(size / 1024).toFixed(0)} KiB): `
        + `${samples[1].toFixed(1)} ms median full preview render`
    );
}
