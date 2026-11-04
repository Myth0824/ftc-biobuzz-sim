/**
 * Starts the Vite dev server on port 5888, waits for it to be ready,
 * then launches Electron pointing at the correct URL. Exits when Electron closes.
 */
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 5888;

// Strip ANSI escape codes so the regex works regardless of color output
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

// Start Vite
const vite = spawn('node_modules/.bin/vite', ['--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});

vite.on('error', e => { console.error('Vite failed to start:', e.message); process.exit(1); });

let resolvePort;
const portReady = new Promise(res => { resolvePort = res; });

const onViteData = chunk => {
  const text = stripAnsi(chunk.toString());
  process.stdout.write(chunk); // still show Vite output
  // Match "Local:   http://localhost:5888/" or just look for the port number
  const m = /localhost:(\d+)/.exec(text);
  if (m) resolvePort(Number(m[1]));
};

vite.stdout.on('data', onViteData);
vite.stderr.on('data', chunk => process.stderr.write(chunk));

// Fallback: if we haven't detected the port after 4s, assume it bound to PORT
setTimeout(() => resolvePort(PORT), 4000);

// Poll until Vite actually responds
function waitForVite(port, retries = 40) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const try_ = () => {
      http.get(`http://localhost:${port}/sim/`, res => {
        if (res.statusCode < 500) resolve();
        else retry();
      }).on('error', retry);
    };
    const retry = () => {
      if (++attempts >= retries) return reject(new Error('Vite did not start in time'));
      setTimeout(try_, 300);
    };
    try_();
  });
}

const electronBin = path.join(root, 'node_modules/.bin/electron');

portReady.then(port => {
  process.env.VITE_PORT = String(port);
  return waitForVite(port);
}).then(() => {
  const electron = spawn(electronBin, [path.join(__dirname, 'main.cjs')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env },
    shell: false,
  });

  electron.on('error', e => { console.error('Electron failed to start:', e.message); cleanup(1); });
  electron.on('close', code => cleanup(code ?? 0));
}).catch(e => {
  console.error(e.message);
  cleanup(1);
});

function cleanup(code) {
  vite.kill();
  process.exit(code);
}

process.on('SIGINT',  () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));
