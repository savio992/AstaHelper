// Ottimizzatore della rosa: knapsack multi-vincolo (budget totale + slot esatti per ruolo)
// risolto in programmazione dinamica, piu' una ricerca locale che recupera le sinergie
// (blocco difensivo, portiere + difesa dello stesso club) che il DP lineare non vede.

import { ROLES } from './model.js';
import { rosterScore, synergyBonus, depthWeights, clubExposure } from './valuation.js';

const NEG = -1e9;

/** Struttura persistente per ricostruire le scelte del DP senza copiare array. */
class Trail {
  constructor(capacity = 1024) {
    this.item = new Int32Array(capacity);
    this.parent = new Int32Array(capacity);
    this.size = 1; // 0 = lista vuota
    this.item[0] = -1;
    this.parent[0] = -1;
  }
  push(itemIdx, parentRef) {
    if (this.size >= this.item.length) this.grow();
    const ref = this.size++;
    this.item[ref] = itemIdx;
    this.parent[ref] = parentRef;
    return ref;
  }
  grow() {
    const cap = this.item.length * 2;
    const item = new Int32Array(cap);
    const parent = new Int32Array(cap);
    item.set(this.item);
    parent.set(this.parent);
    this.item = item;
    this.parent = parent;
  }
  collect(ref) {
    const out = [];
    let r = ref;
    while (r > 0) {
      out.push(this.item[r]);
      r = this.parent[r];
    }
    return out;
  }
}

/**
 * Riduce i candidati di un ruolo a quelli che possono realisticamente entrare in rosa:
 * i migliori per punteggio, i migliori per rapporto punti/credito e i piu' economici
 * (servono per chiudere gli slot con 1 credito).
 */
export function pruneCandidates(cands, keepTop = 70, keepRatio = 50, keepCheap = 25, tieniPrimaFascia = false) {
  if (cands.length <= keepTop + keepRatio + keepCheap) return cands;
  const chosen = new Set();
  // Con il vincolo sui top attivo, i giocatori di prima fascia non possono essere potati:
  // se sparissero tutti dai candidati il vincolo diventerebbe insoddisfacibile.
  if (tieniPrimaFascia) for (const c of cands) if (c.isTop) chosen.add(c);
  const byScore = [...cands].sort((a, b) => b.score - a.score);
  const byRatio = [...cands].sort((a, b) => b.score / b.cost - a.score / a.cost);
  const byCheap = [...cands].sort((a, b) => a.cost - b.cost || b.score - a.score);
  for (let i = 0; i < keepTop && i < byScore.length; i++) chosen.add(byScore[i]);
  for (let i = 0; i < keepRatio && i < byRatio.length; i++) chosen.add(byRatio[i]);
  for (let i = 0; i < keepCheap && i < byCheap.length; i++) chosen.add(byCheap[i]);
  return [...chosen];
}

/**
 * DP a costo esatto per un singolo ruolo.
 * I candidati arrivano ordinati dal piu' forte al piu' debole: cosi' il k-esimo giocatore
 * inserito e' esattamente il k-esimo migliore del gruppo, e possiamo applicargli il peso
 * di profondita' corretto (titolare, primo cambio, panchinaro...) senza rompere il DP.
 * Ritorna dp[k * (B+1) + b] = punteggio massimo con esattamente k giocatori e costo esatto b.
 */
function roleKnapsack(cands, slots, B, minTop = 0) {
  const W = B + 1;
  const T = Math.max(0, Math.min(minTop, slots));
  // Terza dimensione: quanti giocatori di prima fascia sono stati presi, saturata a T
  // (oltre il minimo richiesto non serve distinguere).
  const at = (k, t) => (k * (T + 1) + t) * W;
  const size = (slots + 1) * (T + 1) * W;
  const dp = new Float64Array(size).fill(NEG);
  const refs = new Int32Array(size);
  const trail = new Trail(Math.min(1 << 21, Math.max(1024, cands.length * (slots + 1) * (T + 1) * 4)));
  dp[at(0, 0)] = 0;

  for (let i = 0; i < cands.length; i++) {
    const c = cands[i].cost;
    const weighted = cands[i].weighted;
    const isTop = cands[i].isTop ? 1 : 0;
    if (c > B) continue;
    for (let k = slots; k >= 1; k--) {
      const s = weighted[k - 1];
      for (let t = T; t >= 0; t--) {
        // Stati che portano a (k, t) prendendo questo giocatore.
        const sorgenti = isTop ? (t === T ? (T > 0 ? [T - 1, T] : [T]) : t > 0 ? [t - 1] : []) : [t];
        for (const tPrev of sorgenti) {
          const rowPrev = at(k - 1, tPrev);
          const row = at(k, t);
          for (let b = B; b >= c; b--) {
            const prev = dp[rowPrev + b - c];
            if (prev <= NEG / 2) continue;
            const val = prev + s;
            if (val > dp[row + b]) {
              dp[row + b] = val;
              refs[row + b] = trail.push(i, refs[rowPrev + b - c]);
            }
          }
        }
      }
    }
  }
  return { dp, refs, trail, W, T, at };
}

/**
 * Risolve il problema completo.
 *
 * input:
 *  - players: giocatori con `score` e `expectedPrice`
 *  - settings
 *  - owned: Map id -> prezzo pagato (gia' in rosa, slot e crediti bloccati)
 *  - unavailable: Set di id non piu' acquistabili (presi da altri, o esclusi a mano)
 *  - priceOverride: Map id -> prezzo da usare al posto di expectedPrice
 *
 * Ritorna { ok, picks, owned, cost, score, spentByRole, leftover, budgetCurve }
 */
/**
 * L'unica configurazione del solutore, usata dal piano e da ogni consiglio.
 *
 * Deve stare in un posto solo. Due volte in questo progetto il piano mostrato e l'offerta
 * massima hanno usato solutori di forza diversa, e ogni volta il risultato e' stato lo stesso:
 * il piano diceva di non comprare un giocatore e l'assistente diceva di pagarlo tre volte il
 * suo prezzo, perche' il termine di paragone era una rosa peggiore di quella vera. La prima
 * volta era la ricerca locale, la seconda le ripartenze. Con una costante sola non puo'
 * succedere una terza.
 *
 * Una ripartenza sola basta: sui listoni veri porta la rosa da 1905 a 1949 punti, e la seconda
 * non aggiunge niente mentre raddoppia il tempo di ogni consiglio.
 */
export const CONFIG_SOLUTORE = { prune: false, localSearch: true, ripartenze: 1 };

export function optimizeRoster({
  players,
  settings,
  owned = new Map(),
  unavailable = new Set(),
  priceOverride = new Map(),
  prune = true,
  localSearch = true,
  ripartenze = 0,
  obbligati = new Set(),
} = {}) {
  const byId = new Map(players.map((p) => [p.id, p]));

  // I giocatori che l'utente ha deciso di volere si trattano come gia' in rosa al loro prezzo
  // di mercato: e' l'unico modo di farli entrare nel conto in modo esatto, perche' il solutore
  // sa gia' come un giocatore in rosa sposta i pesi di profondita' degli altri del suo ruolo.
  // Alla fine tornano fra gli obiettivi da comprare, che e' quello che sono davvero.
  const forzati = new Set();
  const ownedEffettivo = new Map(owned);
  for (const id of obbligati) {
    if (owned.has(id) || unavailable.has(id)) continue;
    const p = byId.get(id);
    if (!p) continue;
    ownedEffettivo.set(id, Math.max(1, Math.round(priceOverride.get(id) ?? p.expectedPrice ?? 1)));
    forzati.add(id);
  }

  // In modalita' "scelgo io" la lista non e' un vincolo da aggirare: e' la rosa. Chi ci sta
  // dentro gioca, e le caselle libere si completano attorno a lui. Senza questo, scegliere un
  // portiere da 43 crediti faceva comprare al piano anche il portiere da 52 che lo mandava in
  // panchina: novantasette crediti per un posto dove ne gioca uno solo.
  // In modalita' automatica il lucchetto resta quello che e' sempre stato — "questo lo voglio
  // in rosa" — e il solutore e' libero di costruirgli intorno la rosa migliore.
  const sceltiTitolari = settings.modalita === 'mia';

  const ownedPlayers = [];
  let ownedCost = 0;
  const ownedByRole = { P: 0, D: 0, C: 0, A: 0 };
  for (const [id, price] of ownedEffettivo) {
    const p = byId.get(id);
    if (!p) continue;
    ownedPlayers.push(sceltiTitolari && forzati.has(id) ? { ...p, paid: price, scelto: true } : { ...p, paid: price });
    ownedCost += price;
    ownedByRole[p.role] = (ownedByRole[p.role] || 0) + 1;
  }

  const budgetLeft = (settings.budget || 500) - ownedCost;
  const need = {};
  let needTotal = 0;
  for (const role of ROLES) {
    need[role] = Math.max(0, (settings.slots[role] || 0) - (ownedByRole[role] || 0));
    needTotal += need[role];
  }

  if (budgetLeft < needTotal) {
    return {
      ok: false,
      reason: `Crediti insufficienti: restano ${budgetLeft} per ${needTotal} slot (serve almeno 1 credito a slot).`,
      picks: [],
      owned: ownedPlayers,
      cost: ownedCost,
      score: rosterScore(ownedPlayers, settings),
      spentByRole: spendByRole(ownedPlayers, []),
      leftover: budgetLeft,
    };
  }

  const B = Math.max(0, Math.floor(budgetLeft));

  // I top gia' comprati contano: il vincolo riguarda la rosa finita, non i soli acquisti futuri.
  // E non puo' chiedere piu' top di quanti ne restino disponibili, altrimenti un listone senza
  // fasce, o un reparto in cui li hanno gia' presi tutti, renderebbe il piano impossibile.
  const topNeed = {};
  for (const role of ROLES) {
    const richiesti = Math.max(0, Math.round(settings.minTop?.[role] ?? 0));
    const gia = ownedPlayers.filter((p) => p.role === role && p.isTop).length;
    const disponibili = players.filter(
      (p) => p.role === role && p.isTop && !ownedEffettivo.has(p.id) && !unavailable.has(p.id)
    ).length;
    topNeed[role] = Math.max(0, Math.min(need[role], disponibili, richiesti - gia));
  }

  // Candidati per ruolo
  const roleData = {};
  for (const role of ROLES) {
    // Stesso ordine di profondita' che usa il punteggio della rosa: prima i giocatori scelti a
    // mano, poi gli altri per punteggio. Se qui e' diverso, il DP e la valutazione finale
    // parlano di due rose diverse e la ricerca locale passa il tempo a disfare le sue scelte.
    const ownedRuolo = ownedPlayers
      .filter((p) => p.role === role)
      .map((p) => ({ score: p.score || 0, scelto: !!p.scelto }))
      .sort((a, b) => (b.scelto ? 1 : 0) - (a.scelto ? 1 : 0) || b.score - a.score);
    const ownedScores = ownedRuolo.map((o) => o.score);
    const weights = depthWeights(settings, role);
    const wAt = (i) => weights[Math.min(Math.max(0, i), weights.length - 1)] ?? 0.05;
    let cands = players
      .filter((p) => p.role === role && !ownedEffettivo.has(p.id) && !unavailable.has(p.id))
      .map((p) => ({
        id: p.id,
        score: p.score || 0,
        isTop: !!p.isTop,
        cost: Math.max(1, Math.round(priceOverride.get(p.id) ?? p.expectedPrice ?? 1)),
      }))
      .filter((c) => c.cost <= B);
    if (prune) cands = pruneCandidates(cands, 70, 50, 25, topNeed[role] > 0);
    cands.sort((a, b) => b.score - a.score);
    // Rango reale nel ruolo = giocatori gia' in rosa piu' forti + candidati migliori gia' scelti.
    // Comprare un giocatore piu' forte retrocede di un posto tutti quelli gia' in rosa piu' deboli:
    // senza questo termine l'ottimizzatore ti fa comprare cinque attaccanti sopra quello che hai gia'.
    const needRole = need[role] || 1;
    for (const cand of cands) {
      // Quanti gia' in rosa restano davanti a lui: tutti gli scelti a mano, piu' i piu' forti.
      const above = ownedRuolo.filter((o) => o.scelto || o.score >= cand.score).length;
      cand.weighted = new Float64Array(needRole);
      for (let k = 1; k <= needRole; k++) {
        let v = cand.score * wAt(k - 1 + above);
        for (let a = above; a < ownedScores.length; a++) v += ownedScores[a] * (wAt(a + k) - wAt(a + k - 1));
        cand.weighted[k - 1] = v;
      }
    }
    roleData[role] = cands;
  }

  for (const role of ROLES) {
    if (need[role] > roleData[role].length) {
      return {
        ok: false,
        reason: `Non ci sono abbastanza ${role} disponibili nel listone (servono ${need[role]}, ne restano ${roleData[role].length}).`,
        picks: [],
        owned: ownedPlayers,
        cost: ownedCost,
        score: rosterScore(ownedPlayers, settings),
        spentByRole: spendByRole(ownedPlayers, []),
        leftover: budgetLeft,
      };
    }
  }

  // DP per ruolo
  const solved = {};
  for (const role of ROLES) {
    solved[role] = need[role] > 0 ? roleKnapsack(roleData[role], need[role], B, topNeed[role]) : null;
  }

  // Convoluzione fra i ruoli, rispettando eventuali tetti di spesa per ruolo.
  const W = B + 1;
  let cur = new Float64Array(W).fill(NEG);
  cur[0] = 0;
  const splits = [];
  for (const role of ROLES) {
    const next = new Float64Array(W).fill(NEG);
    const split = new Int32Array(W).fill(-1);
    if (need[role] === 0) {
      next.set(cur);
      split.fill(0);
      splits.push(split);
      cur = next;
      continue;
    }
    const { dp, at, T } = solved[role];
    const row = at(need[role], T);
    const cap = settings.roleBudget?.[role];
    const maxRole = cap === null || cap === undefined || cap === '' ? B : Math.min(B, Math.max(0, Math.floor(cap)));
    for (let c = 0; c <= maxRole; c++) {
      const v = dp[row + c];
      if (v <= NEG / 2) continue;
      for (let b = c; b <= B; b++) {
        const prev = cur[b - c];
        if (prev <= NEG / 2) continue;
        const val = prev + v;
        if (val > next[b]) {
          next[b] = val;
          split[b] = c;
        }
      }
    }
    splits.push(split);
    cur = next;
  }

  // Curva del punteggio in funzione del budget speso (serve per il prezzo ombra dei crediti).
  const budgetCurve = new Float64Array(W);
  let running = NEG;
  for (let b = 0; b <= B; b++) {
    if (cur[b] > running) running = cur[b];
    budgetCurve[b] = running;
  }

  // A parita' di punteggio si sceglie la rosa che spende di piu': i crediti che avanzano
  // a fine asta valgono zero, quindi non ha senso lasciarli sul tavolo.
  let bestB = -1;
  let bestVal = NEG;
  for (let b = 0; b <= B; b++) {
    if (cur[b] >= bestVal && cur[b] > NEG / 2) {
      bestVal = cur[b];
      bestB = b;
    }
  }

  if (bestB < 0) {
    return {
      ok: false,
      reason: 'Nessuna rosa valida con questi vincoli: prova ad allentare i tetti di spesa per ruolo.',
      picks: [],
      owned: ownedPlayers,
      cost: ownedCost,
      score: rosterScore(ownedPlayers, settings),
      spentByRole: spendByRole(ownedPlayers, []),
      leftover: budgetLeft,
    };
  }

  // Backtracking
  let picks = [];
  let b = bestB;
  for (let r = ROLES.length - 1; r >= 0; r--) {
    const role = ROLES[r];
    const c = splits[r][b];
    if (c > 0 || need[role] > 0) {
      if (need[role] > 0) {
        const { refs, trail, at, T } = solved[role];
        const ref = refs[at(need[role], T) + c];
        for (const idx of trail.collect(ref)) {
          const cand = roleData[role][idx];
          picks.push({ ...byId.get(cand.id), plannedPrice: cand.cost });
        }
      }
    }
    b -= Math.max(0, c);
  }

  if (localSearch) {
    const ctx = { ownedPlayers, players, settings, owned: ownedEffettivo, unavailable, priceOverride, budgetLeft };
    picks = improveWithSynergy({ picks, ...ctx });
    // Il DP non sa nulla di club: se e' andato oltre il tetto di concentrazione si ripara qui.
    picks = enforceClubCap({ picks, ...ctx });
    picks = improveWithSynergy({ picks, ...ctx });
    picks = enforceClubCap({ picks, ...ctx });
  }

  const cost = ownedCost + picks.reduce((s, p) => s + p.plannedPrice, 0);
  const full = [...ownedPlayers.map((p) => ({ ...p, plannedPrice: p.paid })), ...picks];

  // I forzati tornano fra gli obiettivi: non sono comprati, sono scelti. Il totale non cambia,
  // ma cosi' il budget di fase li conta fra le spese ancora da fare e l'elenco li mostra
  // come quello che sono.
  const daComprare = forzati.size
    ? [...picks, ...ownedPlayers.filter((p) => forzati.has(p.id)).map((p) => ({ ...p, plannedPrice: p.paid, bloccato: true }))]
    : picks;
  const davveroMiei = forzati.size ? ownedPlayers.filter((p) => !forzati.has(p.id)) : ownedPlayers;

  const risultato = {
    ok: true,
    picks: daComprare,
    owned: davveroMiei,
    all: full,
    cost,
    score: rosterScore(full, settings),
    spentByRole: spendByRole(davveroMiei, daComprare),
    leftover: (settings.budget || 500) - cost,
    budgetCurve,
    budgetLeft,
  };

  if (ripartenze <= 0) return risultato;

  // Ripartenze: la programmazione dinamica e' esatta sulla parte separabile del punteggio, ma
  // e' cieca alla sinergia, che dipende da quali giocatori stanno insieme e non si puo' scrivere
  // come somma di contributi individuali. Cosi' capita che il piano compri il giocatore che
  // massimizza la somma e perda un blocco che varrebbe di piu': sui listoni di prova escludere
  // l'attaccante piu' caro faceva salire la rosa da 1905 a 1949 punti, perche' la sinergia
  // passava da 21 a 87.
  //
  // Rimedio economico: si riprova togliendo a turno una delle scelte piu' costose e si tiene la
  // rosa migliore. Non garantisce l'ottimo — quello richiederebbe un modello non separabile —
  // ma recupera proprio i casi in cui una singola scelta cara sbarra la strada a un blocco.
  let migliore = risultato;
  const candidate = daComprare
    .filter((c) => !obbligati.has(c.id))
    .sort((a, b) => b.plannedPrice - a.plannedPrice)
    .slice(0, ripartenze);
  for (const c of candidate) {
    const escluso = new Set(unavailable);
    escluso.add(c.id);
    const alt = optimizeRoster({
      players,
      settings,
      owned,
      unavailable: escluso,
      priceOverride,
      prune,
      localSearch,
      ripartenze: 0,
      obbligati,
    });
    if (alt.ok && alt.score > migliore.score) migliore = alt;
  }
  return migliore;
}

function spendByRole(ownedPlayers, picks) {
  const out = { P: 0, D: 0, C: 0, A: 0 };
  for (const p of ownedPlayers) out[p.role] += p.paid || 0;
  for (const p of picks) out[p.role] += p.plannedPrice || 0;
  return out;
}

/**
 * Ricerca locale: il DP massimizza la somma dei punteggi individuali, ma non sa che
 * tre difensori dello stesso club valgono piu' di tre difensori sparsi quando c'e' il
 * modificatore. Qui proviamo scambi 1-a-1 e riutilizziamo i crediti avanzati.
 */
function improveWithSynergy({ picks, ownedPlayers, players, settings, owned, unavailable, priceOverride, budgetLeft }) {
  const hasSynergy = settings.defenseModifier || settings.cleanSheetModifier || Number(settings.maxPerClub) > 0;
  let current = [...picks];
  const inRoster = new Set([...current.map((p) => p.id), ...ownedPlayers.map((p) => p.id)]);

  const priceOf = (p) => Math.max(1, Math.round(priceOverride.get(p.id) ?? p.expectedPrice ?? 1));
  const poolByRole = {};
  for (const role of ROLES) {
    poolByRole[role] = players
      .filter((p) => p.role === role && !owned.has(p.id) && !unavailable.has(p.id))
      .sort((a, b) => b.score - a.score)
      .slice(0, 120);
  }

  const roleSpend = (list, role, owned) =>
    list.filter((p) => p.role === role).reduce((a, p) => a + p.plannedPrice, 0) +
    owned.filter((p) => p.role === role).reduce((a, p) => a + (p.paid || 0), 0);

  const evaluate = (list) => rosterScore([...ownedPlayers.map((p) => ({ ...p, score: p.score })), ...list], settings);
  const spend = (list) => list.reduce((s, p) => s + p.plannedPrice, 0);

  let improved = true;
  let sweeps = 0;
  const maxSweeps = hasSynergy ? 5 : 2;
  while (improved && sweeps++ < maxSweeps) {
    improved = false;
    for (let i = 0; i < current.length; i++) {
      const out = current[i];
      const budgetForSlot = budgetLeft - (spend(current) - out.plannedPrice);
      // Il tetto di spesa del ruolo vale anche qui: il DP lo rispettava, uno scambio
      // conveniente ma fuori budget di reparto lo violerebbe in silenzio.
      const cap = settings.roleBudget?.[out.role];
      const roleCapLeft =
        cap === null || cap === undefined || cap === ''
          ? Infinity
          : Math.max(0, Number(cap) - roleSpend(current, out.role, ownedPlayers) + out.plannedPrice);
      let bestList = null;
      let bestScore = evaluate(current);
      const clubCap = Number(settings.maxPerClub) || 0;
      const exposure = clubCap > 0 ? clubExposure([...ownedPlayers, ...current], settings) : null;
      // Se sto togliendo un top e il reparto e' gia' al minimo, il sostituto deve essere un top.
      const minTop = Math.max(0, Math.round(settings.minTop?.[out.role] ?? 0));
      const topInRuolo = [...current, ...ownedPlayers].filter((p) => p.role === out.role && p.isTop).length;
      const serveTop = out.isTop && topInRuolo <= minTop;
      for (const cand of poolByRole[out.role]) {
        if (inRoster.has(cand.id)) continue;
        if (serveTop && !cand.isTop) continue;
        const cost = priceOf(cand);
        if (cost > budgetForSlot || cost > roleCapLeft) continue;
        // Non riportare dentro un club gia' al limite: il tetto e' appena stato rispettato.
        if (exposure && cand.team !== out.team && (exposure.get(cand.team)?.effettivi ?? 0) >= clubCap) continue;
        const trial = current.slice();
        trial[i] = { ...cand, plannedPrice: cost };
        const sc = evaluate(trial);
        if (sc > bestScore + 1e-9) {
          bestScore = sc;
          bestList = trial;
        }
      }
      if (bestList) {
        inRoster.delete(out.id);
        inRoster.add(bestList[i].id);
        current = bestList;
        improved = true;
      }
    }
  }

  return current;
}

/**
 * Riporta la rosa sotto il tetto di giocatori per club.
 * Sostituisce i giocatori meno utili dei club sovraesposti, partendo dal piu' sacrificabile,
 * finche' la soglia rientra o non ci sono piu' rimpiazzi sostenibili.
 */
function enforceClubCap({ picks, ownedPlayers, players, settings, owned, unavailable, priceOverride, budgetLeft }) {
  const cap = Number(settings.maxPerClub) || 0;
  if (cap <= 0) return picks;

  const priceOf = (p) => Math.max(1, Math.round(priceOverride.get(p.id) ?? p.expectedPrice ?? 1));
  let current = [...picks];

  for (let guard = 0; guard < 60; guard++) {
    const full = [...ownedPlayers, ...current];
    const exposure = clubExposure(full, settings);
    const over = [...exposure.entries()]
      .filter(([, v]) => v.effettivi > cap + 0.25)
      .sort((a, b) => b[1].effettivi - a[1].effettivi);
    if (!over.length) return current;

    const [team] = over[0];
    // Si sacrifica per primo chi rende meno rispetto a quello che costa.
    const sacrificable = current
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.team === team)
      .sort((a, b) => a.p.score / a.p.plannedPrice - b.p.score / b.p.plannedPrice);

    let replaced = false;
    for (const { p: outPlayer, i } of sacrificable) {
      const minTop = Math.max(0, Math.round(settings.minTop?.[outPlayer.role] ?? 0));
      const topInRuolo = [...current, ...ownedPlayers].filter((p) => p.role === outPlayer.role && p.isTop).length;
      const serveTop = outPlayer.isTop && topInRuolo <= minTop;
      const inRoster = new Set([...current.map((x) => x.id), ...ownedPlayers.map((x) => x.id)]);
      const spendOthers = current.reduce((a, x) => a + x.plannedPrice, 0) - outPlayer.plannedPrice;
      const budgetForSlot = budgetLeft - spendOthers;
      const candidate = players
        .filter(
          (c) =>
            c.role === outPlayer.role &&
            c.team !== team &&
            !inRoster.has(c.id) &&
            !owned.has(c.id) &&
            !unavailable.has(c.id) &&
            priceOf(c) <= budgetForSlot &&
            (exposure.get(c.team)?.effettivi ?? 0) < cap &&
            (!serveTop || c.isTop)
        )
        .sort((a, b) => (b.score || 0) - (a.score || 0))[0];
      if (!candidate) continue;
      current = current.slice();
      current[i] = { ...candidate, plannedPrice: priceOf(candidate) };
      replaced = true;
      break;
    }
    if (!replaced) return current;
  }
  return current;
}

/**
 * Prezzo ombra del credito: quanti punti vale il credito marginale al livello di spesa attuale.
 * Serve a ordinare le alternative in modo sensato (punti guadagnati per credito speso).
 */
export function creditShadowPrice(budgetCurve, at) {
  if (!budgetCurve || budgetCurve.length < 2) return 0;
  const B = budgetCurve.length - 1;
  const hi = Math.min(B, Math.max(1, Math.round(at)));
  const lo = Math.max(0, hi - 25);
  const span = hi - lo;
  if (span <= 0) return 0;
  const d = budgetCurve[hi] - budgetCurve[lo];
  return d > 0 ? d / span : 0;
}

export { synergyBonus };
