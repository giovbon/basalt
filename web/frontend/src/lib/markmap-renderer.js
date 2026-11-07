import { Transformer } from 'markmap-lib';
import { deriveOptions, Markmap } from 'markmap-view';

const transformer = new Transformer();
transformer.md.set({ html: false });

export async function renderMarkmap(svg, markdown, instance) {
    const { root, frontmatter } = transformer.transform(markdown);
    const options = deriveOptions({
        autoFit: true,
        duration: 200,
        ...frontmatter?.markmap,
    });
    const markmap = instance || Markmap.create(svg, options, root);

    if (instance) {
        markmap.setOptions(options);
        await markmap.setData(root);
    }
    await markmap.fit();
    return markmap;
}
