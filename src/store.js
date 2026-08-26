// Stato dell'applicazione e persistenza locale.
// Tutto vive nel browser: nessun server, nessun dato che esce dal telefono.

import { defaultSettings, inferTierOrder, annotateTierPct, annotatePmaShare, annotatePriceShare, ROLES } from './domain/model.js';
import { mergeSources } from './domain/csv.js';
import { valuePlayers, markTopPlayers } from './domain/valuation.js';
import { withExpectedPrices } from './domain/market.js';
import { optimizeRoster, CONFIG_SOLUTORE } from './domain/optimizer.js';
import { aggregateForm, applyForm, matchCount } from './domain/form.js';
import { statoMercato, applyPrezziLive, avversari, normalizeTaken } from './domain/mercato.js';

const KEY = 'astahelper:v1';

export const state = {
  settings: defaultSettings(),
  // Un elemento per creator importato: { name, players }. Il listone di lavoro e' la loro unione.
  sources: [],
  roster: [], // listone unito, dati grezzi
  // Rendimento nelle giornate gia' giocate: { entries, giornate, fileName, abbinati }
  formData: null,
  players: [], // listone con punteggi e prezzi attesi (derivato)
  importMeta: null, // { headers, mapping, rows, warnings, fileName }
  auction: {
    owned: {}, // id -> prezzo pagato da me
    taken: {}, // id -> { price, by } : prezzo pagato da altri e da quale squadra
    log: [], // { id, kind, price, by, at }
    // Scelte imposte a mano: chi voglio in rosa comunque, e chi non voglio mai vedere nel piano.
    bloccati: {},
    esclusi: {},
  },
  // Il conto del mercato: slot residui, crediti ancora in circolazione, inflazione osservata.
  mercato: null,
  // Il tabellone degli avversari, derivato dal registro delle assegnazioni.
  tabellone: null,
  plan: null,
  // Il piano precedente, per poter raccontare cosa e' cambiato dopo l'ultima assegnazione.
  prevPlan: null,
  // L'ultima correzione fatta a mano al piano, per poterne raccontare l'effetto.
  ultimaModifica: null,
  ui: {
    tab: 'asta',
    query: '',
    roleFilter: 'ALL',
    selectedId: null,
    listQuery: '',
    listRole: 'ALL',
    onlyPlan: false,
    onlyAvailable: true,
  },
};

const listeners = new Set();
// Le viste tengono in memoria dei calcoli costosi (scheda d'asta, piano del reparto, elenco
// incollato). Sono fuori dallo stato, quindi un azzeramento non li toccherebbe e resterebbero
// a schermo giocatori di un listone appena cancellato.
const ripuliture = new Set();

/** Registra una ripulitura da eseguire quando si cancella tutto. */
export function onReset(fn) {
  ripuliture.add(fn);
  return () => ripuliture.delete(fn);
}
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function notify() {
  for (const fn of listeners) fn();
}

/** Tutto quello che vale la pena conservare, in una forma sola: la usano la memoria e il backup. */
function istantanea() {
  return {
    settings: state.settings,
    sources: state.sources,
    formData: state.formData,
    auction: state.auction,
    importMeta: state.importMeta ? { headers: state.importMeta.headers, mapping: state.importMeta.mapping, fileName: state.importMeta.fileName, count: state.roster.length } : null,
    ui: { tab: state.ui.tab },
  };
}

/**
 * Rimette in piedi lo stato da un'istantanea.
 *
 * Sta in una funzione sola perche' la memoria del telefono e un file di backup sono la stessa
 * cosa scritta in due posti: se le due strade divergessero, un'asta ripresa da file non
 * sarebbe la stessa asta ripresa dal telefono.
 */
function applica(data) {
  state.settings = { ...defaultSettings(), ...(data.settings || {}) };
  state.settings.slots = { ...defaultSettings().slots, ...(data.settings?.slots || {}) };
  state.settings.starters = { ...defaultSettings().starters, ...(data.settings?.starters || {}) };
  state.settings.tierOrder = { ...defaultSettings().tierOrder, ...(data.settings?.tierOrder || {}) };
  state.settings.roleBudget = { ...defaultSettings().roleBudget, ...(data.settings?.roleBudget || {}) };
  state.settings.minTop = { ...defaultSettings().minTop, ...(data.settings?.minTop || {}) };
  state.sources = data.sources || (data.roster ? [{ name: 'listone', players: data.roster }] : []);
  state.roster = rebuildRoster();
  state.auction = { owned: {}, taken: {}, log: [], bloccati: {}, esclusi: {}, ...(data.auction || {}) };
  state.importMeta = data.importMeta || null;
  state.formData = data.formData || null;
  recompute();
}

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(istantanea()));
  } catch (err) {
    console.warn('Salvataggio non riuscito', err);
  }
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    applica(data);
    if (data.ui?.tab) state.ui.tab = data.ui.tab;
    return true;
  } catch (err) {
    console.warn('Caricamento non riuscito', err);
    return false;
  }
}

const FORMATO = 1;

/**
 * L'asta in un file.
 *
 * La memoria del browser non e' un posto sicuro dove tenere una serata: basta una finestra in
 * incognito, un "cancella dati dei siti", un telefono cambiato. E non c'e' altro modo di
 * passare l'asta dal telefono al computer. Il file contiene esattamente quello che contiene la
 * memoria — listone compreso, altrimenti riaprendolo altrove ci sarebbe un'asta senza giocatori.
 */
export function esporta() {
  return JSON.stringify({ app: 'astahelper', formato: FORMATO, salvatoIl: new Date().toISOString(), ...istantanea() }, null, 1);
}

/** Nome del file: leggibile e ordinabile, cosi' due backup della stessa sera non si confondono. */
export function nomeBackup() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `astahelper-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

/**
 * Ripristina un'asta da un file.
 *
 * Rifiuta prima di toccare qualsiasi cosa: importare un file sbagliato in mezzo a un'asta e
 * ritrovarsi senza rosa sarebbe il danno peggiore che questa funzione possa fare, e sarebbe un
 * danno causato proprio dalla funzione che dovrebbe proteggerla.
 */
export function importa(testo) {
  let data;
  try {
    data = JSON.parse(testo);
  } catch {
    return { ok: false, motivo: 'Non e\' un file di backup: non si legge come JSON.' };
  }
  if (!data || typeof data !== 'object') return { ok: false, motivo: 'Il file e\' vuoto o non ha la forma giusta.' };
  if (!data.settings || !data.auction) {
    return { ok: false, motivo: 'Manca l\'asta o la configurazione: questo file non viene da AstaHelper.' };
  }
  if (data.formato && data.formato > FORMATO) {
    return { ok: false, motivo: 'Questo backup viene da una versione piu' + "'" + ' recente dell\'app.' };
  }
  try {
    applica(data);
    rebuildPlan({ ricorda: false });
    save();
    notify();
    const presi = Object.keys(state.auction.owned || {}).length;
    return { ok: true, giocatori: state.players.length, presi, salvatoIl: data.salvatoIl || null };
  } catch (err) {
    console.warn('Ripristino non riuscito', err);
    return { ok: false, motivo: 'Il file si legge ma non si riesce a ricostruire l\'asta.' };
  }
}

export function resetAll() {
  state.prevPlan = null;
  try {
    localStorage.removeItem(KEY);
  } catch (err) {
    console.warn('Cancellazione non riuscita', err);
  }
  state.settings = defaultSettings();
  state.sources = [];
  state.roster = [];
  state.formData = null;
  state.players = [];
  state.importMeta = null;
  state.auction = { owned: {}, taken: {}, log: [], bloccati: {}, esclusi: {} };
  state.mercato = null;
  state.tabellone = null;
  state.plan = null;
  state.ultimaModifica = null;
  state.ui = { ...state.ui, tab: 'listone', query: '', listQuery: '', selectedId: null, bidPrice: null, chiediSquadra: null, prezzoAltri: null, roleFilter: 'ALL', listRole: 'ALL' };
  for (const fn of ripuliture) {
    try {
      fn();
    } catch (err) {
      console.warn('Ripulitura non riuscita', err);
    }
  }
  notify();
}

/** Ricalcola punteggi e prezzi attesi: da fare a ogni cambio di listone o impostazioni. */
export function recompute() {
  if (!state.roster.length) {
    state.players = [];
    state.plan = null;
    return;
  }
  // Il rendimento delle giornate gia' giocate corregge le proiezioni prima di ogni altro calcolo.
  const base = state.formData
    ? applyForm(state.roster, new Map(state.formData.entries), state.formData.giornate)
    : state.roster;
  const valued = valuePlayers(base, state.settings);
  const conPrezzi = withExpectedPrices(valued, state.settings);

  // Il mercato corregge le stime statiche del listone con quello che l'asta ha gia' mostrato:
  // quanti giocatori restano davvero da assegnare e quanti crediti restano per comprarli.
  state.mercato = statoMercato({
    settings: state.settings,
    players: conPrezzi,
    owned: ownedMap(),
    taken: takenMap(),
  });
  const live = applyPrezziLive(conPrezzi, state.settings, state.mercato);
  state.players = markTopPlayers(live, state.settings);
  state.tabellone = avversari({
    settings: state.settings,
    players: state.players,
    owned: ownedMap(),
    taken: takenMap(),
  });
}

/** Carica i voti delle giornate gia' giocate. */
export function setForm({ rows, mapping, fileName, giornate }) {
  const { form, giornate: dedotte } = aggregateForm(rows, mapping);
  const n = giornate || dedotte || 1;
  state.formData = {
    entries: [...form.entries()],
    giornate: n,
    fileName,
    abbinati: matchCount(state.roster, form),
  };
  recompute();
  rebuildPlan();
  save();
  notify();
}

export function clearForm() {
  state.formData = null;
  recompute();
  rebuildPlan();
  save();
  notify();
}

export function ownedMap() {
  return new Map(Object.entries(state.auction.owned).map(([id, price]) => [id, Number(price)]));
}

/**
 * Chi il piano non puo' scegliere: chi e' andato agli avversari e chi ho scartato a mano.
 * Le esclusioni valgono solo per me e non entrano nel conto del mercato, che misura la lega.
 */
export function unavailableSet() {
  return new Set([...Object.keys(state.auction.taken), ...Object.keys(state.auction.esclusi || {})]);
}

/** La lista scelta a mano, che in modalita' "scelgo io" e' la rosa vera e propria. */
export function listaMia() {
  return obbligatiSet();
}

/** I giocatori che voglio in rosa comunque: il piano si ricalcola attorno a loro. */
export function obbligatiSet() {
  return new Set(Object.keys(state.auction.bloccati || {}).filter((id) => !state.auction.owned[id] && !state.auction.taken[id]));
}

/**
 * Applica una correzione al piano e la tiene solo se il piano regge.
 *
 * Scartare abbastanza giocatori di un ruolo puo' rendere la rosa impossibile da chiudere, e
 * lasciare l'utente davanti a un piano rotto senza spiegazione sarebbe il peggiore dei modi di
 * dirglielo: meglio rifiutare la correzione e dire perche'.
 */
function correggiPiano(id, azione, applica) {
  const prima = state.plan;
  const bloccatiPrima = { ...state.auction.bloccati };
  const esclusiPrima = { ...state.auction.esclusi };
  applica();
  const nuovo = rebuildPlan({ ricorda: true });
  if (!nuovo?.ok) {
    state.auction.bloccati = bloccatiPrima;
    state.auction.esclusi = esclusiPrima;
    state.plan = prima;
    state.prevPlan = null;
    state.ultimaModifica = { id, azione, rifiutata: true, motivo: nuovo?.reason || 'Il piano non si chiude piu\'.', at: Date.now() };
    notify();
    return false;
  }
  state.ultimaModifica = { id, azione, rifiutata: false, at: Date.now() };
  save();
  notify();
  return true;
}

/** Voglio questo giocatore, qualunque cosa dica il solutore. */
export function blocca(id) {
  if (state.auction.taken[id]) return false;
  return correggiPiano(id, 'blocca', () => {
    state.auction.bloccati[id] = true;
    delete state.auction.esclusi[id];
  });
}

/** Questo non lo voglio mai vedere nel piano. */
export function scarta(id) {
  return correggiPiano(id, 'scarta', () => {
    state.auction.esclusi[id] = true;
    delete state.auction.bloccati[id];
  });
}

/** Torna a lasciar decidere al solutore. */
export function liberaScelta(id) {
  return correggiPiano(id, 'libera', () => {
    delete state.auction.bloccati[id];
    delete state.auction.esclusi[id];
  });
}

/**
 * Il contesto su cui calcolare i consigli per un giocatore.
 *
 * Se l'ho scartato, i numeri vanno calcolati sul mondo in cui non l'ho fatto: altrimenti
 * l'unica risposta possibile e' "il tuo piano non ha budget per lui", che e' vera per
 * costruzione e non serve a niente. La domanda sensata su uno scartato e' quanto varrebbe
 * cambiando idea.
 */
export function contestoConsiglio(id) {
  const escluso = statoScelta(id) === 'escluso';
  const unavailable = unavailableSet();
  if (escluso) unavailable.delete(id);
  return { escluso, unavailable };
}

export function statoScelta(id) {
  if (state.auction.bloccati?.[id]) return 'bloccato';
  if (state.auction.esclusi?.[id]) return 'escluso';
  return null;
}

/** Le assegnazioni agli avversari, con prezzo e squadra quando registrati. */
export function takenMap() {
  return new Map(
    Object.entries(state.auction.taken).map(([id, v]) => [
      id,
      v && typeof v === 'object' ? { price: Number(v.price) || 0, by: v.by ?? null } : { price: Number(v) || 0, by: null },
    ])
  );
}

export function playerById(id) {
  return state.players.find((p) => p.id === id) || null;
}

/** Rigenera il piano con lo stato d'asta corrente. */
export function rebuildPlan(opts = {}) {
  if (!state.players.length) {
    state.plan = null;
    return null;
  }
  if (opts.ricorda !== false && state.plan?.ok) state.prevPlan = state.plan;
  state.plan = optimizeRoster({
    players: state.players,
    settings: state.settings,
    owned: ownedMap(),
    unavailable: unavailableSet(),
    obbligati: obbligatiSet(),
    // La stessa configurazione dei consigli, e non una scelta a parte: se il piano fosse
    // calcolato meglio dell'offerta massima, l'assistente consiglierebbe di pagare un
    // giocatore che il piano non vuole.
    ...CONFIG_SOLUTORE,
    ...opts,
  });
  return state.plan;
}

/**
 * Il piano com'era prima dell'ultima assegnazione.
 *
 * Serve a raccontare cosa e' appena successo. Normalmente basta `prevPlan`, che resta in
 * memoria, ma quello si perde a ogni riapertura dell'app — e riaprire l'app in mezzo a
 * un'asta capita. Il registro delle assegnazioni invece e' salvato: si rigioca senza l'ultima
 * voce e si riottiene esattamente il piano di prima, al costo di un'ottimizzazione.
 */
export function pianoPrimaDellUltimaMossa() {
  const log = state.auction.log;
  if (!log.length || !state.players.length) return null;
  const owned = {};
  const taken = {};
  for (const voce of log.slice(0, -1)) {
    delete owned[voce.id];
    delete taken[voce.id];
    if (voce.kind === 'mine') owned[voce.id] = voce.price;
    else if (voce.kind === 'other') taken[voce.id] = voce.price;
  }
  return optimizeRoster({
    players: state.players,
    settings: state.settings,
    owned: new Map(Object.entries(owned).map(([id, v]) => [id, Number(v)])),
    unavailable: new Set(Object.keys(taken)),
    ...CONFIG_SOLUTORE,
  });
}

/** Unisce le fonti importate in un unico listone e riordina le fasce. */
function rebuildRoster() {
  const lists = state.sources.map((s) => annotatePriceShare(annotatePmaShare(annotateTierPct(s.players))));
  const roster = mergeSources(lists);
  for (const role of ROLES) state.settings.tierOrder[role] = inferTierOrder(roster, role);
  return roster;
}

/** Aggiunge un creator al listone, o ne sostituisce uno con lo stesso nome. */
export function addSource({ name, players, headers, mapping, warnings, fileName }) {
  const idx = state.sources.findIndex((s) => s.name === name);
  const entry = { name, players };
  if (idx >= 0) state.sources[idx] = entry;
  else state.sources.push(entry);
  state.roster = rebuildRoster();
  state.importMeta = { headers, mapping, warnings, fileName, count: state.roster.length };
  recompute();
  rebuildPlan();
  save();
  notify();
}

export function removeSource(name) {
  state.sources = state.sources.filter((s) => s.name !== name);
  state.roster = state.sources.length ? rebuildRoster() : [];
  recompute();
  rebuildPlan();
  save();
  notify();
}

// --- Azioni d'asta -------------------------------------------------------

export function assign(id, kind, price, by = null) {
  const p = Math.max(0, Math.round(Number(price) || 0));
  const squadra = Number.isInteger(by) && by > 0 ? by : null;
  delete state.auction.owned[id];
  delete state.auction.taken[id];
  if (kind === 'mine') state.auction.owned[id] = p;
  else if (kind === 'other') state.auction.taken[id] = { price: p, by: squadra };
  delete state.auction.bloccati[id];
  state.ultimaModifica = null;
  state.auction.log.push({ id, kind, price: p, by: squadra, at: Date.now() });
  // Ogni assegnazione cambia quanti giocatori e quanti crediti restano: i prezzi attesi
  // vanno rifatti prima del piano, altrimenti il piano ottimizza su un mercato scaduto.
  recompute();
  rebuildPlan();
  save();
  notify();
}

/**
 * Registra molte aggiudicazioni in un colpo solo.
 *
 * Serve quando si incolla l'elenco dei venduti preso dal sito dell'asta: farlo con `assign` una
 * riga alla volta rifarebbe il piano duecento volte, e ci vorrebbero minuti. Qui si scrive tutto
 * il registro e si ricalcola una volta.
 */
export function assegnaMolti(voci) {
  for (const { id, kind = 'other', price = 0, by = null } of voci) {
    const p = Math.max(0, Math.round(Number(price) || 0));
    const squadra = Number.isInteger(by) && by > 0 ? by : null;
    delete state.auction.owned[id];
    delete state.auction.taken[id];
    if (kind === 'mine') state.auction.owned[id] = p;
    else state.auction.taken[id] = { price: p, by: squadra };
    delete state.auction.bloccati[id];
    state.auction.log.push({ id, kind, price: p, by: squadra, at: Date.now() });
  }
  recompute();
  rebuildPlan();
  save();
  notify();
  return voci.length;
}

export function release(id) {
  delete state.auction.owned[id];
  delete state.auction.taken[id];
  state.auction.log.push({ id, kind: 'release', price: 0, by: null, at: Date.now() });
  recompute();
  rebuildPlan();
  save();
  notify();
}

/**
 * Cosa cambierebbe importando le rose esportate dalla piattaforma.
 *
 * Il file e' la verita' su cosa e' stato assegnato, quindi l'import e' una sincronizzazione e non
 * un accodamento: puo' anche togliere. Per questo il conto si fa prima e si mostra — cancellare
 * senza dirlo assegnazioni segnate a mano sarebbe il danno peggiore che questa funzione possa
 * fare, ed e' proprio la funzione che dovrebbe rendere il tabellone piu' affidabile.
 *
 * `indicePerSquadra`: Map dal nome della squadra nel file al suo posto in `settings.squadre`,
 * dove lo zero sono io.
 */
export function confrontaRose(righe, indicePerSquadra) {
  const owned = {};
  const taken = {};
  const ignorati = [];

  for (const r of righe || []) {
    if (r.esito !== 'trovato' || !r.player) {
      ignorati.push({ nome: r.nome, motivo: r.esito });
      continue;
    }
    const posto = indicePerSquadra.get(r.squadra);
    if (posto === undefined) {
      ignorati.push({ nome: r.nome, motivo: 'squadra sconosciuta', squadra: r.squadra });
      continue;
    }
    const prezzo = Math.max(0, Math.round(Number(r.prezzo) || 0));
    if (posto === 0) owned[r.player.id] = prezzo;
    else taken[r.player.id] = { price: prezzo, by: posto };
  }

  const nome = (id) => state.players.find((p) => p.id === id)?.name || id;
  const oraOwned = state.auction.owned || {};
  const oraTaken = normalizeTaken(state.auction.taken || {});
  const nuovi = [];
  const prezzi = [];
  const tolti = [];

  for (const [id, prezzo] of Object.entries(owned)) {
    if (oraOwned[id] === undefined) nuovi.push({ id, nome: nome(id), prezzo, mio: true });
    else if (Number(oraOwned[id]) !== prezzo) prezzi.push({ id, nome: nome(id), da: Number(oraOwned[id]), a: prezzo });
  }
  for (const [id, v] of Object.entries(taken)) {
    const prima = oraTaken.get(id);
    if (!prima) nuovi.push({ id, nome: nome(id), prezzo: v.price, mio: false });
    else if (prima.price !== v.price || prima.by !== v.by) prezzi.push({ id, nome: nome(id), da: prima.price, a: v.price });
  }
  for (const id of Object.keys(oraOwned)) if (owned[id] === undefined) tolti.push({ id, nome: nome(id), mio: true });
  for (const id of oraTaken.keys()) if (!taken[id]) tolti.push({ id, nome: nome(id), mio: false });

  return { owned, taken, nuovi, prezzi, tolti, ignorati, invariato: !nuovi.length && !prezzi.length && !tolti.length };
}

/** Applica il confronto gia' calcolato. Si passa quello, non le righe: cosi' si applica esattamente cio' che e' stato mostrato. */
export function applicaRose(confronto) {
  if (!confronto) return false;
  state.auction.owned = { ...confronto.owned };
  state.auction.taken = Object.fromEntries(Object.entries(confronto.taken).map(([id, v]) => [id, { ...v }]));
  // Un giocatore ormai assegnato non puo' restare un obiettivo imposto.
  for (const id of [...Object.keys(confronto.owned), ...Object.keys(confronto.taken)]) delete state.auction.bloccati[id];
  // Il registro ridiventa il racconto di quello che dice il file, cosi' l'annulla resta coerente
  // con cio' che si vede invece di riportare a uno stato che non esiste piu' da nessuna parte.
  const at = Date.now();
  state.auction.log = [
    ...Object.entries(confronto.owned).map(([id, price]) => ({ id, kind: 'mine', price, by: null, at })),
    ...Object.entries(confronto.taken).map(([id, v]) => ({ id, kind: 'other', price: v.price, by: v.by, at })),
  ];
  state.prevPlan = null;
  state.ultimaModifica = null;
  recompute();
  rebuildPlan({ ricorda: false });
  save();
  notify();
  return true;
}

/**
 * Dire a chi e' andato un giocatore gia' segnato come perso.
 *
 * Non e' un'assegnazione nuova: era gia' fuori, il prezzo e' quello di prima e il piano non
 * cambia di una virgola — l'attribuzione non entra in nessuna valutazione. Cambia solo il
 * tabellone degli avversari, e con lui fin dove possono spingersi. Per questo non passa da
 * `assign`: rivalutare il listone e rifare il piano per un'informazione che non li tocca
 * costerebbe un paio di secondi in mezzo all'asta, e non e' il momento.
 */
export function attribuisci(id, indice) {
  const voce = state.auction.taken[id];
  if (!voce) return false;
  const squadra = Number.isInteger(indice) && indice > 0 ? indice : null;
  const prezzo = typeof voce === 'object' ? Number(voce.price) || 0 : Number(voce) || 0;
  state.auction.taken[id] = { price: prezzo, by: squadra };
  for (let i = state.auction.log.length - 1; i >= 0; i--) {
    if (state.auction.log[i].id === id) {
      state.auction.log[i] = { ...state.auction.log[i], by: squadra };
      break;
    }
  }
  state.tabellone = avversari({
    settings: state.settings,
    players: state.players,
    owned: ownedMap(),
    taken: takenMap(),
  });
  save();
  notify();
  return true;
}

export function undo() {
  const log = state.auction.log;
  if (!log.length) return;
  log.pop();
  // Ricostruisce lo stato rigiocando il registro dall'inizio: sempre coerente.
  state.auction.owned = {};
  state.auction.taken = {};
  for (const entry of log) {
    delete state.auction.owned[entry.id];
    delete state.auction.taken[entry.id];
    if (entry.kind === 'mine') state.auction.owned[entry.id] = entry.price;
    else if (entry.kind === 'other') state.auction.taken[entry.id] = { price: entry.price, by: entry.by ?? null };
  }
  recompute();
  rebuildPlan();
  save();
  notify();
}

/**
 * I nomi delle squadre avversarie non entrano in nessun calcolo: servono solo a leggere
 * il tabellone. Passare da `updateSettings` significherebbe rivalutare il listone e rifare
 * il piano — un paio di secondi — per aver scritto una lettera.
 */
export function rinominaSquadre(squadre) {
  state.settings.squadre = [...squadre];
  save();
  notify();
}

export function updateSettings(patch) {
  Object.assign(state.settings, patch);
  recompute();
  rebuildPlan();
  save();
  notify();
}

export function spentTotal() {
  return Object.values(state.auction.owned).reduce((a, b) => a + Number(b), 0);
}

export function creditsLeft() {
  return (state.settings.budget || 500) - spentTotal();
}
