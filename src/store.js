// Stato dell'applicazione e persistenza locale.
// Tutto vive nel browser: nessun server, nessun dato che esce dal telefono.

import { defaultSettings, inferTierOrder, annotateTierPct, ROLES } from './domain/model.js';
import { mergeSources } from './domain/csv.js';
import { valuePlayers } from './domain/valuation.js';
import { withExpectedPrices } from './domain/market.js';
import { optimizeRoster } from './domain/optimizer.js';

const KEY = 'astahelper:v1';

export const state = {
  settings: defaultSettings(),
  // Un elemento per creator importato: { name, players }. Il listone di lavoro e' la loro unione.
  sources: [],
  roster: [], // listone unito, dati grezzi
  players: [], // listone con punteggi e prezzi attesi (derivato)
  importMeta: null, // { headers, mapping, rows, warnings, fileName }
  auction: {
    owned: {}, // id -> prezzo pagato da me
    taken: {}, // id -> prezzo pagato da altri
    log: [], // { id, kind, price, at }
  },
  plan: null,
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
    state.sources = data.sources || (data.roster ? [{ name: 'listone', players: data.roster }] : []);
    state.roster = rebuildRoster();
    state.auction = { owned: {}, taken: {}, log: [], ...(data.auction || {}) };
    state.importMeta = data.importMeta || null;
    if (data.ui?.tab) state.ui.tab = data.ui.tab;
    recompute();
    return true;
  } catch (err) {
    console.warn('Caricamento non riuscito', err);
    return false;
  }
}

export function resetAll() {
  localStorage.removeItem(KEY);
  state.settings = defaultSettings();
  state.sources = [];
  state.roster = [];
  state.players = [];
  state.importMeta = null;
  state.auction = { owned: {}, taken: {}, log: [] };
  state.plan = null;
  notify();
}

/** Ricalcola punteggi e prezzi attesi: da fare a ogni cambio di listone o impostazioni. */
export function recompute() {
  if (!state.roster.length) {
    state.players = [];
    state.plan = null;
    return;
  }
  const valued = valuePlayers(state.roster, state.settings);
  state.players = withExpectedPrices(valued, state.settings);
}

export function ownedMap() {
  return new Map(Object.entries(state.auction.owned).map(([id, price]) => [id, Number(price)]));
}

export function unavailableSet() {
  return new Set(Object.keys(state.auction.taken));
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
  state.plan = optimizeRoster({
    players: state.players,
    settings: state.settings,
    owned: ownedMap(),
    unavailable: unavailableSet(),
    ...opts,
  });
  return state.plan;
}

/** Unisce le fonti importate in un unico listone e riordina le fasce. */
function rebuildRoster() {
  const lists = state.sources.map((s) => annotateTierPct(s.players));
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

export function assign(id, kind, price) {
  const p = Math.max(0, Math.round(Number(price) || 0));
  delete state.auction.owned[id];
  delete state.auction.taken[id];
  if (kind === 'mine') state.auction.owned[id] = p;
  else if (kind === 'other') state.auction.taken[id] = p;
  state.auction.log.push({ id, kind, price: p, at: Date.now() });
  rebuildPlan();
  save();
  notify();
}

export function release(id) {
  delete state.auction.owned[id];
  delete state.auction.taken[id];
  state.auction.log.push({ id, kind: 'release', price: 0, at: Date.now() });
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
    else if (entry.kind === 'other') state.auction.taken[entry.id] = entry.price;
  }
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
