// Basalt Service Worker
// Minimal service worker for PWA install support

// Cache version - automatically uses app version from VERSION file
// Cache is invalidated when app version changes (e.g., 0.10.4 -> 0.10.5)
// This forces users to download fresh files when you release a new version.
const CACHE_NAME = 'basalt-__APP_VERSION__';

// Assets to cache for offline boot. app.js and the stylesheets carry the same
// ?v= as their tags in index.html, so this precaches the URLs the page
// actually requests. Alpine, marked and DOMPurify are mandatory to boot the
// shell; the heavier libraries (MathJax, Mermaid, vis-network, Highlight.js)
// load on demand and are runtime-cached by the fetch handler below.
const PRECACHE_ASSETS = [
  '/index.html',
  '/static/logo.svg',
  '/static/favicon.svg',
  '/static/tailwind.css?v=__APP_VERSION__',
  '/static/markdown-preview.css?v=__APP_VERSION__',
  '/static/app.js?v=__APP_VERSION__',
  '/static/vendor/alpinejs/cdn.min.js',
  '/static/vendor/marked/marked.min.js',
  '/static/vendor/dompurify/purify.min.js'
];

// Install event - cache essential assets
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_ASSETS);
    // The shell's blocking stylesheet is /api/themes/<id>, and the id is the
    // user's saved preference (not known here). Theme files are tiny, so cache
    // every one: an offline boot then keeps whatever theme was selected.
    await precacheThemes(cache);
    await self.skipWaiting();
  })());
});

async function precacheThemes(cache) {
  try {
    const response = await fetch('/api/themes');
    if (!response.ok) return;
    const data = await response.json();
    const ids = (data.themes || []).map((theme) => theme && theme.id).filter(Boolean);
    await Promise.all(ids.map((id) => cache
      .add('/api/themes/' + encodeURIComponent(id))
      .catch(() => {})));
  } catch (_) {
    // Offline install (or an auth redirect): themes are also runtime-cached.
  }
}

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - network first, fallback to cache for assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Only handle same-origin requests
  if (url.origin !== location.origin) {
    return;
  }

  // Navigations (including deep links into the SPA) need the app shell when
  // the server is unreachable. index.html is precached at install.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .catch(async () => (await caches.match('/index.html')) || Response.error())
    );
    return;
  }
  
  // Themes and locales are API GETs, but the shell needs them to render
  // correctly offline. Cache them at runtime, under the versioned cache.
  if (url.pathname.startsWith('/api/themes/') || url.pathname.startsWith('/api/locales/')) {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(event.request, response.clone());
        }
        return response;
      } catch (error) {
        return (await caches.match(event.request)) || Response.error();
      }
    })());
    return;
  }
  
  // For API calls, always go to network
  if (url.pathname.startsWith('/api/')) {
    return;
  }
  
  // Static assets: cache first, then network. Responses fetched after install
  // (vendor libraries loaded on demand) are added to the runtime cache, so the
  // second offline visit has them instead of failing.
  if (url.pathname.startsWith('/static/')) {
    event.respondWith((async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(event.request, response.clone());
        }
        return response;
      } catch (error) {
        return Response.error();
      }
    })());
    return;
  }
  
  // For everything else, network first
  event.respondWith(
    fetch(event.request)
      .catch(() => caches.match(event.request))
  );
});

