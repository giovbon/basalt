const QUERY_OPEN = /^ {0,3}(`{3,}|~{3,})(?:basalt-query|query)\s*$/i;

export function findDataviewQueries(content) {
    const lines = content.split('\n');
    const blocks = [];
    let fence = null;
    let fenceLength = 0;
    let start = -1;

    let bodyStart = 0;
    while (bodyStart < lines.length && lines[bodyStart].replace(/^\uFEFF/, '').trim() === '') bodyStart++;
    if (lines[bodyStart]?.replace(/^\uFEFF/, '').trim() === '---') {
        for (let i = bodyStart + 1; i < lines.length; i++) {
            if (lines[i].trim() === '---') {
                bodyStart = i + 1;
                break;
            }
        }
    }

    for (let i = bodyStart; i < lines.length; i++) {
        const line = lines[i];
        if (fence) {
            const close = new RegExp(`^ {0,3}${fence === '`' ? '`' : '~'}{${fenceLength},}\\s*$`);
            if (close.test(line)) {
                if (start >= 0) {
                    blocks.push({ start, end: i, query: lines.slice(start + 1, i).join('\n') });
                    start = -1;
                }
                fence = null;
                fenceLength = 0;
            }
            continue;
        }

        const queryOpen = line.match(QUERY_OPEN);
        if (queryOpen) {
            fence = queryOpen[1][0];
            fenceLength = queryOpen[1].length;
            start = i;
            continue;
        }
        const regularOpen = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (regularOpen) {
            fence = regularOpen[1][0];
            fenceLength = regularOpen[1].length;
        }
    }

    return blocks;
}

export function replaceDataviewQueries(content, blocks, replacements) {
    const lines = content.split('\n');
    const result = [];
    let cursor = 0;
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        result.push(...lines.slice(cursor, block.start), replacements[i]);
        cursor = block.end + 1;
    }
    result.push(...lines.slice(cursor));
    return result.join('\n');
}

export function previewSourceWithDataviewResults(content, blocks, results) {
    const replacements = blocks.map(({ query }) => results[query] ?? 'Consultando consulta…');
    return replaceDataviewQueries(content, blocks, replacements);
}

export function formatDataviewResult(result) {
    if (!result.rows.length) return '_Nenhum resultado._';
    if (result.type === 'list') {
        return result.rows.map((row) => `- ${noteLink(row)}`).join('\n');
    }
    if (result.type === 'task') {
        return result.rows.map((row) => {
            const task = valueText(row.values['task.text']);
            const status = row.values['task.completed'] ? '✓' : '○';
            return `- ${status} ${escapeCell(task)} — ${noteLink(row)}`;
        }).join('\n');
    }

    const header = result.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');
    const rows = result.rows.map((row) => `<tr>${result.columns.map((column) => {
        const value = column === 'file.name'
            ? noteLinkHtml(row)
            : escapeHtml(valueText(row.values[column]));
        return `<td>${value}</td>`;
    }).join('')}</tr>`).join('');
    return `<table class="basalt-query-table"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
}

export function formatDataviewError(message) {
    return `> Consulta Basalt: ${escapeCell(message)}`;
}

function noteLink(row) {
    const path = String(row.path || '');
    const name = String(row.name || '');
    if (!path || /[\]|]/.test(path) || /[\]|]/.test(name)) return escapeCell(name || path);
    return `[[${path}|${name || path}]]`;
}

function noteLinkHtml(row) {
    const path = String(row.path || '');
    const name = String(row.name || '');
    if (!path || /[\]|]/.test(path) || /[\]|]/.test(name)) return escapeHtml(name || path);
    const href = `/${path.split('/').map(encodeURIComponent).join('/')}`;
    return `<a href="${escapeHtml(href)}" class="wikilink" data-wikilink="${escapeHtml(path)}">${escapeHtml(name || path)}</a>`;
}

function valueText(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(valueText).join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeCell(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/([`*_{}\[\]()#+.!-])/g, '\\$1')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, ' ')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
