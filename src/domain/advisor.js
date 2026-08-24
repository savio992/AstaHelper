// L'assistente d'asta: quanto posso offrire davvero, e chi prendo se questo giocatore me lo soffiano.

import { ROLES, ROLE_LABEL, tierKey, totalSlots } from './model.js';
import { optimizeRoster, creditShadowPrice } from './optimizer.js';

/** Impostazioni ridotte per i ricalcoli in tempo reale durante l'asta. */
const FAST = { prune: true, localSearch: false };

/** Tetto tecnico: devo lasciare almeno 1 credito per ogni slot ancora da riempire. */
export function maxSpendableNow(settings, owned) {
  const spent = [...owned.values()].reduce((a, b) => a + b, 0);
  const slotsLeft = totalSlots(settings) - owned.size;
  return Math.max(0, (settings.budget || 500) - spent - Math.max(0, slotsLeft - 1));
}

export function slotsLeftByRole(settings, players, owned) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const used = { P: 0, D: 0, C: 0, A: 0 };
  for (const id of owned.keys()) {
    const p = byId.get(id);
    if (p) used[p.role]++;
  }
  const out = {};
  for (const role of ROLES) out[role] = Math.max(0, (settings.slots[role] || 0) - used[role]);
  return out;
}

/**
 * In che reparto siamo, in un'asta a chiamata per ruolo.
 * E' il primo reparto dell'ordine che ha ancora slot da riempire.
 */
export function faseCorrente(settings, players, owned) {
  const ordine = settings.auctionOrder?.length ? settings.auctionOrder : ROLES;
  const mancanti = slotsLeftByRole(settings, players, owned);
  return ordine.find((r) => mancanti[r] > 0) ?? null;
}

/**
 * Quanto posso davvero spendere adesso, in un'asta che procede per reparti.
 *
 * Il tetto tecnico (un credito per ogni slot rimasto) non basta quando i reparti si comprano
 * in sequenza: chi spende duecento crediti in porta arriva all'attacco senza niente, e a quel
 * punto non c'e' piano che tenga. Qui si mette da parte quello che il piano ha destinato ai
 * reparti che verranno dopo, e si guarda quanto resta per quello in corso.
 */
export function budgetDiFase({ settings, players, owned, plan, role = null }) {
  const ordine = settings.auctionOrder?.length ? settings.auctionOrder : ROLES;
  const fase = role || faseCorrente(settings, players, owned) || ordine[ordine.length - 1];
  const indice = ordine.indexOf(fase);
  const mancanti = slotsLeftByRole(settings, players, owned);
  const speso = [...owned.values()].reduce((a, b) => a + b, 0);
  const residuo = (settings.budget || 500) - speso;

  // Quanto il piano prevede ancora di spendere nei reparti successivi.
  let riservatoDopo = 0;
  for (let i = indice + 1; i < ordine.length; i++) {
    const r = ordine[i];
    const dalPiano = (plan?.picks || []).filter((p) => p.role === r).reduce((a, p) => a + p.plannedPrice, 0);
    // Anche senza piano si tiene almeno un credito per slot.
    riservatoDopo += Math.max(dalPiano, mancanti[r]);
  }

  const perLaFase = Math.max(0, residuo - riservatoDopo);
  const pianificatoFase = (plan?.picks || []).filter((p) => p.role === fase).reduce((a, p) => a + p.plannedPrice, 0);
  const spesoFase = [...owned.entries()].reduce((a, [id, prezzo]) => {
    const p = players.find((x) => x.id === id);
    return a + (p && p.role === fase ? prezzo : 0);
  }, 0);

  return {
    fase,
    etichetta: ROLE_LABEL[fase],
    slotMancanti: mancanti[fase],
    residuo,
    riservatoDopo,
    perLaFase,
    pianificatoFase,
    spesoFase,
    // Massimo su un singolo giocatore adesso: lascia un credito per gli altri slot del reparto.
    massimoOra: Math.max(0, perLaFase - Math.max(0, mancanti[fase] - 1)),
  };
}

/**
 * Offerta massima di convenienza per un giocatore.
 * E' il prezzo oltre il quale la rosa che ottengo prendendolo vale meno della rosa
 * che ottengo lasciandolo andare e ridistribuendo i crediti. Il vero limite dell'asta.
 */
export function maxBid({ players, settings, owned = new Map(), unavailable = new Set(), playerId }) {
  const hard = maxSpendableNow(settings, owned);
  if (hard < 1) return { maxBid: 0, planB: null, reason: 'Crediti esauriti per i vincoli di rosa.' };

  const withoutSet = new Set(unavailable);
  withoutSet.add(playerId);
  const planB = optimizeRoster({ players, settings, owned, unavailable: withoutSet, ...FAST });
  if (!planB.ok) {
    // Se senza di lui non esiste una rosa valida, e' incedibile: si arriva al tetto tecnico.
    return { maxBid: hard, planB, hard, breakEven: hard, reason: 'Senza di lui non chiudi la rosa.' };
  }

  const scoreAt = (price) => {
    const o = new Map(owned);
    o.set(playerId, price);
    const plan = optimizeRoster({ players, settings, owned: o, unavailable, ...FAST });
    return plan.ok ? plan.score : -Infinity;
  };

  if (scoreAt(1) < planB.score) {
    return { maxBid: 0, planB, hard, breakEven: 0, reason: 'Non migliora la rosa nemmeno a 1 credito.' };
  }

  // Ricerca binaria del punto di pareggio: il prezzo piu' alto che conviene ancora.
  let lo = 1;
  let hi = hard;
  if (scoreAt(hi) >= planB.score) {
    return { maxBid: hi, planB, hard, breakEven: hi, reason: 'Conviene fino al tetto tecnico.' };
  }
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (scoreAt(mid) >= planB.score) lo = mid;
    else hi = mid;
  }
  return { maxBid: lo, planB, hard, breakEven: lo, reason: null };
}

/**
 * Le migliori alternative a un giocatore che sto perdendo.
 * Non cerca "il piu' simile": ricalcola la rosa intera assumendo di averlo perso e
 * misura quanto vale ogni possibile sostituto nel piano che ne risulta.
 */
export function alternatives({
  players,
  settings,
  owned = new Map(),
  unavailable = new Set(),
  playerId,
  limit = 5,
  shortlist = 14,
}) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const target = byId.get(playerId);
  if (!target) return { alternatives: [], planB: null };

  const withoutSet = new Set(unavailable);
  withoutSet.add(playerId);
  const planB = optimizeRoster({ players, settings, owned, unavailable: withoutSet, ...FAST });
  const planWith = (() => {
    const o = new Map(owned);
    o.set(playerId, Math.max(1, Math.round(target.expectedPrice ?? 1)));
    return optimizeRoster({ players, settings, owned: o, unavailable, ...FAST });
  })();

  const budgetNow = maxSpendableNow(settings, owned);
  const lambda = creditShadowPrice(planB.budgetCurve, planB.budgetLeft ?? budgetNow);

  // Pre-selezione economica: valore netto dei crediti spesi. Poi valutazione esatta dei migliori.
  const pool = players
    .filter(
      (p) =>
        p.role === target.role &&
        p.id !== playerId &&
        !owned.has(p.id) &&
        !unavailable.has(p.id) &&
        Math.round(p.expectedPrice ?? 1) <= budgetNow
    )
    .map((p) => ({ p, net: (p.score || 0) - lambda * Math.max(1, Math.round(p.expectedPrice ?? 1)) }))
    .sort((a, b) => b.net - a.net)
    .slice(0, shortlist);

  const results = [];
  for (const { p } of pool) {
    const price = Math.max(1, Math.round(p.expectedPrice ?? 1));
    if (price > budgetNow) continue;
    const o = new Map(owned);
    o.set(p.id, price);
    const plan = optimizeRoster({ players, settings, owned: o, unavailable: withoutSet, ...FAST });
    if (!plan.ok) continue;
    results.push({
      player: p,
      price,
      score: plan.score,
      // Quanto perdo (o guadagno) rispetto ad avere il giocatore che sto perdendo al suo prezzo atteso.
      deltaVsTarget: planWith.ok ? Math.round((plan.score - planWith.score) * 10) / 10 : null,
      // Quanto guadagno rispetto a non fare nulla e ridistribuire i crediti.
      deltaVsPlanB: planB.ok ? Math.round((plan.score - planB.score) * 10) / 10 : null,
      inPlanB: planB.ok ? planB.picks.some((x) => x.id === p.id) : false,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return {
    alternatives: results.slice(0, limit),
    planB,
    planWith,
    lambda: Math.round(lambda * 1000) / 1000,
  };
}

/** Differenza fra due piani: chi entra e chi esce. */
export function planDiff(before, after) {
  const a = new Map((before?.picks || []).map((p) => [p.id, p]));
  const b = new Map((after?.picks || []).map((p) => [p.id, p]));
  const removed = [...a.values()].filter((p) => !b.has(p.id));
  const added = [...b.values()].filter((p) => !a.has(p.id));
  return { added, removed };
}

/**
 * Budget pianificato per ruolo e per fascia, piu' quanto ho gia' speso davvero.
 * E' la bussola che mi tiene dentro il piano durante l'asta.
 */
export function tierBudgetReport({ plan, settings, players, owned = new Map() }) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const rows = new Map();

  const touch = (role, tier) => {
    const key = tierKey(role, tier);
    if (!rows.has(key)) rows.set(key, { key, role, tier: tier || '—', planned: 0, plannedCount: 0, spent: 0, spentCount: 0 });
    return rows.get(key);
  };

  for (const p of plan?.picks || []) {
    const row = touch(p.role, p.tier);
    row.planned += p.plannedPrice || 0;
    row.plannedCount += 1;
  }
  for (const [id, price] of owned) {
    const p = byId.get(id);
    if (!p) continue;
    const row = touch(p.role, p.tier);
    row.spent += price;
    row.spentCount += 1;
    // Un giocatore gia' preso fa parte del piano a tutti gli effetti.
    row.planned += price;
    row.plannedCount += 1;
  }

  const list = [...rows.values()];
  const roleOrder = { P: 0, D: 1, C: 2, A: 3 };
  list.sort((a, b) => {
    if (roleOrder[a.role] !== roleOrder[b.role]) return roleOrder[a.role] - roleOrder[b.role];
    const oa = settings.tierOrder?.[a.role]?.indexOf(a.tier) ?? 99;
    const ob = settings.tierOrder?.[b.role]?.indexOf(b.tier) ?? 99;
    return (oa < 0 ? 99 : oa) - (ob < 0 ? 99 : ob);
  });
  return list;
}
