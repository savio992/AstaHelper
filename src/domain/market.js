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

/**
 * Sceglie il segnale di mercato e lo restituisce in un'unica unita' di misura.
 *
 * Le fonti disponibili non sono confrontabili fra loro: PMA e' una quota (0,03), il prezzo
 * consigliato e' in crediti (155). Mescolarle nella stessa mappa fa esplodere le quote di chi
 * ha solo il prezzo. Si sceglie quindi una scala sola e si convertono gli altri valori in
 * quella, usando il rapporto osservato sui giocatori che hanno entrambi i dati.
 *
 * Ordine di attendibilita': PMA, il prezzo medio effettivamente pagato nelle altre aste, e'
 * una rilevazione; il prezzo consigliato dal creator e' una valutazione; la quotazione
 * ufficiale e' solo un ordine di grandezza.
 */
export function marketSignal(players) {
  const out = new Map();
  const hasPma = players.filter((p) => Number.isFinite(p.pmaShare) && p.pmaShare > 0);

  if (hasPma.length > players.length / 3) {
    // Rapporto mediano fra quota di mercato e prezzo consigliato, per convertire
    // i giocatori che hanno solo il secondo senza cambiare scala.
    const ratios = hasPma
      .filter((p) => Number.isFinite(p.price) && p.price > 0)
      .map((p) => p.pmaShare / p.price)
      .sort((a, b) => a - b);
    const ratio = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
    for (const p of players) {
      if (Number.isFinite(p.pmaShare) && p.pmaShare > 0) out.set(p.id, p.pmaShare);
      else if (ratio && Number.isFinite(p.price) && p.price > 0) out.set(p.id, p.price * ratio);
    }
    return out;
  }

  for (const p of players) {
    const v = p.price ?? p.fvm ?? p.quo ?? null;
    if (Number.isFinite(v) && v > 0) out.set(p.id, v);
  }
  return out;
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

  const listoneRaw = marketSignal(players);
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

  // Nessuna correzione arbitraria per la dimensione della lega: l'effetto vero e' gia' nel
  // modello, perche' con meno squadre si comprano meno giocatori e le quote si ridistribuiscono
  // su un insieme piu' ristretto e migliore. Un esponente in piu' conterebbe due volte lo stesso
  // fenomeno, e i dati a disposizione non permettono di calibrarlo: il confronto fra i campioni
  // di due creators e' confuso dalla diversa copertura del listone.
  const combined = new Map();
  for (const p of players) {
    const parts = [];
    if (useListone && listoneShare.has(p.id)) parts.push(listoneShare.get(p.id));
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

/**
 * Applica i prezzi attesi ai giocatori.
 *
 * Aggiunge anche `edge`: la differenza fra quanto il creator dice che il giocatore vale
 * (colonna Prezzo) e quanto il mercato lo paga davvero (PMA). Positivo significa che il
 * creator lo valuta piu' di quanto costa, ed e' li' che si fanno gli affari all'asta.
 */
export function withExpectedPrices(players, settings) {
  const prices = expectedPrices(players, settings);
  // Il prezzo consigliato e' tarato su una lega da dieci: va riportato alla lega vera
  // prima di confrontarlo con il prezzo atteso.
  let sumPrice = 0;
  let sumExpected = 0;
  for (const p of players) {
    if (!Number.isFinite(p.price)) continue;
    sumPrice += p.price;
    sumExpected += prices.get(p.id) ?? 0;
  }
  const scale = sumPrice > 0 ? sumExpected / sumPrice : 1;

  return players.map((p) => {
    const expectedPrice = prices.get(p.id) ?? 1;
    const consigliato = Number.isFinite(p.price) ? p.price * scale : null;
    return {
      ...p,
      expectedPrice,
      consigliato: consigliato === null ? null : Math.round(consigliato),
      edge: consigliato === null ? null : Math.round(consigliato - expectedPrice),
    };
  });
}
