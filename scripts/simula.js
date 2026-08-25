// Un'asta finta con otto partecipanti, per vedere se l'assistente regge davvero.
//
// I test verificano che i pezzi facciano quello che dicono; questo verifica l'unica cosa che
// conta, cioe' se alla fine della serata la rosa e' migliore di quella degli altri. Sette
// avversari giocano con strategie diverse, alcune sbagliate come nella realta' (chi si innamora
// della sua squadra, chi svuota il portafogli sui primi nomi, chi tiene i crediti e poi va nel
// panico); l'ottavo e' l'app, che usa il proprio piano, il proprio tetto di reparto e il conto
// del mercato esattamente come li userebbe un utente.
//
// L'asta si risolve al secondo prezzo: in un'asta a voce chi vince paga un credito piu' di
// quanto era disposto a pagare il secondo, non quanto era disposto a pagare lui.

import { ROLES, ROLE_LABEL, totalSlots, defaultSettings, inferTierOrder, annotateTierPct, annotatePmaShare, annotatePriceShare } from '../src/domain/model.js';
import { mergeSources } from '../src/domain/csv.js';
import { valuePlayers, markTopPlayers, rosterScore, expectedShare } from '../src/domain/valuation.js';
import { withExpectedPrices } from '../src/domain/market.js';
import { statoMercato, applyPrezziLive } from '../src/domain/mercato.js';
import { optimizeRoster } from '../src/domain/optimizer.js';
import { maxBid, budgetDiFase } from '../src/domain/advisor.js';

const FAST = { prune: true, localSearch: false };

function rng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- gli avversari ------------------------------------------------------
//
// Ogni strategia risponde a una sola domanda: fino a quanto sono disposto a pagare questo
// giocatore, adesso. Il resto (chi vince, quanto paga) lo decide l'asta.

const STRATEGIE = {
  listone: {
    nome: 'Listone',
    descrizione: 'paga esattamente il prezzo medio delle altre aste',
    quanto: (p) => p.expectedPrice,
  },
  aggressivo: {
    nome: 'Aggressivo',
    descrizione: 'sui big rilancia fino al 35% sopra il mercato',
    quanto: (p) => p.expectedPrice * (p.isTop ? 1.35 : 1),
  },
  tirchio: {
    nome: 'Tirchio',
    descrizione: 'non paga mai piu' + "' " + 'di tre quarti del mercato',
    quanto: (p) => p.expectedPrice * 0.75,
  },
  tifoso: {
    nome: 'Tifoso',
    descrizione: 'raddoppia per i giocatori della squadra del cuore',
    prepara: (m, ctx) => {
      const clubs = [...new Set(ctx.players.map((p) => p.team).filter(Boolean))];
      m.cuore = clubs[Math.floor(ctx.rnd() * clubs.length)];
    },
    quanto: (p, m) => p.expectedPrice * (p.team === m.cuore ? 2 : 0.9),
  },
  stelle: {
    nome: 'Stelle',
    descrizione: 'brucia il budget sui primi nomi, poi riempie a un credito',
    quanto: (p, m, ctx) => (p.isTop && m.spesi < ctx.settings.budget * 0.72 ? p.expectedPrice * 1.6 : 1),
  },
  fantamedia: {
    nome: 'Fantamedia',
    descrizione: 'guarda solo la media attesa, ignora le fasce',
    quanto: (p, m, ctx) => {
      const fm = p.fmvExp ?? p.fantamedia ?? 0;
      const soglia = ctx.sogliaFmv[p.role] ?? 6;
      return fm <= soglia ? 1 : Math.min(120, (fm - soglia) * 42);
    },
  },
  panico: {
    nome: 'Panico',
    descrizione: 'prudente finche' + "' " + 'non rischia di restare scoperto, poi paga qualsiasi cifra',
    quanto: (p, m, ctx) => {
      const mancano = (ctx.settings.slots[p.role] || 0) - m.perRuolo[p.role];
      const inPalio = ctx.inPalio[p.role];
      // Quando i posti in palio scarseggiano rispetto a quelli che gli mancano, perde la testa.
      const stretto = inPalio <= mancano * 1.5;
      return stretto ? m.crediti : p.expectedPrice * 0.85;
    },
  },
};

// --- l'app --------------------------------------------------------------

/**
 * Quanto offre l'assistente.
 *
 * Non si limita agli obiettivi a piano: nell'app l'utente cerca chiunque venga chiamato e legge
 * comunque la sua offerta massima, che per un giocatore inutile vale zero. Restringere le
 * offerte al solo piano lasciava la rosa incompleta, perche' quando il riempitivo pianificato
 * era gia' stato chiamato e superato non veniva mai sostituito.
 *
 * Il calcolo esatto costa una decina di ottimizzazioni, troppo per duecento chiamate: si salta
 * quando il giocatore vale meno del piu' debole fra quelli che il piano ha gia' scelto in quel
 * ruolo, perche' li' il pareggio sarebbe comunque a zero.
 */
function offertaApp(p, m, ctx) {
  if (m.perRuolo[p.role] >= (ctx.settings.slots[p.role] || 0)) return 0;
  const piano = m.piano;
  if (!piano?.ok) return 0;

  if (!piano.picks.some((x) => x.id === p.id)) {
    const scelti = piano.picks.filter((x) => x.role === p.role);
    if (!scelti.length) return 0;
    const peggiore = Math.min(...scelti.map((x) => x.score || 0));
    if ((p.score || 0) < peggiore) return 0;
  }

  const { maxBid: tetto } = maxBid({
    players: ctx.players,
    settings: ctx.settings,
    owned: m.owned,
    unavailable: ctx.venduti,
    playerId: p.id,
  });
  const fase = budgetDiFase({
    settings: ctx.settings,
    players: ctx.players,
    owned: m.owned,
    plan: piano,
    role: p.role,
  });
  return Math.min(tetto, fase.massimoOra);
}

/**
 * Un metro di giudizio che non e' quello dell'app.
 *
 * Classificare le rose con `rosterScore` sarebbe barare: e' la funzione che l'ottimizzatore
 * massimizza, quindi l'app vincerebbe per costruzione. Questo conta invece i punti che la
 * formazione titolare produrrebbe davvero in una stagione — fantamedia attesa per le partite
 * che ci si aspetta, per trentotto giornate — senza nessuna delle correzioni inventate dal
 * modello: niente bonus di fascia, niente modificatori, niente sinergie, niente penalita' di
 * concentrazione. E' grezzo, ma e' neutrale.
 */
function puntiStagione(rosa, settings) {
  let tot = 0;
  for (const role of ROLES) {
    const titolari = Math.max(1, settings.starters?.[role] ?? 1);
    tot += rosa
      .filter((p) => p.role === role)
      .map((p) => (p.fmvExp ?? p.fantamedia ?? 0) * expectedShare(p) * 38)
      .sort((a, b) => b - a)
      .slice(0, titolari)
      .reduce((a, b) => a + b, 0);
  }
  return Math.round(tot);
}

// --- l'asta -------------------------------------------------------------

function nuovoManager(nome, strategia, settings) {
  return {
    nome,
    strategia,
    crediti: settings.budget,
    spesi: 0,
    rosa: [],
    owned: new Map(),
    perRuolo: { P: 0, D: 0, C: 0, A: 0 },
  };
}

/** Il massimo che puo' offrire davvero: deve tenere un credito per ogni slot ancora vuoto. */
function tettoTecnico(m, settings) {
  const mancanti = totalSlots(settings) - m.rosa.length;
  return Math.max(0, m.crediti - Math.max(0, mancanti - 1));
}

export function simula({ roster, settings, seed = 1, appLive = true, avversari = null, verbose = false }) {
  const rnd = rng(seed);
  const nomi = avversari || ['listone', 'aggressivo', 'tirchio', 'tifoso', 'stelle', 'fantamedia', 'panico'];
  const managers = [nuovoManager('AstaHelper', 'app', settings)];
  for (const k of nomi) managers.push(nuovoManager(STRATEGIE[k].nome, k, settings));

  const venduti = new Set();
  const takenGlobale = new Map();
  const log = [];

  // Il listone come lo vede l'app, aggiornato quando serve.
  const base = withExpectedPrices(valuePlayers(roster, settings), settings);
  let players = markTopPlayers(
    applyPrezziLive(base, settings, statoMercato({ settings, players: base, owned: new Map(), taken: new Map() })),
    settings
  );

  // Soglie per la strategia "fantamedia": la mediana del ruolo.
  const sogliaFmv = {};
  for (const role of ROLES) {
    const v = players.filter((p) => p.role === role).map((p) => p.fmvExp ?? 0).sort((a, b) => a - b);
    sogliaFmv[role] = v.length ? v[Math.floor(v.length * 0.7)] : 6;
  }

  const ctx = { players, settings, venduti, rnd, sogliaFmv, inPalio: {} };
  for (const m of managers) {
    const s = STRATEGIE[m.strategia];
    if (s?.prepara) s.prepara(m, ctx);
  }

  const app = managers[0];
  app.piano = optimizeRoster({ players, settings, ...FAST });

  // Si chiama reparto per reparto, dal portiere all'attacco, e dentro ogni reparto dal piu'
  // caro in giu' con un po' di disordine, come succede davvero.
  for (const role of settings.auctionOrder || ROLES) {
    const inPalioIniziale = (settings.slots[role] || 0) * managers.length;
    let assegnati = 0;
    const coda = players
      .filter((p) => p.role === role)
      .map((p) => ({ p, ordine: (p.expectedPrice ?? 1) * (0.8 + 0.4 * rnd()) }))
      .sort((a, b) => b.ordine - a.ordine)
      .map((x) => x.p);

    // Piu' passate sulla stessa coda: un giocatore saltato resta comprabile, come nella realta',
    // dove chi ha ancora uno slot vuoto puo' sempre richiamarlo. Con una sola passata l'ultimo
    // posto di ogni reparto restava vuoto per forza.
    let passata = 0;
    let assegnatiPrima = -1;
    while (assegnati < inPalioIniziale && assegnati !== assegnatiPrima && passata < 6) {
      assegnatiPrima = assegnati;
      passata += 1;
    for (const p of coda) {
      if (assegnati >= inPalioIniziale) break;
      if (venduti.has(p.id)) continue;
      ctx.inPalio[role] = inPalioIniziale - assegnati;
      ctx.players = players;

      // Quanto e' disposto a pagare ciascuno.
      const offerte = managers.map((m) => {
        if (m.perRuolo[role] >= (settings.slots[role] || 0)) return { m, max: 0 };
        const tetto = tettoTecnico(m, settings);
        if (tetto < 1) return { m, max: 0 };
        const grezzo = m.strategia === 'app' ? offertaApp(p, m, ctx) : STRATEGIE[m.strategia].quanto(p, m, ctx);
        return { m, max: Math.max(0, Math.min(tetto, Math.floor(grezzo))) };
      });

      const inGara = offerte.filter((o) => o.max >= 1).sort((a, b) => b.max - a.max || (rnd() < 0.5 ? -1 : 1));
      if (!inGara.length) continue;

      const vincitore = inGara[0];
      const secondo = inGara[1]?.max ?? 0;
      const prezzo = Math.max(1, Math.min(vincitore.max, secondo + 1));

      const m = vincitore.m;
      m.crediti -= prezzo;
      m.spesi += prezzo;
      m.rosa.push({ ...p, pagato: prezzo });
      m.owned.set(p.id, prezzo);
      m.perRuolo[role] += 1;
      venduti.add(p.id);
      takenGlobale.set(p.id, { price: prezzo, by: managers.indexOf(m) });
      assegnati += 1;
      log.push({ role, nome: p.name, a: m.nome, prezzo, atteso: p.expectedPrice });

      if (verbose) console.log(`  ${role} ${p.name.padEnd(16)} -> ${m.nome.padEnd(12)} ${prezzo} (atteso ${p.expectedPrice})`);

      // L'app rilegge il mercato e rifa' il piano, come farebbe l'utente dopo ogni assegnazione.
      if (appLive) {
        const merc = statoMercato({ settings, players: base, owned: app.owned, taken: takenGlobale });
        players = markTopPlayers(applyPrezziLive(base, settings, merc), settings);
      }
      app.piano = optimizeRoster({ players, settings, owned: app.owned, unavailable: venduti, ...FAST });
    }
    }
  }

  // Punteggio finale con lo stesso metro per tutti.
  const esiti = managers.map((m) => ({
    nome: m.nome,
    strategia: m.strategia,
    punti: rosterScore(m.rosa, settings),
    puntiVeri: puntiStagione(m.rosa, settings),
    spesi: m.spesi,
    avanzo: m.crediti,
    rosa: m.rosa.length,
    completa: m.rosa.length === totalSlots(settings),
    top: m.rosa.filter((p) => p.isTop).length,
    topPerRuolo: Object.fromEntries(ROLES.map((r) => [r, m.rosa.filter((p) => p.role === r && p.isTop).length])),
    spesaPerRuolo: Object.fromEntries(ROLES.map((r) => [r, m.rosa.filter((p) => p.role === r).reduce((a, p) => a + p.pagato, 0)])),
  }));
  // La classifica ufficiale della simulazione usa il metro indipendente.
  esiti.sort((a, b) => b.puntiVeri - a.puntiVeri);
  return {
    esiti,
    log,
    posizioneApp: esiti.findIndex((e) => e.strategia === 'app') + 1,
    posizioneAppModello: [...esiti].sort((a, b) => b.punti - a.punti).findIndex((e) => e.strategia === 'app') + 1,
  };
}

// --- avvio da riga di comando -------------------------------------------

async function listoneDiProva() {
  const { makeListoneProjected } = await import('../test/helpers.js');
  return annotatePriceShare(annotatePmaShare(annotateTierPct(makeListoneProjected(7))));
}

async function listoneDaFile(file) {
  const { readFile } = await import('node:fs/promises');
  const fonti = JSON.parse(await readFile(file, 'utf8'));
  return mergeSources(fonti.map((f) => annotatePriceShare(annotatePmaShare(annotateTierPct(f.players)))));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(k);
    return i >= 0 ? process.argv[i + 1] : d;
  };
  const ripetizioni = Number(arg('--ripetizioni', 5));
  const file = arg('--listone', null);
  const campo = arg('--avversari', null)?.split(',') || null;
  const roster = file ? await listoneDaFile(file) : await listoneDiProva();

  const settings = { ...defaultSettings(), participants: 8, budget: 500 };
  for (const r of ROLES) settings.tierOrder[r] = inferTierOrder(roster, r);

  console.log(`listone: ${roster.length} giocatori · 8 squadre · ${settings.budget} crediti · rosa ${totalSlots(settings)}\n`);
  console.log('gli avversari:');
  for (const k of campo || ['listone', 'aggressivo', 'tirchio', 'tifoso', 'stelle', 'fantamedia', 'panico']) {
    console.log(`  ${STRATEGIE[k].nome.padEnd(12)} ${STRATEGIE[k].descrizione}`);
  }

  // Modalita' confronto: la stessa asta due volte, con e senza il riprezzamento del mercato.
  // Serve a sapere se quella parte del modello guadagna qualcosa o e' solo complicazione.
  if (process.argv.includes('--confronto')) {
    console.log(`\n=== il conto del mercato serve? ${ripetizioni} aste identiche, con e senza ===`);
    let con = 0;
    let senza = 0;
    let vinteCon = 0;
    let vinteSenza = 0;
    for (let s = 1; s <= ripetizioni; s++) {
      const a = simula({ roster, settings, seed: s, appLive: true, avversari: campo });
      const b = simula({ roster, settings, seed: s, appLive: false, avversari: campo });
      const pa = a.esiti.find((e) => e.strategia === 'app');
      const pb = b.esiti.find((e) => e.strategia === 'app');
      con += pa.puntiVeri;
      senza += pb.puntiVeri;
      if (a.posizioneApp === 1) vinteCon++;
      if (b.posizioneApp === 1) vinteSenza++;
      console.log(
        `  asta ${String(s).padStart(2)}: con ${pa.puntiVeri} (${a.posizioneApp}ª) · senza ${pb.puntiVeri} (${b.posizioneApp}ª)` +
          ` · differenza ${pa.puntiVeri - pb.puntiVeri >= 0 ? '+' : ''}${pa.puntiVeri - pb.puntiVeri}`
      );
    }
    const d = (con - senza) / ripetizioni;
    console.log(`\n  media con il mercato:   ${Math.round(con / ripetizioni)} punti · ${vinteCon}/${ripetizioni} vittorie`);
    console.log(`  media senza:            ${Math.round(senza / ripetizioni)} punti · ${vinteSenza}/${ripetizioni} vittorie`);
    console.log(`  guadagno: ${d >= 0 ? '+' : ''}${d.toFixed(0)} punti a stagione (${((d / (senza / ripetizioni)) * 100).toFixed(1)}%)`);
    process.exit(0);
  }

  const piazzamenti = [];
  const sommaPunti = new Map();
  for (let s = 1; s <= ripetizioni; s++) {
    const { esiti, posizioneApp } = simula({ roster, settings, seed: s, avversari: campo });
    piazzamenti.push(posizioneApp);
    for (const e of esiti) sommaPunti.set(e.nome, (sommaPunti.get(e.nome) || 0) + e.puntiVeri);
    const incompleti = esiti.filter((e) => !e.completa);
    console.log(`\nasta ${s}: l'app arriva ${posizioneApp}ª su 8`);
    for (const e of esiti) {
      console.log(
        `  ${String(esiti.indexOf(e) + 1).padStart(2)}. ${e.nome.padEnd(12)} ${String(e.puntiVeri).padStart(4)} pt stagione` +
          ` · ${String(Math.round(e.punti)).padStart(4)} col modello` +
          ` · ${String(e.spesi).padStart(3)} spesi · ${e.rosa}/25` +
          ` · big ${e.top} (${ROLES.map((r) => e.topPerRuolo[r]).join('/')})` +
          ` · ${ROLES.map((r) => `${r}${e.spesaPerRuolo[r]}`).join(' ')}`
      );
    }
    if (incompleti.length) console.log(`  ATTENZIONE: rose incomplete -> ${incompleti.map((e) => e.nome).join(', ')}`);
  }

  const media = piazzamenti.reduce((a, b) => a + b, 0) / piazzamenti.length;
  console.log(`\n=== ${ripetizioni} aste ===`);
  console.log(`piazzamento medio dell'app: ${media.toFixed(2)}ª su 8 · vittorie: ${piazzamenti.filter((x) => x === 1).length}/${ripetizioni}`);
  console.log('punti stagione medi della formazione titolare:');
  [...sommaPunti.entries()]
    .map(([n, v]) => [n, v / ripetizioni])
    .sort((a, b) => b[1] - a[1])
    .forEach(([n, v], i) => console.log(`  ${i + 1}. ${n.padEnd(12)} ${Math.round(v)}`));
}
