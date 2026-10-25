// Offline-friendly caching: app shell and timetable data are served from cache and
// refreshed in the background; map tiles are cached up to a cap; live feeds never are.

const VERSION = 'v2';
const SHELL = `densha-shell-${VERSION}`;
const DATA = `densha-data-${VERSION}`;
const TILES = `densha-tiles-${VERSION}`;
const MAX_TILES = 2500;
let tileRequests = 0;

const SHELL_FILES = [
    './', 'index.html', 'styles.css', 'manifest.webmanifest',
    'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css',
    'src/main.js', 'src/network.js', 'src/timetable.js', 'src/live.js', 'src/trainlayer.js',
    'src/mapstyle.js', 'src/clock.js', 'src/i18n.js', 'src/tokyo.js', 'src/feeds/odpt.js',
    'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys => Promise.all(
        keys.filter(k => k.startsWith('densha-') && ![SHELL, DATA, TILES].includes(k)).map(k => caches.delete(k))
    )).then(() => self.clients.claim()));
});

async function staleWhileRevalidate(cacheName, request, event) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request, {ignoreSearch: cacheName === SHELL});
    const network = fetch(request).then(res => {
        if (res.ok) {
            cache.put(request, res.clone());
        }
        return res;
    }).catch(() => cached);
    if (cached) {
        event.waitUntil(network);
        return cached;
    }
    return network;
}

async function trimTiles() {
    const cache = await caches.open(TILES);
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - MAX_TILES; i++) {
        await cache.delete(keys[i]);
    }
}

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') {
        return;
    }
    const url = new URL(req.url);
    // Live data: always network
    if (url.hostname.endsWith('odpt.org')) {
        return;
    }
    if (url.hostname === 'tiles.openfreemap.org') {
        event.respondWith(staleWhileRevalidate(TILES, req, event).then(res => {
            if (++tileRequests % 200 === 0) {
                event.waitUntil(trimTiles());
            }
            return res;
        }));
        return;
    }
    if (url.origin !== location.origin) {
        return;
    }
    if (url.pathname.includes('/data/')) {
        event.respondWith(staleWhileRevalidate(DATA, req, event));
        return;
    }
    event.respondWith(staleWhileRevalidate(SHELL, req, event));
});
