// Stato dell'applicazione e persistenza locale.
// Tutto vive nel browser: nessun server, nessun dato che esce dal telefono.

import { defaultSettings, inferTierOrder, annotateTierPct, annotatePmaShare, annotatePriceShare, ROLES } from './domain/model.js';
import { mergeSources } from './domain/csv.js';
import { valuePlayers, markTopPlayers } from './domain/valuation.js';
import { withExpectedPrices } from './domain/market.js';
import { optimizeRoster } from './domain/optimizer.js';
import { aggregateForm, applyForm, matchCount } from './domain/form.js';
import { statoMercato, applyPrezziLive, avversari } from './domain/mercato.js';

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

export function save() {
  try {
    const payload = {
      settings: state.settings,
      sources: state.sources,
      formData: state.formData,
      auction: state.auction,
      importMeta: state.importMeta ? { headers: state.importMeta.headers, mapping: state.importMeta.mapping, fileName: state.importMeta.fileName, count: state.roster.length } : null,
      ui: { tab: state.ui.tab },
    };
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('Salvataggio non riuscito', err);
  }
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
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
    if (data.ui?.tab) state.ui.tab = data.ui.tab;
    recompute();
    return true;
  } catch (err) {
    console.warn('Caricamento non riuscito', err);
    return false;
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
    // Il piano che si guarda vale qualche decimo di secondo in piu': senza ripartenze il
    // solutore resta bloccato su una scelta cara che sbarra la strada a un blocco migliore.
    ripartenze: 4,
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
    ripartenze: 4,
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
