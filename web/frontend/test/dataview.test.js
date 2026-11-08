import test from 'node:test';
import assert from 'node:assert/strict';

import {
    findDataviewQueries,
    formatDataviewResult,
    previewSourceWithDataviewResults,
    replaceDataviewQueries,
} from '../src/lib/dataview.js';

test('finds query fences without matching examples nested in code', () => {
    const source = [
        '````js',
        '```basalt-query',
        'type: list',
        '```',
        '````',
        '',
        '~~~query',
        'type: list',
        '~~~',
    ].join('\n');
    const blocks = findDataviewQueries(source);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].query, 'type: list');
    assert.equal(blocks[0].start, 6);
});

test('recognizes query and basalt-query as block languages', () => {
    const source = '```query\ntype: list\n```\n\n```basalt-query\ntype: table\n```';
    assert.deepEqual(findDataviewQueries(source).map((block) => block.query), [
        'type: list',
        'type: table',
    ]);
});

test('does not execute query-looking fences in frontmatter', () => {
    const source = '---\nexample: |\n  ```query\n  type: list\n  ```\n---\n# Note';
    assert.deepEqual(findDataviewQueries(source), []);
});

test('replaces query blocks while preserving surrounding Markdown', () => {
    const source = '# Projects\n\n```basalt-query\ntype: list\n```\n\nDone';
    const blocks = findDataviewQueries(source);
    assert.equal(
        replaceDataviewQueries(source, blocks, ['- Result']),
        '# Projects\n\n- Result\n\nDone',
    );
});

test('keeps the previous result visible while a query refreshes', () => {
    const source = '# Projects\n\n```query\ntype: list\n```\n\nDone';
    const blocks = findDataviewQueries(source);
    assert.equal(
        previewSourceWithDataviewResults(source, blocks, { 'type: list': '- [[Old result]]' }),
        '# Projects\n\n- [[Old result]]\n\nDone',
    );
    assert.equal(
        previewSourceWithDataviewResults(source, blocks, {}),
        '# Projects\n\nConsultando consulta…\n\nDone',
    );
});

test('formats list, table values, and note links', () => {
    const rows = [{
        path: 'Projects/Plan.md',
        name: 'Plan',
        values: { 'file.name': 'Plan', status: 'active', tags: ['work', 'now'] },
    }];
    assert.equal(formatDataviewResult({ type: 'list', rows }), '- [[Projects/Plan.md|Plan]]');
    assert.equal(
        formatDataviewResult({ type: 'table', columns: ['file.name', 'status', 'tags'], rows }),
        '<table class="basalt-query-table"><thead><tr><th>file.name</th><th>status</th><th>tags</th></tr></thead><tbody><tr><td><a href="/Projects/Plan.md" class="wikilink" data-wikilink="Projects/Plan.md">Plan</a></td><td>active</td><td>work, now</td></tr></tbody></table>',
    );
    assert.equal(
        formatDataviewResult({
            type: 'task',
            rows: [{ ...rows[0], values: { 'task.text': 'Review plan', 'task.completed': true } }],
        }),
        '- ✓ Review plan — [[Projects/Plan.md|Plan]]',
    );
});

test('escapes query table content and encodes note links', () => {
    const html = formatDataviewResult({
        type: 'table',
        columns: ['file.name', 'title'],
        rows: [{
            path: 'Folder/A Note.md',
            name: 'A Note',
            values: { title: '<script>alert(1)</script>' },
        }],
    });
    assert.match(html, /href="\/Folder\/A%20Note\.md"/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
});
