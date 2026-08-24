// Stima del prezzo a cui ogni giocatore verra' realmente pagato all'asta.
//
// Quando il listone porta i prezzi consigliati dai creators quelli sono il punto di
// partenza migliore: sono gia' calibrati sull'intero montepremi di una lega da dieci
// (la somma dei prezzi consigliati fa esattamente dieci volte il budget di squadra).
// Il compito del modello e' adattarli alla lega vera: piu' partecipanti significa piu'
// concorrenza sui top, e quindi prezzi piu' alti dove il giocatore e' unico.

import { ROLES, totalSlots } from './model.js';

/** Insieme dei giocatori che verranno davvero acquistati: gli altri restano sul mercato. */
function boughtSet(players, settings) {
  const n = Math.max(1, settings.participants || 10);
  const bought = new Set();
  for (const role of ROLES) {
    const need = (settings.slots[role] || 0) * n;
    players
      .filter((p) => p.role === role)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, need)
      .forEach((p) => bought.add(p.id));
  }
  return bought;
}

function normalizeShares(raw, bought) {
  let sum = 0;
  for (const [id, v] of raw) if (bought.has(id)) sum += v;
  const out = new Map();
  if (sum <= 0) return out;
  for (const [id, v] of raw) out.set(id, v / sum);
  return out;
}

/**
 * Prezzo atteso per ogni giocatore.
 * Due forme possibili della distribuzione: quella dei creators (prezzi o PMA del listone)
 * e quella dedotta dai punteggi. L'impostazione `priceSource` sceglie quale usare.
 */
export function expectedPrices(players, settings) {
  const n = Math.max(1, settings.participants || 10);
  const budget = Math.max(1, settings.budget || 500);
  const slotsTotal = totalSlots(settings);
  const bought = boughtSet(players, settings);

  // Ogni squadra deve comunque riempire tutti gli slot: un credito a testa e' incomprimibile.
  const discretionary = Math.max(0, (budget - slotsTotal) * n);
  const maxPrice = Math.max(1, budget - (slotsTotal - 1));

  // Forma "creators": il prezzo consigliato, o in mancanza la percentuale massima d'asta.
  const listoneRaw = new Map();
  for (const p of players) {
    const v = p.price ?? p.pma ?? p.fvm ?? p.quo ?? null;
    if (Number.isFinite(v) && v > 0) listoneRaw.set(p.id, v);
  }
  const hasListone = listoneRaw.size > players.length / 3;

  // Forma "modello": i crediti si distribuiscono in proporzione al punteggio, con un
  // esponente che rappresenta quanto il mercato impenna sui migliori.
  const gamma = Math.max(0.5, Math.min(3, settings.aggressiveness ?? 1.55));
  const modelRaw = new Map();
  for (const p of players) modelRaw.set(p.id, Math.pow(Math.max(p.score || 0, 0.01), gamma));

  const listoneShare = normalizeShares(listoneRaw, bought);
  const modelShare = normalizeShares(modelRaw, bought);

  const source = settings.priceSource || 'blend';
  const useListone = hasListone && source !== 'model';
  const useModel = !hasListone || source !== 'listone';

  // Correzione per la dimensione della lega: i prezzi dei creators sono tarati su dieci
  // squadre, con piu' partecipanti la concorrenza si concentra sui giocatori unici.
  const tilt = 1 + 0.04 * (n - 10);

  const combined = new Map();
  for (const p of players) {
    const parts = [];
    if (useListone && listoneShare.has(p.id)) parts.push(Math.pow(listoneShare.get(p.id), tilt));
    if (useModel && modelShare.has(p.id)) parts.push(modelShare.get(p.id));
    if (!parts.length) {
      combined.set(p.id, 0);
      continue;
    }
    combined.set(p.id, parts.reduce((a, b) => a + b, 0) / parts.length);
  }

  let total = 0;
  for (const [id, v] of combined) if (bought.has(id)) total += v;

  const out = new Map();
  for (const p of players) {
    const share = total > 0 ? combined.get(p.id) / total : 0;
    const price = 1 + discretionary * share;
    out.set(p.id, Math.min(maxPrice, Math.max(1, Math.round(price))));
  }
  return out;
}

/** Applica i prezzi attesi ai giocatori, restituendo nuovi oggetti con `expectedPrice`. */
export function withExpectedPrices(players, settings) {
  const prices = expectedPrices(players, settings);
  return players.map((p) => ({ ...p, expectedPrice: prices.get(p.id) ?? 1 }));
}
