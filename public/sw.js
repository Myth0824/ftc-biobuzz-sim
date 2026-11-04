// Keeps the simulator working offline, as at an event with no Wi-Fi, and lets a browser install it as an app. It
// controls /sim/ only. On install it caches the page, the scripts it loads, and the FIELD models, so the first visit is
// enough. Built scripts have content hashes in their names, so the cached copy is always right; everything else is
// fetched first and falls back to the cache. The API, which saves traces and notes, is never cached.
const CACHE = 'biobuzz-sim-v2';
const FILES = ['/field.glb', '/balls.gltf', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE), page = await fetch('/sim/'), html = await page.clone().text();
    await cache.put('/sim/', page);
    const scripts = [...new Set(html.match(/\/assets\/[\w.-]+\.(?:js|css)/g) ?? [])];
    // The entry script names the chunks that it loads later, such as the AUTO editor's expression editor.
    for (const s of scripts.filter(s => s.endsWith('.js'))) {
      const text = await (await fetch(s)).text();
      for (const m of text.matchAll(/"\.\/([\w.-]+\.js)"/g)) scripts.push(`/assets/${m[1]}`);
    }
    // The fonts' stylesheet names the font files. Only the Latin ones are kept.
    const fonts = html.match(/https:\/\/fonts\.googleapis\.com\/css2[^"]+/)?.[0].replace(/&amp;/g, '&');
    if (fonts) try {
      const css = await fetch(fonts); await cache.put(fonts, css.clone());
      for (const block of (await css.text()).split('/* ').filter(b => b.startsWith('latin */'))) {
        const m = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/.exec(block); if (m) scripts.push(m[1]);
      }
    } catch { /* Offline, the system fonts stand in. */ }
    await Promise.allSettled([...new Set([...scripts, ...FILES])].map(u => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== location.origin && !fonts) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (fonts || url.pathname.startsWith('/assets/')) {
      const hit = await cache.match(req, { ignoreVary: true }); if (hit) return hit;
      const res = await fetch(req); if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res;
    }
    try {
      const res = await fetch(req); if (res.ok) cache.put(req, res.clone()); return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreVary: true, ignoreSearch: req.mode === 'navigate' }); if (hit) return hit;
      throw err;
    }
  })());
});
