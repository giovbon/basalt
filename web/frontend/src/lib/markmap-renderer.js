import { Transformer } from 'markmap-lib';
import { Markmap } from 'markmap-view';

const transformer = new Transformer();
transformer.md.set({ html: false });

export async function renderMarkmap(svg, markdown, instance) {
    const { root } = transformer.transform(markdown);
    const markmap = instance || Markmap.create(svg, {
        autoFit: true,
        duration: 200,
    }, root);

    if (instance) await markmap.setData(root);
    await markmap.fit();
    return markmap;
}
