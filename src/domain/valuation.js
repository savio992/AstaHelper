// Dal listone al punteggio atteso di ogni giocatore.
//
// Il modello preferisce i segnali cardinali quando ci sono (fantamedia attesa, titolarita',
// integrita' fisica) e ripiega sulla sola fascia quando il listone e' povero. In entrambi i
// casi il punteggio e' "punti sopra il sostituto": quanto vale prenderlo invece di prendere
// il primo giocatore che resterebbe comunque disponibile a fine asta.

import { ROLES } from './model.js';

// Peso relativo dei ruoli. Serve a calibrare fra loro reparti con fantamedie su scale diverse
// (un portiere non fara' mai 8 di fantamedia, un attaccante si').
// Con il valore misurato sopra il sostituto la scala si calibra da sola: i portieri
// hanno fantamedie tutte vicine e finiscono giustamente a costare poco.
const ROLE_WEIGHT = { P: 1, D: 1, C: 1, A: 1 };

// Quante partite ci si aspetta da lui, in funzione del giudizio del creator (0-5).
const TIT_FACTOR = [0.05, 0.15, 0.34, 0.56, 0.76, 0.92];
const INT_FACTOR = [0.6, 0.66, 0.78, 0.88, 0.95, 1.0];

// Decadimento del valore fra una fascia e la successiva, usato solo senza fantamedia attesa.
const TIER_DECAY = { P: 0.7, D: 0.8, C: 0.78, A: 0.74 };

// Quanto pesa il secondo, terzo, quarto giocatore di un ruolo rispetto ai titolari.
// In porta gioca uno solo: la riserva vale quasi zero (e' un'assicurazione, non un titolare).
const BENCH_DECAY = { P: [0.07, 0.03], D: [0.5, 0.3, 0.18, 0.11, 0.07], C: [0.5, 0.3, 0.18, 0.11, 0.07], A: [0.5, 0.28, 0.16, 0.1] };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Ordina dal piu' forte al piu' debole con un criterio deterministico.
 * A parita' di punteggio decide l'identificativo: senza questo, due giocatori equivalenti
 * di club diversi darebbero punteggi di rosa differenti a seconda dell'ordine dell'elenco.
 */
/**
 * L'ordine di profondita' dentro un ruolo: chi gioca, chi e' il primo cambio, chi riempie.
 *
 * Di norma decide il punteggio. Ma un giocatore scelto a mano viene prima comunque: quando
 * uno dice "il mio portiere e' questo" non sta dicendo "mettimelo in panchina se ne trovi uno
 * piu' forte". Senza questo termine il piano compra sopra la scelta dell'utente e in porta,
 * dove ne gioca uno solo, si ritrova a spendere due volte per un posto.
 */
export function sortByStrength(list) {
  return [...list].sort(
    (a, b) =>
      (b.scelto ? 1 : 0) - (a.scelto ? 1 : 0) ||
      (b.score || 0) - (a.score || 0) ||
      String(a.id).localeCompare(String(b.id))
  );
}

/** Frazione di stagione che ci si aspetta di avere da lui, fra 0 e 1. */
export function expectedShare(p) {
  const tit = Number.isFinite(p.titolarita) ? TIT_FACTOR[clamp(Math.round(p.titolarita), 0, 5)] : null;
  const int = Number.isFinite(p.integrita) ? INT_FACTOR[clamp(Math.round(p.integrita), 0, 5)] : 0.9;
  if (tit !== null) return tit * int;
  // Senza giudizio del creator ripieghiamo sulle presenze dell'anno scorso.
  if (Number.isFinite(p.matches) && p.matches > 0) return clamp(p.matches / 38, 0.05, 0.95) * int;
  return 0.6 * int;
}

/** La fantamedia attesa dichiarata, con ripiego su quella dell'anno scorso. */
function projectedAverage(p) {
  for (const v of [p.fmvExp, p.fantamedia]) {
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/** Punti attesi in tutta la stagione: fantamedia attesa per le partite che ci si aspetta da lui. */
function seasonPoints(p) {
  const fm = projectedAverage(p);
  return fm === null ? null : fm * expectedShare(p) * 38;
}

/**
 * Livello di sostituzione per ruolo, misurato in punti di stagione.
 *
 * E' il rendimento del miglior giocatore che resterebbe libero a fine asta: in una lega da
 * dieci con otto difensori a squadra, gli ottanta migliori difensori finiscono tutti in una
 * rosa, quindi il metro di paragone e' l'ottantunesimo.
 *
 * Va misurato sui punti di stagione e non sulla media a partita, perche' le fantamedie attese
 * sono quasi identiche per tutti tranne i primissimi: quello che separa davvero un titolare da
 * un rincalzo e' quante partite gioca, non quanto rende quando gioca.
 */
function replacementLevel(players, settings, role) {
  const pool = players
    .filter((p) => p.role === role)
    .map(seasonPoints)
    .filter((v) => v !== null)
    .sort((a, b) => b - a);
  if (!pool.length) return null;
  const rank = Math.max(1, (settings.slots?.[role] ?? 1) * (settings.participants || 10));
  return pool[Math.min(pool.length - 1, rank)];
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

/** Punteggio base dato dalla sola fascia, quando manca qualunque proiezione. */
function tierOnlyScore(p, settings) {
  const order = settings.tierOrder?.[p.role] || [];
  const rank = Number.isFinite(p.tierPct) && order.length > 1 ? p.tierPct * (order.length - 1) : order.indexOf(p.tier) >= 0 ? order.indexOf(p.tier) : order.length;
  return 100 * Math.pow(TIER_DECAY[p.role] ?? 0.78, rank);
}

function hasTag(p, tag) {
  return (p.tags || []).some((t) => t.includes(tag));
}

/**
 * Solidita' difensiva stimata di ogni club, dedotta dal listone stesso.
 * E' il segnale che fa funzionare modificatore di difesa e imbattibilita' del portiere.
 */
export function clubSolidity(players, baseScore) {
  const byClub = new Map();
  for (const p of players) {
    if (p.role !== 'D' && p.role !== 'P') continue;
    if (!p.team) continue;
    if (!byClub.has(p.team)) byClub.set(p.team, { D: [], P: [] });
    byClub.get(p.team)[p.role].push(baseScore.get(p.id) || 0);
  }
  const raw = new Map();
  for (const [club, groups] of byClub) {
    const topD = groups.D.sort((a, b) => b - a).slice(0, 3);
    const topP = groups.P.sort((a, b) => b - a).slice(0, 1);
    const avgD = topD.length ? topD.reduce((a, b) => a + b, 0) / topD.length : 0;
    const avgP = topP.length ? topP[0] : 0;
    raw.set(club, 0.62 * avgD + 0.38 * avgP);
  }
  const pct = percentileMap([...raw.values()]);
  const out = new Map();
  for (const [club, v] of raw) out.set(club, pct(v));
  return out;
}

/**
 * Calcola il punteggio atteso di ogni giocatore.
 * Restituisce nuovi oggetti con `score`, `expShare`, `solidity` e `valueGap`.
 */
export function valuePlayers(players, settings) {
  if (!players.length) return [];

  // Passo 1: punteggio grezzo, senza modificatori. Serve anche a stimare la solidita' dei club.
  const anchors = {};
  for (const role of ROLES) anchors[role] = replacementLevel(players, settings, role);

  const base = new Map();
  for (const p of players) {
    const pts = seasonPoints(p);
    const anchor = anchors[p.role];
    let raw;
    if (pts !== null && anchor !== null) {
      // Punti di stagione guadagnati rispetto a chi prenderei comunque per un credito.
      const vor = Math.max(0, pts - anchor);
      // Valore residuo dei riempitivi: minuscolo, ma sufficiente a ordinarli fra loro.
      raw = vor + expectedShare(p) * 2;
    } else {
      raw = tierOnlyScore(p, settings) * expectedShare(p);
    }
    base.set(p.id, raw);
  }

  const solidity = clubSolidity(players, base);

  // Passo 2: fascia come correttivo e modificatori di lega.
  const out = players.map((p) => {
    let score = base.get(p.id) * (ROLE_WEIGHT[p.role] ?? 1);

    // La fascia del creator corregge del +/-18%: cattura quello che i numeri non dicono.
    if (Number.isFinite(p.tierPct)) score *= 1 + 0.18 * (1 - 2 * p.tierPct);

    const sol = solidity.get(p.team) ?? 0.5;

    if (settings.defenseModifier) {
      if (p.role === 'D') {
        score *= 1.18 + 0.1 * sol;
        // Il creator segna esplicitamente chi aiuta il modificatore: sono voti alti, non bonus.
        if (hasTag(p, 'modificatore')) score *= 1.12;
      }
      if (p.role === 'P') score *= 1.03;
    }

    if (settings.cleanSheetModifier && p.role === 'P') {
      // L'imbattibilita' premia i clean sheet, che la fantamedia del portiere non cattura:
      // conta la solidita' della squadra davanti a lui.
      score *= 1.12 + 0.25 * sol;
      if (hasTag(p, 'imbattibil')) score *= 1.12;
      if (hasTag(p, 'pararigori')) score *= 1.04;
    }

    if ((p.role === 'C' || p.role === 'A') && hasTag(p, 'rigorista')) score *= 1.07;
    if (hasTag(p, 'cartellini')) score *= 0.97;

    return {
      ...p,
      score: Math.round(score * 100) / 100,
      expShare: Math.round(expectedShare(p) * 100) / 100,
      solidity: sol,
    };
  });

  return out;
}

/**
 * Marca i giocatori di prima fascia del proprio ruolo.
 *
 * Serve al vincolo "almeno un top per reparto": un top non e' semplicemente il piu' caro, e'
 * chi i creators mettono nella fascia alta. Quando il listone non ha le fasce si ripiega sul
 * prezzo, prendendo il decimo piu' costoso del ruolo come soglia.
 */
export function markTopPlayers(players, settings) {
  const soglia = Number.isFinite(settings.topThreshold) ? settings.topThreshold : 0.15;
  const perPrezzo = {};
  for (const role of ROLES) {
    const prezzi = players
      .filter((p) => p.role === role)
      .map((p) => p.expectedPrice ?? p.price ?? 0)
      .sort((a, b) => b - a);
    perPrezzo[role] = prezzi.length ? prezzi[Math.min(prezzi.length - 1, Math.max(0, Math.round(prezzi.length * 0.1) - 1))] : Infinity;
  }
  return players.map((p) => ({
    ...p,
    isTop: Number.isFinite(p.tierPct)
      ? p.tierPct <= soglia
      : (p.expectedPrice ?? p.price ?? 0) >= perPrezzo[p.role],
  }));
}

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
 * Il fattore del blocco difensivo in funzione dei difensori effettivi (non delle teste).
 * Passa per gli stessi punti di prima — 2 → 0,04, 3 → 0,11, 4 → 0,14 — ma in mezzo e'
 * continuo: cosi' un quarto difensore che gioca a mezzo servizio conta per meta', e un
 * riempitivo che non schiero mai non fa scattare lo scalino.
 */
function fattoreBlocco(n) {
  if (n <= 1) return 0;
  if (n < 2) return 0.04 * (n - 1);
  if (n < 3) return 0.04 + 0.07 * (n - 2);
  if (n < 4) return 0.11 + 0.03 * (n - 3);
  return 0.14;
}

/**
 * Quanto vale un portiere di riserva come assicurazione: uno se e' il secondo vero del club,
 * niente se e' il terzo che non gioca mai. Il segnale e' la sua quota di impiego: un secondo
 * portiere sta intorno a 0,3, un terzo sotto 0,15.
 */
function pesoRiserva(p) {
  return Math.max(0, Math.min(1, (expectedShare(p) - 0.15) / 0.2));
}

/**
 * Con che peso schiererei i difensori di un blocco.
 *
 * Il blocco cambia chi va in campo: se ho tre difensori dello stesso club li schiero insieme,
 * anche se uno dei tre, preso da solo, sarebbe il mio quarto. Quindi i membri del blocco
 * prendono i pesi da titolare nell'ordine — uno, uno, uno, poi mezzo — e non il rango che
 * avrebbero fra tutti gli otto.
 *
 * Ma solo se sono difensori da schierare davvero. Un giocatore che il modello proietta a
 * tre punti non entra in campo per fare blocco, entra in rosa per gonfiare un bonus: sul
 * listone vero il piano comprava tre riempitivi della Roma con punteggio intorno a uno
 * proprio cosi'. La soglia e' meta' del punteggio del mio ultimo titolare: sotto, uno conta
 * per quanto giocherebbe davvero, cioe' quasi niente.
 */
// I pesi di profondita' dipendono solo dalle impostazioni, che durante una risoluzione non
// cambiano: si calcolano una volta per oggetto impostazioni invece che a ogni chiamata.
const pesiDifesaPerSettings = new WeakMap();
function pesiDifesa(settings) {
  let w = pesiDifesaPerSettings.get(settings);
  if (!w) {
    w = depthWeights(settings, 'D');
    pesiDifesaPerSettings.set(settings, w);
  }
  return w;
}

// Ordine per punteggio e basta. `sortByStrength` spareggia con localeCompare, che e' giusto
// per una lista a schermo e insostenibile qui: questa funzione gira migliaia di volte per
// ogni consiglio, e con quello spareggio la scheda d'asta ci metteva il doppio. A parita' di
// punteggio chi prende quale peso e' indifferente per la somma.
const perPunteggio = (a, b) => (b.score || 0) - (a.score || 0);

function contestoDifesa(selected, settings) {
  const w = pesiDifesa(settings);
  const starters = Math.max(1, settings.starters?.D ?? 3);
  const tutti = [];
  for (const p of selected) if (p.role === 'D') tutti.push(p);
  tutti.sort(perPunteggio);
  const rango = new Map();
  for (let i = 0; i < tutti.length; i++) rango.set(tutti[i].id, w[i] ?? w[w.length - 1] ?? 0.05);
  const ultimoTitolare = tutti[Math.min(starters, tutti.length) - 1];
  return { w, rango, soglia: 0.5 * (ultimoTitolare?.score || 0) };
}

// Il contesto (ordine dei difensori, soglia) e' lo stesso per tutti i club della rosa: si
// calcola una volta per chiamata, non una volta per club.
function pesiBlocco(group, ctx) {
  const { w, rango, soglia } = ctx;
  const out = new Map();
  const plausibili = [];
  for (const p of group) if ((p.score || 0) >= soglia && (p.score || 0) > 0) plausibili.push(p);
  plausibili.sort(perPunteggio);
  for (let i = 0; i < plausibili.length; i++) out.set(plausibili[i].id, w[i] ?? w[w.length - 1] ?? 0.05);
  for (const p of group) if (!out.has(p.id)) out.set(p.id, rango.get(p.id) ?? 0.05);
  return out;
}

/**
 * Bonus di sinergia per un insieme di giocatori gia' scelti.
 * - blocco difensivo: 3+ difensori dello stesso club valgono piu' della somma delle parti
 *   quando c'e' il modificatore di difesa (stessa partita, stesso clean sheet).
 * - portiere di riserva dello stesso club del titolare: assicurazione sull'imbattibilita'.
 *
 * Il blocco conta chi schiero, non chi e' in rosa. Contando le teste il bonus si poteva
 * gonfiare a costo zero: sul listone vero il piano comprava tre difensori della Roma con
 * punteggio intorno a uno — Rensch, Lulli, Ghilardi, gente che non avrei mai messo in campo
 * — perche' ogni testa in piu' valeva dodici punti di bonus, piu' di qualunque titolare vero
 * da due crediti. Il modificatore di difesa lo prendono i difensori schierati: il mio ottavo
 * difensore non ne fa parte, e qui conta per quanto gioca.
 */
export function synergyBonus(selected, settings) {
  if (!selected.length) return 0;
  let bonus = 0;
  const ctx = settings.defenseModifier || settings.cleanSheetModifier ? contestoDifesa(selected, settings) : null;

  if (settings.defenseModifier) {
    const byClub = new Map();
    for (const p of selected) {
      if (p.role !== 'D' || !p.team) continue;
      if (!byClub.has(p.team)) byClub.set(p.team, []);
      byClub.get(p.team).push(p);
    }
    for (const [, group] of byClub) {
      if (group.length < 2) continue;
      const pesi = pesiBlocco(group, ctx);
      let effettivi = 0;
      let sommaPesata = 0;
      for (const p of group) {
        const w = pesi.get(p.id) ?? 0;
        effettivi += w;
        sommaPesata += (p.score || 0) * w;
      }
      const factor = fattoreBlocco(effettivi);
      if (factor <= 0 || effettivi <= 0) continue;
      const avg = sommaPesata / effettivi;
      const sol = group[0].solidity ?? 0.5;
      bonus += avg * factor * (0.6 + 0.8 * sol);
    }
  }

  if (settings.cleanSheetModifier) {
    const gks = selected.filter((p) => p.role === 'P');
    if (gks.length >= 2) {
      // Il titolare e' quello che gioca davvero: se il portiere l'ha scelto l'utente,
      // l'abbinamento deve seguire lui e non un altro. A parita' di punteggio resta l'ordine
      // di arrivo, come prima: spareggiare qui sull'id cambierebbe il club del titolare e con
      // lui il bonus della difesa, e allora perdere un difensore potrebbe far salire la rosa.
      const starter = gks.slice().sort((a, b) => (b.scelto ? 1 : 0) - (a.scelto ? 1 : 0) || (b.score || 0) - (a.score || 0))[0];
      // La riserva vale come assicurazione solo se e' quella che gioca quando il titolare non
      // c'e'. Il terzo portiere del club e' dello stesso club, ma non e' un'assicurazione.
      const riserva = gks
        .filter((p) => p.id !== starter.id && p.team && p.team === starter.team)
        .sort((a, b) => expectedShare(b) - expectedShare(a))[0];
      if (riserva) bonus += (starter.score || 0) * 0.08 * pesoRiserva(riserva);
      const stessoClub = selected.filter((p) => p.role === 'D' && p.team && p.team === starter.team);
      const pesi = pesiBlocco(stessoClub, ctx);
      let difensoriEffettivi = 0;
      for (const p of stessoClub) difensoriEffettivi += pesi.get(p.id) ?? 0;
      if (difensoriEffettivi >= 1.5) bonus += (starter.score || 0) * 0.05 * Math.min(difensoriEffettivi, 4);
    }
  }

  return Math.round(bonus * 100) / 100;
}

/**
 * Quanti giocatori di ogni club schiererei davvero, contando i titolari per uno e i
 * panchinari per la loro frazione di impiego. Sei giocatori della Roma di cui quattro
 * riempitivi da un credito non sono una rosa concentrata: in campo ne vanno due.
 * Ritorna una mappa club -> { inRosa, effettivi }.
 */
export function clubExposure(selected, settings) {
  const out = new Map();
  for (const role of ROLES) {
    const group = sortByStrength(selected.filter((p) => p.role === role));
    const w = depthWeights(settings, role);
    group.forEach((p, i) => {
      if (!p.team) return;
      if (!out.has(p.team)) out.set(p.team, { inRosa: 0, effettivi: 0 });
      const entry = out.get(p.team);
      entry.inRosa += 1;
      entry.effettivi += w[i] ?? w[w.length - 1] ?? 0.05;
    });
  }
  return out;
}

/**
 * Penalita' di concentrazione su un singolo club.
 *
 * I blocchi difensivi sono voluti: il modificatore scatta a soglie e premia i voti che
 * arrivano tutti insieme dalla stessa partita. Ma se meta' degli undici titolari dipende
 * dalla stagione di una sola squadra, una sua annata storta affonda la rosa intera e non
 * lascia scelta su chi schierare.
 */
export function concentrationPenalty(selected, settings) {
  const cap = Number(settings.maxPerClub) || 0;
  if (cap <= 0) return 0;
  const exposure = clubExposure(selected, settings);
  let penalty = 0;
  for (const [team, { effettivi }] of exposure) {
    if (effettivi <= cap) continue;
    const group = selected.filter((p) => p.team === team);
    const avg = group.reduce((a, p) => a + (p.score || 0), 0) / (group.length || 1);
    penalty += (effettivi - cap) * avg * 0.9;
  }
  return penalty;
}

/**
 * Punteggio totale di una rosa: somma dei punteggi pesati per profondita' piu' le sinergie,
 * meno la penalita' per eccesso di giocatori dello stesso club.
 * Dentro ogni ruolo i giocatori vengono ordinati dal migliore al peggiore.
 */
export function rosterScore(selected, settings) {
  let base = 0;
  for (const role of ROLES) {
    const group = sortByStrength(selected.filter((p) => p.role === role));
    const w = depthWeights(settings, role);
    group.forEach((p, i) => {
      base += (p.score || 0) * (w[i] ?? w[w.length - 1] ?? 0.05);
    });
  }
  return Math.round((base + synergyBonus(selected, settings) - concentrationPenalty(selected, settings)) * 100) / 100;
}

/** Compatibilita': punteggio della sola fascia, usato dai test del vecchio modello. */
export function tierScore(settings, role, tier) {
  const order = settings.tierOrder?.[role] || [];
  const idx = order.indexOf(tier);
  const rank = idx >= 0 ? idx : order.length;
  return 100 * Math.pow(TIER_DECAY[role] ?? 0.78, rank);
}
