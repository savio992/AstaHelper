// Dal listone (fasce dei creators + quotazioni) al punteggio atteso di ogni giocatore,
// tenendo conto dei modificatori di lega.

import { ROLES, tierRank } from './model.js';

// Decadimento del valore fra una fascia e la successiva, per ruolo.
// Gli attaccanti hanno una curva piu' ripida: il divario fra un top e un terza fascia e' enorme.
const TIER_DECAY = { P: 0.7, D: 0.8, C: 0.78, A: 0.74 };

// Peso relativo dei ruoli nel punteggio complessivo della rosa (senza modificatori).
const ROLE_WEIGHT = { P: 0.7, D: 0.75, C: 1.0, A: 1.15 };

/** Punteggio base dato dalla sola fascia: 100 per la prima, poi decadimento geometrico. */
export function tierScore(settings, role, tier) {
  const rank = tierRank(settings, role, tier);
  return 100 * Math.pow(TIER_DECAY[role] ?? 0.78, rank);
}

function percentileMap(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return (v) => {
    if (!sorted.length) return 0.5;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return sorted.length === 1 ? 0.5 : lo / (sorted.length - 1);
  };
}

/**
 * Solidita' difensiva stimata di ogni club, dedotta dalle fasce dei suoi difensori e del portiere.
 * E' il segnale che fa funzionare davvero modificatore di difesa e imbattibilita'.
 * Ritorna una mappa club -> 0..1.
 */
export function clubSolidity(players, settings) {
  const byClub = new Map();
  for (const p of players) {
    if (p.role !== 'D' && p.role !== 'P') continue;
    if (!p.team) continue;
    if (!byClub.has(p.team)) byClub.set(p.team, { D: [], P: [] });
    byClub.get(p.team)[p.role].push(tierScore(settings, p.role, p.tier));
  }
  const raw = new Map();
  for (const [club, groups] of byClub) {
    const topD = groups.D.sort((a, b) => b - a).slice(0, 3);
    const topP = groups.P.sort((a, b) => b - a).slice(0, 1);
    const avgD = topD.length ? topD.reduce((a, b) => a + b, 0) / topD.length : 0;
    const avgP = topP.length ? topP[0] : 0;
    raw.set(club, 0.6 * avgD + 0.4 * avgP);
  }
  const values = [...raw.values()];
  const pct = percentileMap(values);
  const out = new Map();
  for (const [club, v] of raw) out.set(club, pct(v));
  return out;
}

/**
 * Calcola il punteggio atteso di ogni giocatore.
 * Mutua i giocatori aggiungendo i campi derivati `score`, `tierRank`, `solidity`.
 */
export function valuePlayers(players, settings) {
  const solidity = clubSolidity(players, settings);

  // Percentile del valore di mercato dichiarato (FVM o quotazione) all'interno del ruolo:
  // serve a distinguere i giocatori dentro la stessa fascia.
  const marketPct = {};
  for (const role of ROLES) {
    const vals = players
      .filter((p) => p.role === role)
      .map((p) => p.fvm ?? p.price)
      .filter((v) => v !== null && v !== undefined && Number.isFinite(v));
    marketPct[role] = percentileMap(vals);
  }

  const out = players.map((p) => {
    const base = tierScore(settings, p.role, p.tier);
    const market = p.fvm ?? p.price;
    // Dentro la fascia, il mercato sposta il punteggio al massimo di +/-12%.
    const inTierAdj = Number.isFinite(market) ? 0.88 + 0.24 * marketPct[p.role](market) : 1;
    const sol = solidity.get(p.team) ?? 0.5;

    let score = base * inTierAdj * (ROLE_WEIGHT[p.role] ?? 1);

    if (settings.defenseModifier) {
      if (p.role === 'D') score *= 1.22 * (0.9 + 0.2 * sol);
      if (p.role === 'P') score *= 1.08;
    }
    if (settings.cleanSheetModifier && p.role === 'P') {
      // Con l'imbattibilita' il portiere di una squadra solida vale molto piu' del suo prezzo.
      score *= 1.35 * (0.8 + 0.4 * sol);
    }

    return { ...p, score: Math.round(score * 100) / 100, tierRank: tierRank(settings, p.role, p.tier), solidity: sol };
  });

  return out;
}

/**
 * Bonus di sinergia per un insieme di giocatori gia' scelti.
 * - blocco difensivo: 3+ difensori dello stesso club valgono piu' della somma delle parti
 *   quando c'e' il modificatore di difesa (stessa partita, stesso clean sheet).
 * - portiere di riserva dello stesso club del titolare: assicurazione sull'imbattibilita'.
 */
export function synergyBonus(selected, settings) {
  if (!selected.length) return 0;
  let bonus = 0;

  if (settings.defenseModifier) {
    const byClub = new Map();
    for (const p of selected) {
      if (p.role !== 'D' || !p.team) continue;
      if (!byClub.has(p.team)) byClub.set(p.team, []);
      byClub.get(p.team).push(p);
    }
    for (const [, group] of byClub) {
      if (group.length < 2) continue;
      const avg = group.reduce((a, b) => a + b.score, 0) / group.length;
      const sol = group[0].solidity ?? 0.5;
      // 2 difensori: piccolo bonus. 3: significativo. 4+: rendimento decrescente.
      const factor = group.length === 2 ? 0.04 : group.length === 3 ? 0.11 : 0.14;
      bonus += avg * factor * (0.6 + 0.8 * sol);
    }
  }

  if (settings.cleanSheetModifier) {
    const gks = selected.filter((p) => p.role === 'P');
    if (gks.length >= 2) {
      const starter = gks.slice().sort((a, b) => b.score - a.score)[0];
      const sameClub = gks.filter((p) => p.id !== starter.id && p.team && p.team === starter.team).length;
      if (sameClub >= 1) bonus += starter.score * 0.08;
      // Il blocco difensivo davanti al proprio portiere e' il vero moltiplicatore.
      const defsSameClub = selected.filter((p) => p.role === 'D' && p.team && p.team === starter.team).length;
      if (defsSameClub >= 2) bonus += starter.score * 0.05 * Math.min(defsSameClub, 4);
    }
  }

  return Math.round(bonus * 100) / 100;
}

// Quanto pesa il secondo, terzo, quarto giocatore di un ruolo rispetto ai titolari.
// In porta gioca uno solo: la riserva vale quasi zero (e' un'assicurazione, non un titolare).
const BENCH_DECAY = { P: [0.1, 0.04], D: [0.5, 0.3, 0.18, 0.11, 0.07], C: [0.5, 0.3, 0.18, 0.11, 0.07], A: [0.5, 0.28, 0.16, 0.1] };

/**
 * Peso del j-esimo giocatore piu' forte di un ruolo (j da 0).
 * I titolari valgono 1, poi si scende: e' cosi' che l'ottimizzatore capisce
 * che non ha senso spendere sul terzo portiere o sull'ottavo difensore.
 */
export function depthWeights(settings, role) {
  const starters = Math.max(1, settings.starters?.[role] ?? { P: 1, D: 3, C: 4, A: 3 }[role]);
  const slots = Math.max(starters, settings.slots?.[role] ?? starters);
  const decay = BENCH_DECAY[role] || [0.5, 0.3, 0.18, 0.11, 0.07];
  const out = [];
  for (let i = 0; i < slots; i++) {
    if (i < starters) out.push(1);
    else {
      const k = i - starters;
      out.push(k < decay.length ? decay[k] : decay[decay.length - 1] * Math.pow(0.6, k - decay.length + 1));
    }
  }
  return out;
}

/**
 * Punteggio totale di una rosa: somma dei punteggi pesati per profondita' piu' le sinergie.
 * Dentro ogni ruolo i giocatori vengono ordinati dal migliore al peggiore.
 */
export function rosterScore(selected, settings) {
  let base = 0;
  for (const role of ROLES) {
    const group = selected.filter((p) => p.role === role).sort((a, b) => (b.score || 0) - (a.score || 0));
    const w = depthWeights(settings, role);
    group.forEach((p, i) => {
      base += (p.score || 0) * (w[i] ?? w[w.length - 1] ?? 0.05);
    });
  }
  return Math.round((base + synergyBonus(selected, settings)) * 100) / 100;
}
