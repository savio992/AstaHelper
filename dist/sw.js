// Il service worker: serve a far partire l'app senza rete.
//
// All'asta si e' in venti in una stanza attaccati all'hotspot di qualcuno, e la pagina pesa
// trecento kilobyte. Scaricarla ogni volta e' un rischio che non ha ragione di esistere: il
// listone e l'asta stanno gia' nel telefono, manca solo il guscio.
//
// VERSIONE la riscrive scripts/build.js con l'impronta di dist/index.html: cambia solo quando
// cambia davvero l'app, e cambiando fa scadere la cache vecchia.
const VERSIONE = 'e9f9f2d5afc1';
const CACHE = `astahelper-${VERSIONE}`;

const GUSCIO = ['./', './index.html', './manifest.webmanifest', './icona-180.png', './icona-192.png', './icona-512.png', './icona.svg'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE).then((c) =>
      // Uno a uno e senza fallire tutto per un file: addAll() e' atomico, e basterebbe
      // un'icona non ancora pubblicata per lasciare l'app senza guscio in cache.
      Promise.all(GUSCIO.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => null)))
    )
  );
  // Niente skipWaiting() qui: la versione nuova entra quando lo dice l'utente, non a meta'
  // di un rilancio. Vedi il messaggio SKIP_WAITING piu' sotto.
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((nomi) => Promise.all(nomi.filter((n) => n !== CACHE && n.startsWith('astahelper-')).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (ev) => {
  if (ev.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

/**
 * Dalla cache subito, aggiornamento dietro le quinte.
 *
 * L'alternativa — prima la rete, la cache se fallisce — costerebbe l'attesa della rete a ogni
 * apertura, che e' proprio quello che si vuole togliere. Cosi' l'app parte sempre istantanea e
 * la versione nuova, quando c'e', si annuncia invece di imporsi.
 */
function dallaCachePoiRete(req) {
  return caches.open(CACHE).then((c) =>
    c.match(req).then((salvata) => {
      const dallaRete = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') c.put(req, res.clone());
          return res;
        })
        .catch(() => salvata);
      return salvata || dallaRete;
    })
  );
}

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Solo la nostra origine: qualunque altra cosa passa dritta e non finisce in cache.
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    ev.respondWith(
      dallaCachePoiRete(req).then((res) => res || caches.match('./index.html').then((r) => r || fetch(req)))
    );
    return;
  }
  if (GUSCIO.some((u) => url.pathname.endsWith(u.replace('./', '')))) {
    ev.respondWith(dallaCachePoiRete(req));
  }
});
