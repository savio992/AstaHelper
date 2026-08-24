// Stima del prezzo a cui ogni giocatore verra' realmente pagato all'asta.
// E' il pezzo che rende il piano realistico: con 8 partecipanti i top costano molto
// piu' che con 12, a parita' di listone.

import { ROLES, totalSlots } from './model.js';

const NEG = -1e9;

/**
 * Prezzo atteso per ogni giocatore.
 * Modello: solo i primi (partecipanti x slot) giocatori per ruolo vengono davvero comprati;
 * i crediti discrezionali del torneo si distribuiscono fra loro in proporzione a score^aggressivita'.
 */
export function expectedPrices(players, settings) {
  const n = Math.max(1, settings.participants || 10);
  const budget = Math.max(1, settings.budget || 500);
  const slotsTotal = totalSlots(settings);
  const gamma = Math.max(0.5, Math.min(3, settings.aggressiveness ?? 1.55));

  // Ogni squadra deve comunque riempire tutti gli slot: 1 credito a testa e' incomprimibile.
  const discretionary = Math.max(0, (budget - slotsTotal) * n);
  const maxPrice = Math.max(1, budget - (slotsTotal - 1));

  // Insieme dei giocatori che verranno effettivamente acquistati.
  const bought = new Set();
  for (const role of ROLES) {
    const need = (settings.slots[role] || 0) * n;
    players
      .filter((p) => p.role === role)
      .sort((a, b) => b.score - a.score)
      .slice(0, need)
      .forEach((p) => bought.add(p.id));
  }

  const weights = new Map();
  let weightSum = 0;
  for (const p of players) {
    if (!bought.has(p.id)) continue;
    const w = Math.pow(Math.max(p.score, 0.01), gamma);
    weights.set(p.id, w);
    weightSum += w;
  }

  // Prezzi da listone riscalati al montepremi reale della lega.
  const listoneRaw = new Map();
  let listoneSum = 0;
  for (const p of players) {
    const v = p.price ?? p.fvm ?? null;
    if (v === null || !Number.isFinite(v)) continue;
    listoneRaw.set(p.id, v);
    if (bought.has(p.id)) listoneSum += v;
  }
  const listoneScale = listoneSum > 0 ? (budget * n) / listoneSum : 1;

  const source = settings.priceSource || 'blend';
  const out = new Map();
  for (const p of players) {
    const w = weights.get(p.id);
    const model = w && weightSum > 0 ? 1 + (discretionary * w) / weightSum : 1;
    const listone = listoneRaw.has(p.id) ? listoneRaw.get(p.id) * listoneScale : null;

    let price;
    if (source === 'listone' && listone !== null) price = listone;
    else if (source === 'model' || listone === null) price = model;
    else price = 0.5 * model + 0.5 * listone;

    out.set(p.id, clampPrice(price, maxPrice));
  }
  return out;
}

function clampPrice(v, maxPrice) {
  if (!Number.isFinite(v)) return 1;
  return Math.min(maxPrice, Math.max(1, Math.round(v)));
}

/** Applica i prezzi attesi ai giocatori, restituendo nuovi oggetti con `expectedPrice`. */
export function withExpectedPrices(players, settings) {
  const prices = expectedPrices(players, settings);
  return players.map((p) => ({ ...p, expectedPrice: prices.get(p.id) ?? 1 }));
}

export { NEG };
