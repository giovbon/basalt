export function getFrontmatterAndBody(content) {
    const lines = String(content || '').split('\n');
    if (!lines[0] || lines[0].trim() !== '---') {
        return { frontmatter: '', body: String(content || '') };
    }

    const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (endIndex === -1) {
        return { frontmatter: '', body: String(content || '') };
    }

    return {
        frontmatter: lines.slice(1, endIndex).join('\n'),
        body: lines.slice(endIndex + 1).join('\n').trim(),
    };
}

export function isMarkmapNote(content) {
    const { frontmatter } = getFrontmatterAndBody(content);
    return frontmatter.split('\n').some((line) => {
        const match = line.match(/^\s*note-type\s*:\s*(.*?)\s*$/);
        if (!match) return false;
        const value = match[1].replace(/^(['"])(.*)\1$/, '$2');
        return value === 'markmap';
    });
}
