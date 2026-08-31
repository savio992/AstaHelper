// Le strade possibili, non la strada.
//
// L'ottimizzatore da' una rosa sola: la migliore. Ma un'asta non si gioca su una rosa sola,
// si gioca su un'idea — "il portiere forte e il blocco Inter", "niente portiere top e due
// attaccanti da trenta" — e quell'idea o regge o muore a seconda di chi riesci a prendere.
// Finche' resta implicita nel piano, quando salta un giocatore non si capisce se e' saltato
// un nome o se e' saltata la strada.
//
// Qui le strade si rendono esplicite: se ne generano alcune davvero diverse, si salvano, e a
// ogni assegnazione si guarda quali sono ancora percorribili. La domanda smette di essere
// "chi prendo al posto di Svilar" e diventa "quale delle mie strade e' ancora viva".
//
// Il motore c'era gia' e buttava via il lavoro: le ripartenze dell'ottimizzatore rifanno il
// piano escludendo a turno una scelta cara, ottengono rose alternative valide e ne tengono
// solo la migliore. Qui si tengono tutte.

import { ROLE_LABEL_SHORT } from './model.js';
import { optimizeRoster, CONFIG_SOLUTORE } from './optimizer.js';

// Quanti perni provare a togliere. Ogni perno costa un'ottimizzazione intera: sei tiene il
// tasto sotto il secondo sui listoni veri e basta e avanza per trovare quattro strade diverse,
// perche' le scelte piu' care sono anche quelle che cambiano di piu' il resto della rosa.
const PERNI = 6;

// Quanti giocatori devono cambiare perche' due rose siano "strade diverse" e non la stessa
// strada con un riempitivo scambiato.
const DIVERSITA_MINIMA = 2;

// Quanto punteggio si perde per scendere di una stella. Sui listoni veri due piani sensati
// distano il 2-3%: con una scala piu' larga finirebbero tutti a cinque stelle e il voto non
// direbbe niente.
const PERDITA_PER_STELLA = 0.02;

/** Firma di una rosa: l'insieme dei suoi giocatori, per riconoscere i doppioni. */
function firma(piano) {
  return [...piano.picks, ...piano.owned].map((p) => p.id).sort().join('|');
}

/** Quanti giocatori distinguono due rose. */
function distanza(a, b) {
  const setB = new Set(b);
  let n = 0;
  for (const id of a) if (!setB.has(id)) n++;
  return n;
}

/**
 * Il voto in stelle, da 1 a 5 a mezze stelle.
 *
 * Non e' un voto assoluto — una rosa "forte" in senso assoluto non esiste, dipende da quanto
 * e' ricco il listone e da quanto e' rimasto sul mercato. E' quanto questa rosa vale rispetto
 * alla migliore ancora ottenibile adesso: cinque stelle vuol dire "meglio di cosi' non si
 * puo' fare oggi". E' anche il motivo per cui il voto di una strada salvata scende da solo
 * mentre l'asta va avanti e i suoi giocatori se ne vanno.
 */
export function stelle(score, riferimento) {
  if (!(riferimento > 0) || !Number.isFinite(score)) return null;
  const perdita = Math.max(0, (riferimento - score) / riferimento);
  const voto = 5 - perdita / PERDITA_PER_STELLA;
  return Math.max(1, Math.min(5, Math.round(voto * 2) / 2));
}

/**
 * Il nome della strada: cosa ha questa rosa che le altre non hanno.
 *
 * Si battezza dopo aver scelto quali strade tenere, perche' il nome deve distinguerla dalle
 * sue sorelle: tre strade chiamate tutte "Con Lautaro" sarebbero tre nomi e nessuna
 * informazione.
 */
function battezza(piano, base, perno, presi) {
  const idsBase = new Set([...base.picks, ...base.owned].map((p) => p.id));
  const nuovi = piano.picks
    .filter((p) => !idsBase.has(p.id))
    .sort((a, b) => b.plannedPrice - a.plannedPrice);
  for (const p of nuovi) {
    const nome = `Con ${p.name}`;
    if (!presi.has(nome)) return nome;
  }
  const senza = perno ? `Senza ${perno.name}` : 'Alternativa';
  return presi.has(senza) ? `${senza} (2)` : senza;
}

/**
 * Genera fino a `quante` rose diverse fra loro, la migliore per prima.
 *
 * Si ottengono togliendo a turno una delle scelte piu' care del piano migliore: e' il modo
 * economico di forzare una strada davvero diversa, perche' un giocatore da quaranta crediti
 * in meno libera abbastanza budget da cambiare un reparto intero. Togliere un riempitivo da
 * un credito darebbe la stessa rosa con un nome diverso.
 *
 * I lucchetti dell'utente non si toccano mai: se hai deciso che quel giocatore lo vuoi, non
 * e' un perno da provare a togliere, e' un vincolo.
 */
export function generaScenari({
  players,
  settings,
  owned = new Map(),
  unavailable = new Set(),
  obbligati = new Set(),
  quante = 4,
  base = null,
} = {}) {
  const ctx = { players, settings, owned, obbligati, ...CONFIG_SOLUTORE };
  const migliore = base?.ok ? base : optimizeRoster({ ...ctx, unavailable });
  if (!migliore.ok) return { base: migliore, scenari: [] };

  const perni = migliore.picks
    .filter((p) => !obbligati.has(p.id))
    .sort((a, b) => b.plannedPrice - a.plannedPrice)
    .slice(0, PERNI);

  const voce = (piano, perno) => ({
    perno,
    piano,
    score: piano.score,
    costo: piano.cost,
    ids: [...piano.picks, ...piano.owned].map((p) => p.id),
    // I prezzi previsti si salvano con la strada: sono il metro con cui, piu' avanti, si
    // misura quanto e' grave un giocatore perso. Perdere il perno da quarantaquattro crediti
    // e perdere cinque riempitivi da uno non e' la stessa cosa, e a contare le teste sembra.
    prezzi: Object.fromEntries([...piano.picks, ...piano.owned].map((p) => [p.id, p.plannedPrice ?? p.paid ?? 1])),
  });

  const viste = new Set([firma(migliore)]);
  const attuale = voce(migliore, null);
  attuale.attuale = true;
  const trovati = [];
  for (const perno of perni) {
    const senza = new Set(unavailable);
    senza.add(perno.id);
    const alt = optimizeRoster({ ...ctx, unavailable: senza });
    if (!alt.ok) continue;
    const f = firma(alt);
    if (viste.has(f)) continue;
    viste.add(f);
    trovati.push(voce(alt, perno));
  }

  // Fra due rose quasi uguali si tiene la piu' forte: mostrare due strade che differiscono per
  // un riempitivo occuperebbe un posto senza offrire una scelta.
  trovati.sort((a, b) => b.score - a.score);
  const scelti = [attuale];
  for (const s of trovati) {
    if (scelti.length >= quante) break;
    if (scelti.every((g) => distanza(s.ids, g.ids) >= DIVERSITA_MINIMA)) scelti.push(s);
  }

  // Il piano di partenza non e' per forza il migliore, ed e' giusto che si veda.
  //
  // La programmazione dinamica e' esatta sulla parte separabile del punteggio ma cieca alla
  // sinergia, e l'ottimizzatore fa una ripartenza sola. Cercare le strade ne fa sei, quindi
  // ogni tanto ne trova una che vale piu' del piano corrente: sul listone di prova 1536
  // contro 1522. Metterla comunque sotto il piano attuale, o dargli cinque stelle per
  // definizione, vorrebbe dire nascondere l'unica cosa utile che questo tasto ha scoperto.
  const riferimento = Math.max(...scelti.map((s) => s.score));
  for (const s of scelti) s.stelle = stelle(s.score, riferimento);
  scelti.sort((a, b) => b.score - a.score);

  const nomi = new Set();
  for (const s of scelti) {
    s.nome = s.attuale ? 'Piano attuale' : battezza(s.piano, migliore, s.perno, nomi);
    nomi.add(s.nome);
    s.meglioDelPiano = s.score > attuale.score;
  }
  return { base: migliore, scenari: scelti, migliorabile: riferimento > attuale.score };
}

/**
 * Che fine ha fatto una strada salvata.
 *
 * Si rimette in piedi il piano imponendo i giocatori della strada che sono ancora liberi: se
 * il solutore ci riesce la strada e' percorribile, e il costo che riporta e' quanto costa
 * oggi percorrerla — non quanto costava quando l'hai salvata. Se non ci riesce, la strada e'
 * chiusa, e conviene saperlo prima di continuare a tenere crediti da parte per lei.
 *
 * I giocatori persi non la uccidono da soli: il piano si rifa' senza di loro e si guarda
 * quanto scende il voto. Perdere la quarta scelta e' una graffiatura, perdere il perno e'
 * un'altra cosa, e la differenza si vede nelle stelle invece che a occhio.
 */
export function valutaScenario({
  scenario,
  players,
  settings,
  owned = new Map(),
  unavailable = new Set(),
  obbligati = new Set(),
  riferimento = null,
} = {}) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const ids = scenario?.ids || [];
  const mancanti = ids.filter((id) => !byId.has(id));
  const presi = ids.filter((id) => owned.has(id));
  const persi = ids.filter((id) => byId.has(id) && !owned.has(id) && unavailable.has(id));
  const liberi = ids.filter((id) => byId.has(id) && !owned.has(id) && !unavailable.has(id));

  const base = riferimento?.ok
    ? riferimento
    : optimizeRoster({ players, settings, owned, unavailable, obbligati, ...CONFIG_SOLUTORE });

  const piano = optimizeRoster({
    players,
    settings,
    owned,
    unavailable,
    obbligati: new Set([...obbligati, ...liberi]),
    ...CONFIG_SOLUTORE,
  });

  const idsPiano = piano.ok ? new Set([...piano.picks, ...piano.owned].map((p) => p.id)) : new Set();
  const entrati = piano.ok
    ? piano.picks.filter((p) => !ids.includes(p.id) && !liberi.includes(p.id)).sort((a, b) => b.plannedPrice - a.plannedPrice)
    : [];

  const prezzo = (id) => Math.max(1, Math.round(scenario?.prezzi?.[id] ?? byId.get(id)?.expectedPrice ?? 1));
  const valoreTotale = ids.reduce((s, id) => s + prezzo(id), 0);
  const persoInCrediti = persi.reduce((s, id) => s + prezzo(id), 0);

  let stato;
  if (!piano.ok) stato = 'morta';
  else if (presi.length === ids.length && ids.length) stato = 'completata';
  else if (persi.length) stato = 'ferita';
  else stato = 'viva';

  return {
    stato,
    piano,
    presi: presi.map((id) => byId.get(id)),
    persi: persi.map((id) => ({ ...byId.get(id), previsto: prezzo(id) })).sort((a, b) => b.previsto - a.previsto),
    liberi: liberi.map((id) => byId.get(id)),
    mancanti,
    entrati,
    persoInCrediti,
    valoreTotale,
    // Quanta parte della strada, misurata in crediti previsti, e' finita agli avversari.
    quotaPersa: valoreTotale ? persoInCrediti / valoreTotale : 0,
    costo: piano.ok ? piano.cost : null,
    // Quanto costano ancora i giocatori della strada che non hai: e' la cifra che devi
    // tenere da parte se vuoi restare su questa strada.
    daSpendere: liberi.reduce((s, id) => s + Math.max(1, Math.round(byId.get(id).expectedPrice ?? 1)), 0),
    stelle: piano.ok && base.ok ? stelle(piano.score, Math.max(piano.score, base.score)) : null,
    idsPiano,
  };
}

/**
 * Il nucleo di una strada: i giocatori che la fanno essere quella strada.
 *
 * Si prendono i piu' cari finche' non coprono la quota indicata del costo totale. Sotto quella
 * soglia restano i riempitivi, che sono intercambiabili per costruzione: imporli al solutore
 * non aggiungerebbe niente e gli toglierebbe il margine con cui assorbe i rincari.
 */
export function nucleoScenario(scenario, quota = 0.8) {
  const prezzi = scenario?.prezzi || {};
  const ids = (scenario?.ids || []).filter((id) => id in prezzi);
  const totale = ids.reduce((s, id) => s + prezzi[id], 0);
  if (!totale) return [...(scenario?.ids || [])];
  const ordinati = ids.slice().sort((a, b) => prezzi[b] - prezzi[a]);
  const out = [];
  let acc = 0;
  for (const id of ordinati) {
    out.push(id);
    acc += prezzi[id];
    if (acc >= totale * quota) break;
  }
  return out;
}

/** Riassunto in una riga, per la scheda e per il registro. */
export function descriviScenario(voce) {
  const nomi = (lista, n = 3) => {
    const testa = lista.slice(0, n).map((p) => `${p.name} (${p.previsto ?? Math.round(p.plannedPrice ?? 0)})`).join(', ');
    const resto = lista.length - n;
    return resto > 0 ? `${testa} e altri ${resto}` : testa;
  };
  switch (voce.stato) {
    case 'completata':
      return 'Presa tutta.';
    case 'morta':
      return `Chiusa: ${voce.piano?.reason || 'i giocatori che restano non ci stanno piu\' nel budget.'}`;
    case 'ferita': {
      const quota = Math.round(voce.quotaPersa * 100);
      const sostituti = voce.entrati.length ? ` Al loro posto ${nomi(voce.entrati, 2)}.` : ' Senza sostituti equivalenti.';
      return `Persi ${voce.persoInCrediti} crediti su ${voce.valoreTotale} (${quota}%): ${nomi(voce.persi)}.${sostituti}`;
    }
    default:
      return `Intatta: mancano ${voce.liberi.length} giocatori per ${voce.daSpendere} crediti.`;
  }
}
