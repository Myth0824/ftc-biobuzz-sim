/// <reference types="vitest/config" />
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { configDefaults } from 'vitest/config';

/**
 * Saves match traces and annotations into the repository's traces/ folder, so that they can be read from disk later.
 * POST /api/trace/<name> with a JSON body writes traces/<name>.json. POST /api/notes/<name> with { json, markdown }
 * writes traces/<name>.annotations.json and traces/<name>.annotations.md. GET /api/traces lists the saved traces.
 */
function traceStore(): Plugin {
  const dir = path.resolve('traces'), safe = (n: string) => n.replace(/[^A-Za-z0-9_-]/g, '');
  return {
    name: 'trace-store',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '', send = (code: number, body: unknown) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
        if (!url.startsWith('/api/trace') && !url.startsWith('/api/notes')) return next();
        fs.mkdirSync(dir, { recursive: true });
        if (req.method === 'GET' && url === '/api/traces') return send(200, fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('annotations')).sort().reverse());
        if (req.method === 'GET' && url.startsWith('/api/trace/')) { const f = path.join(dir, `${safe(url.slice(11))}.json`); return fs.existsSync(f) ? (res.setHeader('content-type', 'application/json'), res.end(fs.readFileSync(f))) : send(404, { error: 'No such trace' }); }
        if (req.method !== 'POST') return send(405, { error: 'Use GET or POST' });
        let raw = ''; for await (const chunk of req) raw += chunk;
        if (url.startsWith('/api/trace/')) { fs.writeFileSync(path.join(dir, `${safe(url.slice(11))}.json`), raw); return send(200, { saved: `traces/${safe(url.slice(11))}.json` }); }
        const name = safe(url.slice(11)), body = JSON.parse(raw);
        fs.writeFileSync(path.join(dir, `${name}.annotations.json`), JSON.stringify(body.json, null, 1)); fs.writeFileSync(path.join(dir, `${name}.annotations.md`), body.markdown);
        return send(200, { saved: `traces/${name}.annotations.md` });
      });
    },
  };
}

/** Serves public/lab/ and public/lessons/ at their folder URLs in the dev server, as Cloudflare Pages does on the deployed site. */
function folderIndex(): Plugin {
  return { name: 'folder-index', configureServer(server) { server.middlewares.use((req, _res, next) => { if (req.url === '/lab/' || req.url === '/lessons/') req.url += 'index.html'; next(); }); } };
}

// src/main.ts awaits the physics engine at the top level, which needs an ES2022 target: Chrome 89, Firefox 89, Safari 15.
/**
 * Writes trees/catalog.json into the build: every tree file in src/auto/trees/auto/ and src/auto/trees/teleop/, with
 * its text and its SHA-256, and one
 * hash over the whole set. The file ships in the same deployment as the code that runs the trees, and
 * functions/api/trees.js copies it into the D1 catalog, so that the catalog's system rows always match the live code.
 */
function treeCatalog(): Plugin {
  const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
  return {
    name: 'tree-catalog',
    generateBundle() {
      // The folder is the kind: AUTO trees run in the onboard environment, and TELEOP trees in the driver environment.
      const envs: Record<string, string> = { auto: 'onboard', teleop: 'driver' }, kinds: Record<string, string> = { onboard: 'auto', driver: 'teleop' };
      const files = Object.keys(envs).flatMap(kind => fs.readdirSync(path.resolve('src/auto/trees', kind)).filter(f => f.endsWith('.json')).sort().map(f => ({ kind, f: path.join('src/auto/trees', kind, f) })));
      const trees = files.map(({ kind, f }) => {
        const text = fs.readFileSync(path.resolve(f), 'utf8'), t = JSON.parse(text);
        if (t.env !== envs[kind]) throw new Error(`${f}: a tree in the ${kind} folder must use the ${envs[kind]} environment, not '${t.env}'`);
        return { id: t.id, kind: kinds[t.env], env: t.env, name: t.name, description: t.description ?? '', meta: t.meta ?? {}, hash: sha(text), json: text };
      });
      const hash = sha(trees.map(t => `${t.id}:${t.hash}`).join('\n'));
      this.emitFile({ type: 'asset', fileName: 'trees/catalog.json', source: JSON.stringify({ version: 1, hash, trees }) });
    },
  };
}

/** Lists the sound files in public/sounds/ as `virtual:sounds`, so the page loads the ones there without probing for each cue. */
function soundList(): Plugin {
  const id = 'virtual:sounds', dir = path.resolve('public/sounds');
  return {
    name: 'sound-list',
    resolveId: s => (s === id ? `\0${id}` : null),
    load: s => (s === `\0${id}` ? `export default ${JSON.stringify(fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.(wav|mp3)$/.test(f)) : [])};` : null),
  };
}

export default defineConfig({
  plugins: [folderIndex(), traceStore(), treeCatalog(), soundList()], build: { target: 'es2022', rollupOptions: { input: { home: 'index.html', sim: 'sim/index.html' } } },
  // Agent sessions can keep git worktrees in .claude/worktrees/, each with its own copy of the tests.
  test: { exclude: [...configDefaults.exclude, '.claude/**'] },
});
