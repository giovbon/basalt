const HIGHLIGHT_JS_LANGUAGES = [
    'csharp', 'python', 'bash', 'shell', 'powershell', 'javascript',
    'typescript', 'json', 'sql', 'yaml', 'css', 'http',
];

let highlightJsLoadPromise = null;

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
    });
}

export function loadHighlightJs() {
    if (globalThis.hljs) return Promise.resolve(globalThis.hljs);
    if (!highlightJsLoadPromise) {
        highlightJsLoadPromise = loadScript('/static/vendor/highlight.js/highlight.min.js')
            .then(() => Promise.all(HIGHLIGHT_JS_LANGUAGES.map((language) =>
                loadScript(`/static/vendor/highlight.js/languages/${language}.min.js`)
            )))
            .then(() => globalThis.hljs)
            .catch((error) => {
                highlightJsLoadPromise = null;
                throw error;
            });
    }
    return highlightJsLoadPromise;
}
