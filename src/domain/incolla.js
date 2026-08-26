// Registrare a mano duecento aggiudicazioni durante un'asta non e' realistico. Se la piattaforma
// dove si gioca mostra l'elenco di chi e' gia' stato venduto, incollarlo qui e' molto piu' veloce
// che segnare un giocatore alla volta: il conto dei crediti torna esatto in un colpo.
//
// Il formato non si puo' sapere in anticipo, quindi il lettore non ne pretende nessuno: cerca in
// ogni riga un nome che assomigli a qualcuno del listone e, se c'e', un prezzo. Tutto il resto
// (numeri di riga, ruoli, sigle di squadra, separatori) viene ignorato.

import { ROLES } from './model.js';

/** Toglie accenti, punteggiatura e maiuscole: due scritture dello stesso nome devono coincidere. */
export function chiave(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Il cognome, cioe' la prima parola: i listoni scrivono "Martinez L." dove altrove sta "Lautaro Martinez". */
function cognome(nome) {
  const k = chiave(nome);
  const parti = k.split(' ').filter((w) => w.length > 1);
  return parti[0] || k;
}

const RUOLI_PAROLA = /^(p|por|portiere|d|dif|difensore|c|cen|centrocampista|a|att|attaccante)$/;

/**
 * Indice di ricerca sul listone.
 * Un cognome puo' appartenere a piu' giocatori: in quel caso serve la squadra per decidere, e
 * senza squadra la riga resta ambigua invece di essere assegnata a caso.
 */
export function indice(players) {
  const perNome = new Map();
  const perCognome = new Map();
  for (const p of players) {
    const n = chiave(p.name);
    if (!perNome.has(n)) perNome.set(n, []);
    perNome.get(n).push(p);
    const c = cognome(p.name);
    if (!perCognome.has(c)) perCognome.set(c, []);
    perCognome.get(c).push(p);
  }
  return { perNome, perCognome, players };
}

/**
 * Legge una riga: il prezzo e' l'ultimo numero intero della riga, il nome e' quello che resta
 * una volta tolti numeri, sigle di ruolo e separatori.
 */
export function leggiRiga(riga) {
  const grezza = String(riga);
  // La riga compattata serve solo a cercare la squadra; per separare i campi si usa quella
  // originale, perche' schiacciare le tabulazioni in spazi cancella proprio il separatore.
  const testo = grezza.replace(/\s+/g, ' ').trim();
  if (!testo) return null;

  // Un prezzo credibile: intero, non attaccato a lettere, non una data.
  const numeri = [...testo.matchAll(/(?<![\w.,])(\d{1,3})(?![\w.,%])/g)].map((m) => Number(m[1]));
  const prezzo = numeri.length ? numeri[numeri.length - 1] : null;

  // Le parentesi separano quasi sempre la squadra dal nome: vanno trattate come un separatore.
  const parole = grezza
    .split(/[;,|\t()\[\]]|\s[-–—]\s|\s{2,}/)
    .map((x) => x.trim())
    .filter(Boolean);

  // Il pezzo con piu' lettere e' quasi sempre il nome.
  const candidati = parole
    .map((x) => x.replace(/(?<![\w.,])\d{1,3}(?![\w.,%])/g, '').trim())
    .filter((x) => chiave(x).replace(/ /g, '').length >= 3 && !RUOLI_PAROLA.test(chiave(x)));
  if (!candidati.length) return null;
  candidati.sort((a, b) => chiave(b).replace(/ /g, '').length - chiave(a).replace(/ /g, '').length);

  return { testo, nome: candidati[0], altri: candidati.slice(1), prezzo };
}

/**
 * Abbina una riga letta a un giocatore del listone.
 * Ritorna sempre un esito, anche negativo: chi incolla deve poter vedere cosa non e' passato,
 * non ritrovarsi con meta' elenco sparito in silenzio.
 */
export function abbina(letta, idx, { escludi = new Set() } = {}) {
  const n = chiave(letta.nome);
  const diretti = (idx.perNome.get(n) || []).filter((p) => !escludi.has(p.id));
  if (diretti.length === 1) return { esito: 'trovato', player: diretti[0], ...letta };
  if (diretti.length > 1) {
    const perSquadra = filtraPerSquadra(diretti, letta);
    if (perSquadra.length === 1) return { esito: 'trovato', player: perSquadra[0], ...letta };
    return { esito: 'ambiguo', candidati: diretti, ...letta };
  }

  const perCognome = (idx.perCognome.get(cognome(letta.nome)) || []).filter((p) => !escludi.has(p.id));
  if (perCognome.length === 1) return { esito: 'trovato', player: perCognome[0], ...letta };
  if (perCognome.length > 1) {
    const perSquadra = filtraPerSquadra(perCognome, letta);
    if (perSquadra.length === 1) return { esito: 'trovato', player: perSquadra[0], ...letta };
    return { esito: 'ambiguo', candidati: perCognome, ...letta };
  }

  return { esito: 'sconosciuto', ...letta };
}

/**
 * Scioglie un'omonimia cercando la squadra nella riga.
 * Si guarda l'intera riga e non i soli pezzi avanzati, perche' spesso la squadra e' attaccata
 * al nome nella stessa cella ("Martinez L. INT") e ritagliarla in anticipo non e' affidabile.
 */
function filtraPerSquadra(candidati, letta) {
  const riga = chiave(letta.testo);
  const conSquadra = candidati.filter((p) => {
    const t = chiave(p.team);
    if (!t || t.length < 3) return false;
    return new RegExp(`(^| )${t}( |$)`).test(riga);
  });
  if (conSquadra.length) return conSquadra;
  // Ripiego sulle prime lettere: i listoni abbreviano ("INT" per Inter, "ROM" per Roma).
  return candidati.filter((p) => {
    const t = chiave(p.team);
    if (t.length < 3) return false;
    return new RegExp(`(^| )${t.slice(0, 3)}[a-z]*( |$)`).test(riga);
  });
}

/**
 * Legge un elenco incollato per intero.
 * `escludi` sono i giocatori gia' assegnati: una riga che ricade su uno di loro viene segnalata
 * come duplicato invece di riassegnarlo, cosi' incollare due volte non fa danni.
 */
export function leggiElenco(testo, players, { gia = new Set() } = {}) {
  const idx = indice(players);
  const righe = String(testo || '').split(/\r?\n/);
  const esiti = [];
  const presi = new Set();

  for (const riga of righe) {
    const letta = leggiRiga(riga);
    if (!letta) continue;
    // L'abbinamento non esclude chi e' gia' preso: serve riconoscerlo per poterlo chiamare
    // duplicato. Escluderlo lo farebbe ricadere su un omonimo, o sparire come sconosciuto.
    const m = abbina(letta, idx);
    if (m.esito === 'trovato' && (gia.has(m.player.id) || presi.has(m.player.id))) {
      esiti.push({ ...m, esito: 'duplicato' });
      continue;
    }
    if (m.esito === 'trovato') presi.add(m.player.id);
    esiti.push(m);
  }

  const conta = { trovato: 0, ambiguo: 0, sconosciuto: 0, duplicato: 0 };
  for (const e of esiti) conta[e.esito] += 1;
  return {
    esiti,
    conta,
    conPrezzo: esiti.filter((e) => e.esito === 'trovato' && Number.isFinite(e.prezzo) && e.prezzo > 0).length,
    perRuolo: Object.fromEntries(
      ROLES.map((r) => [r, esiti.filter((e) => e.esito === 'trovato' && e.player.role === r).length])
    ),
  };
}
