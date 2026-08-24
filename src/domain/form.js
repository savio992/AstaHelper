// Rendimento nelle giornate gia' giocate.
//
// Le proiezioni dei creators sono fatte prima che il campionato inizi. Appena si gioca,
// arrivano informazioni vere: chi e' partito titolare, chi e' rimasto fuori, chi sta segnando.
// Vanno pesate per quello che valgono: dopo una giornata su trentotto un fantavoto alto e'
// quasi solo rumore, mentre sapere che un giocatore e' sceso in campo dal primo minuto toglie
// incertezza sulla sua titolarita', che nel modello e' il fattore piu' pesante.

import { normalizeHeader, parseNumber } from './csv.js';

// Quanto pesa la stagione in corso rispetto alla proiezione, espresso in "giornate equivalenti".
// Piu' alto il numero, piu' servono partite prima di dare retta ai dati nuovi.
const PESO_PROIEZIONE_MINUTI = 5;
const PESO_PROIEZIONE_VOTI = 9;

/** Un giocatore si considera titolare se ha giocato almeno un'ora. */
const MINUTI_TITOLARE = 60;

function chiave(nome) {
  return normalizeHeader(nome).replace(/\s+/g, ' ').trim();
}

/**
 * Aggrega le righe di un file di voti per giocatore.
 * Il file puo' avere una riga per giornata o gia' i totali: in entrambi i casi si sommano
 * minuti e presenze e si media il fantavoto.
 */
export function aggregateForm(rows, mapping) {
  const perGiocatore = new Map();
  const giornate = new Set();

  for (const row of rows) {
    const nome = mapping.name ? (row[mapping.name] || '').trim() : '';
    if (!nome) continue;
    const k = chiave(nome);
    if (!perGiocatore.has(k)) {
      perGiocatore.set(k, {
        nome,
        squadra: mapping.team ? (row[mapping.team] || '').trim() : '',
        presenze: 0,
        titolarita: 0,
        minuti: 0,
        sommaVoti: 0,
        sommaFantavoti: 0,
        conVoto: 0,
      });
    }
    const g = perGiocatore.get(k);
    const giornata = mapping.giornata ? parseNumber(row[mapping.giornata]) : null;
    if (Number.isFinite(giornata)) giornate.add(giornata);

    const minuti = mapping.minutes ? parseNumber(row[mapping.minutes]) : null;
    const voto = mapping.mediavoto ? parseNumber(row[mapping.mediavoto]) : null;
    const fantavoto = mapping.fantamedia ? parseNumber(row[mapping.fantamedia]) : null;
    const presenze = mapping.matches ? parseNumber(row[mapping.matches]) : null;

    if (Number.isFinite(minuti)) {
      g.minuti += minuti;
      if (minuti > 0) g.presenze += Number.isFinite(presenze) ? presenze : 1;
      if (minuti >= MINUTI_TITOLARE) g.titolarita += 1;
    } else if (Number.isFinite(presenze)) {
      g.presenze += presenze;
    } else if (Number.isFinite(voto) || Number.isFinite(fantavoto)) {
      g.presenze += 1;
    }

    if (Number.isFinite(voto)) g.sommaVoti += voto;
    if (Number.isFinite(fantavoto)) g.sommaFantavoti += fantavoto;
    if (Number.isFinite(voto) || Number.isFinite(fantavoto)) g.conVoto += 1;
  }

  const out = new Map();
  for (const [k, g] of perGiocatore) {
    out.set(k, {
      ...g,
      mediavoto: g.conVoto ? g.sommaVoti / g.conVoto : null,
      fantamedia: g.conVoto ? g.sommaFantavoti / g.conVoto : null,
    });
  }
  return { form: out, giornate: giornate.size };
}

/** Sinonimi aggiuntivi per i file di voti, che hanno colonne diverse dai listoni. */
export function formMapping(headers) {
  const norm = headers.map((h) => ({ header: h, n: normalizeHeader(h) }));
  const trova = (...sinonimi) => {
    for (const s of sinonimi) {
      const hit = norm.find((h) => h.n === s);
      if (hit) return hit.header;
    }
    for (const s of sinonimi) {
      const hit = norm.find((h) => h.n.startsWith(s + ' ') || h.n.endsWith(' ' + s));
      if (hit) return hit.header;
    }
    return undefined;
  };
  return {
    name: trova('nome', 'giocatore', 'calciatore'),
    team: trova('squadra', 'team', 'club'),
    giornata: trova('giornata', 'gv', 'g', 'gior'),
    minutes: trova('minuti', 'min', 'minuti giocati'),
    mediavoto: trova('voto', 'v', 'media voto', 'mv'),
    fantamedia: trova('fantavoto', 'fv', 'fantamedia', 'fm'),
    matches: trova('presenze', 'pg', 'partite'),
  };
}

/**
 * Fonde il rendimento osservato nelle proiezioni.
 *
 * Il peso dei dati nuovi cresce con le giornate giocate: dopo una giornata la proiezione del
 * creator resta quasi intatta, dopo dieci comanda il campo. E' la sola cosa onesta da fare
 * con un campione piccolo, e senza questo accorgimento un attaccante che ha segnato una
 * doppietta alla prima diventerebbe il miglior giocatore del listone.
 */
export function applyForm(players, form, giornate) {
  if (!form || !form.size || !giornate) return players;

  return players.map((p) => {
    const osservato = form.get(chiave(p.name));
    if (!osservato) return p;

    // Titolarita': la quota di partite iniziate, mescolata con il giudizio del creator.
    const quotaOsservata = Math.min(1, osservato.titolarita / giornate);
    const quotaAttesa = Number.isFinite(p.titolarita) ? Math.min(1, p.titolarita / 5) : 0.5;
    const pesoMin = giornate / (giornate + PESO_PROIEZIONE_MINUTI);
    const quota = quotaAttesa * (1 - pesoMin) + quotaOsservata * pesoMin;

    // Fantamedia: stessa logica, con un peso piu' prudente perche' i voti oscillano di piu'.
    let fmvExp = p.fmvExp;
    if (Number.isFinite(osservato.fantamedia) && osservato.conVoto > 0 && Number.isFinite(p.fmvExp)) {
      const pesoVoti = osservato.conVoto / (osservato.conVoto + PESO_PROIEZIONE_VOTI);
      fmvExp = p.fmvExp * (1 - pesoVoti) + osservato.fantamedia * pesoVoti;
    }

    return {
      ...p,
      titolarita: Math.max(0, Math.min(5, quota * 5)),
      fmvExp: Number.isFinite(fmvExp) ? Math.round(fmvExp * 100) / 100 : p.fmvExp,
      form: {
        giornate,
        presenze: osservato.presenze,
        daTitolare: osservato.titolarita,
        minuti: osservato.minuti,
        fantamedia: osservato.fantamedia,
        mediavoto: osservato.mediavoto,
      },
    };
  });
}

/** Quanti giocatori del listone hanno trovato corrispondenza nel file dei voti. */
export function matchCount(players, form) {
  if (!form) return 0;
  let n = 0;
  for (const p of players) if (form.has(chiave(p.name))) n++;
  return n;
}
