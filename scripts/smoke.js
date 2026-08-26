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

// Un pixel da tenere in sospeso, per far aspettare l'evento load. Vedi dumpDom piu' sotto.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
let rilasciaAttesa = null;

const server = http.createServer((req, res) => {
  const percorso = decodeURIComponent(req.url.split('?')[0]);

  // Il pixel resta appeso finche' la pagina non dice di aver finito: cosi' l'evento load
  // aspetta il lavoro asincrono invece di precederlo.
  if (percorso === '/dist/attendi.png') {
    rilasciaAttesa = () => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PIXEL);
    };
    return;
  }
  if (percorso === '/dist/fatto') {
    res.writeHead(200).end('ok');
    if (rilasciaAttesa) rilasciaAttesa();
    rilasciaAttesa = null;
    return;
  }

  // Il service worker vale solo per la cartella da cui viene servito: la pagina che lo prova
  // deve stare dentro dist/. La si mappa qui invece di scriverla nella cartella pubblicata.
  let file =
    percorso === '/dist/prova-sw.html'
      ? path.join(root, 'test/browser/sw.html')
      : path.join(root, percorso);
  // Una cartella risponde con il suo index.html, come fa qualunque hosting statico. Senza,
  // il precache di './' fallirebbe qui e passerebbe in produzione.
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
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
/**
 * `budget` a null spegne il tempo virtuale.
 *
 * Serve per il service worker: con il tempo virtuale i timer scattano subito in tempo reale, e
 * la registrazione — che aspetta I/O vero — non fa in tempo a concludersi. Senza tempo virtuale
 * pero' --dump-dom stampa all'evento load, quindi la pagina lo tiene aperto con il pixel
 * appeso qui sopra e lo rilascia quando ha finito.
 */
async function dumpDom(url, budget = 20000) {
  const args = [
    ...(IS_SHELL ? [] : ['--headless']),
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    ...(budget === null ? [] : [`--virtual-time-budget=${budget}`]),
    '--dump-dom',
    url,
  ];
  // I consigli d'asta costano ora un paio di secondi ciascuno: il flusso di interfaccia ne
  // fa parecchi e novanta secondi non bastavano piu'. Meglio un limite largo che un rosso
  // che non dice niente sul codice.
  const { stdout } = await run(CHROME, args, { maxBuffer: 64 * 1024 * 1024, timeout: 240000 });
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
  const ui = await dumpDom(`http://127.0.0.1:${port}/test/browser/ui.html`, 60000);
  const uiOut = (ui.match(/<pre id="out">([\s\S]*?)<\/pre>/) || [])[1] || '';
  for (const line of decode(uiOut).split('\n').filter(Boolean)) {
    const ok = line.startsWith('PASS');
    if (!ok) failures++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${line.replace(/^(PASS|FAIL) /, '')}`);
  }
  expect('il flusso di interfaccia ha prodotto risultati', uiOut.trim().length > 0);

  console.log('\ncampi che si scrivono a mano:');
  const fuoco = await dumpDom(`http://127.0.0.1:${port}/test/browser/fuoco.html`, 30000);
  const fuocoOut = (fuoco.match(/<pre id="out">([\s\S]*?)<\/pre>/) || [])[1] || '';
  for (const line of decode(fuocoOut).split('\n').filter(Boolean)) {
    const ok = line.startsWith('PASS');
    if (!ok) failures++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${line.replace(/^(PASS|FAIL) /, '')}`);
  }
  expect('il fuoco nei campi e\' stato verificato', fuocoOut.trim().length > 0);

  console.log('\ninstallabile e offline:');
  const distFiles = fs.readdirSync(path.join(root, 'dist'));
  for (const atteso of ['manifest.webmanifest', 'sw.js', 'icona-180.png', 'icona-192.png', 'icona-512.png']) {
    expect(`dist/ contiene ${atteso}`, distFiles.includes(atteso));
  }
  const distIndex = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
  expect('la pagina dichiara il manifest', distIndex.includes('rel="manifest"'));
  expect("la pagina dichiara l'icona per iOS", distIndex.includes('rel="apple-touch-icon"'));
  expect('e registra il service worker', distIndex.includes("register('./sw.js')"));
  expect(
    'il segnaposto della versione e\' stato sostituito',
    !fs.readFileSync(path.join(root, 'dist/sw.js'), 'utf8').includes('__VERSIONE__')
  );
  // La pagina ospitata gira dentro un iframe con sandbox: li' un service worker non funziona,
  // e registrarlo lascerebbe solo un errore in console.
  expect(
    "la versione ospitata non registra niente",
    !fs.readFileSync(path.join(root, 'dist/artifact.html'), 'utf8').includes('serviceWorker')
  );

  const sw = await dumpDom(`http://127.0.0.1:${port}/dist/prova-sw.html`, null);
  const swOut = (sw.match(/<pre id="out">([\s\S]*?)<\/pre>/) || [])[1] || '';
  for (const line of decode(swOut).split('\n').filter(Boolean)) {
    const ok = line.startsWith('PASS');
    if (!ok) failures++;
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${line.replace(/^(PASS|FAIL) /, '')}`);
  }
  expect('il service worker e\' stato messo alla prova', swOut.trim().length > 0);

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
