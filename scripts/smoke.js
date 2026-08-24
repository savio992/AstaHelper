// Smoke test in un browser vero: serve i file e usa Chromium in headless con --dump-dom.
// Verifica che l'app parta davvero e che il file compilato non si sia rotto nella concatenazione.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// headless_shell e' piu' leggero e non tenta di parlare con dbus o con la GPU.
const CANDIDATES = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].filter(Boolean);
const CHROME = CANDIDATES.find((c) => fs.existsSync(c));
if (!CHROME) {
  console.log('nessun browser disponibile: smoke test saltato');
  process.exit(0);
}
const IS_SHELL = CHROME.endsWith('headless_shell');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('no');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// Deve restare asincrona: il server statico vive in questo stesso processo e una
// chiamata sincrona bloccherebbe l'event loop lasciando il browser senza risposte.
async function dumpDom(url, budget = 20000) {
  const args = [
    ...(IS_SHELL ? [] : ['--headless']),
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    `--virtual-time-budget=${budget}`,
    '--dump-dom',
    url,
  ];
  const { stdout } = await run(CHROME, args, { maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
  return stdout;
}

let failures = 0;
const expect = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  console.log('scenario di dominio nel browser:');
  const scenario = await dumpDom(`http://127.0.0.1:${port}/test/browser/scenario.html`);
  const out = (scenario.match(/<pre id="out">([\s\S]*?)<\/pre>/) || [])[1] || '';
  const decode = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const line of decode(out).split('\n').filter(Boolean)) {
    const ok = line.startsWith('PASS');
    if (!ok) failures++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${line.replace(/^(PASS|FAIL) /, '')}`);
  }
  expect('lo scenario ha prodotto risultati', out.trim().length > 0);

  console.log('\nflusso di interfaccia nel browser:');
  const ui = await dumpDom(`http://127.0.0.1:${port}/test/browser/ui.html`);
  const uiOut = (ui.match(/<pre id="out">([\s\S]*?)<\/pre>/) || [])[1] || '';
  for (const line of decode(uiOut).split('\n').filter(Boolean)) {
    const ok = line.startsWith('PASS');
    if (!ok) failures++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${line.replace(/^(PASS|FAIL) /, '')}`);
  }
  expect('il flusso di interfaccia ha prodotto risultati', uiOut.trim().length > 0);

  console.log('\napp in sviluppo:');
  const dev = await dumpDom(`http://127.0.0.1:${port}/index.html`);
  expect("l'app disegna la barra delle schede", dev.includes('data-tab="asta"'));
  expect('parte dalla schermata di import', dev.includes('Carica il listone'));
  expect('nessun errore visibile a schermo', !/Uncaught|is not defined/.test(dev));

  console.log('\napp compilata in un file solo:');
  const dist = await dumpDom(`http://127.0.0.1:${port}/dist/index.html`);
  expect("l'app disegna la barra delle schede", dist.includes('data-tab="asta"'));
  expect('parte dalla schermata di import', dist.includes('Carica il listone'));
  expect('nessun riferimento rotto dalla concatenazione', !/is not defined/.test(dist));
} finally {
  server.close();
}

console.log(failures ? `\n${failures} verifiche fallite` : '\ntutto verde');
process.exit(failures ? 1 : 0);
