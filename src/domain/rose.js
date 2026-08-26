// Le rose esportate dalla piattaforma dove si gioca l'asta.
//
// E' il file che risolve il problema piu' grosso dell'assistente: il tabellone degli avversari
// deve sapere chi ha comprato chi e a quanto, e finche' quei due dati mancano puo' solo dare
// limiti superiori — "al massimo possono arrivare a 85" invece di "arrivano a 62". L'export li ha
// entrambi, si scarica anche a meta' asta, e contiene tutte le squadre della lega.
//
// Quindi qui non si ricostruisce un'asta finita: ci si riallinea durante, quando il banditore
// corre piu' di quanto si riesca a segnare.

import { parseCsv, normalizeHeader, parseNumber, normalizeRole, makePlayerId } from './csv.js';
import { indice, abbina } from './incolla.js';

// I nomi che le colonne possono avere. Il primo che combacia vince.
const COLONNE = {
  squadra: ['squadra', 'team', 'fantasquadra', 'squadra fantacalcio', 'proprietario', 'allenatore'],
  nome: ['nome', 'giocatore', 'calciatore', 'player'],
  club: ['squadra appartenenza', 'squadra serie a', 'club', 'squadra reale', 'sq'],
  ruolo: ['ruolo', 'r', 'ruolo classic'],
  prezzo: ['prezzo', 'costo', 'pagato', 'crediti', 'price'],
  quo: ['quotazione', 'quota', 'qt', 'qt a'],
};

/**
 * Quale colonna e' quale.
 *
 * `squadra` e `nome` si assomigliano parecchio ("Squadra" contro "Squadra_Appartenenza") e in
 * questo file convivono: si assegnano per corrispondenza esatta sul nome normalizzato, senza
 * ripieghi per sottostringa che le farebbero collidere.
 */
export function mappaColonne(headers) {
  const norm = headers.map((h) => normalizeHeader(h));
  const usate = new Set();
  const out = {};
  for (const [campo, sinonimi] of Object.entries(COLONNE)) {
    for (const s of sinonimi) {
      const i = norm.findIndex((h, k) => h === s && !usate.has(k));
      if (i >= 0) {
        out[campo] = headers[i];
        usate.add(i);
        break;
      }
    }
  }
  return out;
}

/**
 * Legge l'export e abbina ogni riga al listone.
 *
 * L'abbinamento prova prima la strada esatta: l'id del listone e' costruito da nome, club e ruolo
 * (`makePlayerId`), e l'export ha tutti e tre. Quando combaciano non c'e' niente da indovinare.
 * Quando non combaciano — perche' una delle due parti abbrevia il club diversamente, o scrive
 * "Martinez L." dove l'altra scrive "Lautaro Martinez" — si ricade sul lettore dell'incolla, che
 * quella parte la sa gia' fare, e si usa il ruolo per sciogliere le omonimie che restano: e' il
 * dato in piu' che il testo incollato non aveva.
 */
export function leggiRose(testo, players) {
  const { headers, rows } = parseCsv(testo);
  if (!rows.length) return { ok: false, motivo: 'Il file non contiene righe leggibili.' };

  const col = mappaColonne(headers);
  if (!col.squadra || !col.nome) {
    return {
      ok: false,
      motivo: `Non trovo le colonne della squadra e del giocatore. Le intestazioni lette sono: ${headers.join(', ')}.`,
      headers,
    };
  }

  const idx = indice(players);
  const byId = new Map(players.map((p) => [p.id, p]));
  const righe = [];
  const squadre = [];
  const visti = new Set();

  for (const r of rows) {
    const nome = String(r[col.nome] ?? '').trim();
    if (!nome) continue;
    const squadra = String(r[col.squadra] ?? '').trim();
    const club = col.club ? String(r[col.club] ?? '').trim() : '';
    const ruolo = col.ruolo ? normalizeRole(r[col.ruolo]) : null;
    const prezzo = col.prezzo ? parseNumber(r[col.prezzo]) : null;
    const quo = col.quo ? parseNumber(r[col.quo]) : null;

    if (squadra && !squadre.includes(squadra)) squadre.push(squadra);

    const base = { squadra, nome, club, ruolo, prezzo: Number.isFinite(prezzo) ? Math.max(0, Math.round(prezzo)) : null, quo };
    const player = trovaGiocatore({ nome, club, ruolo, quo }, byId, idx);
    if (!player) {
      righe.push({ ...base, esito: 'sconosciuto', player: null });
      continue;
    }
    if (player.ambigui) {
      righe.push({ ...base, esito: 'ambiguo', player: null, candidati: player.ambigui });
      continue;
    }
    // Lo stesso giocatore due volte nel file: la seconda riga si segnala invece di sovrascrivere
    // in silenzio, perche' vorrebbe dire che una delle due attribuzioni e' sbagliata.
    if (visti.has(player.id)) {
      righe.push({ ...base, esito: 'duplicato', player });
      continue;
    }
    visti.add(player.id);
    righe.push({ ...base, esito: 'trovato', player });
  }

  const conta = { trovato: 0, ambiguo: 0, sconosciuto: 0, duplicato: 0 };
  for (const r of righe) conta[r.esito] += 1;
  return { ok: true, righe, squadre, conta, colonne: col, headers };
}

function trovaGiocatore({ nome, club, ruolo, quo }, byId, idx) {
  // 1. La stessa ricetta con cui il listone costruisce i suoi id.
  if (club && ruolo) {
    const diretto = byId.get(makePlayerId(nome, club, ruolo));
    if (diretto) return diretto;
  }

  // 2. Il lettore dell'incolla: normalizza il nome, ripiega sul cognome, usa il club per le
  //    omonimie. Il club va dentro `testo` perche' e' li' che lo cerca.
  const m = abbina({ testo: `${nome} ${club}`.trim(), nome, altri: [], prezzo: null }, idx);
  if (m.esito === 'trovato') return m.player;
  if (m.esito !== 'ambiguo') return null;

  // 3. Quel che resta lo scioglie il ruolo, e se non basta la quotazione.
  let restano = m.candidati;
  if (ruolo) {
    const perRuolo = restano.filter((p) => p.role === ruolo);
    if (perRuolo.length === 1) return perRuolo[0];
    if (perRuolo.length) restano = perRuolo;
  }
  if (Number.isFinite(quo)) {
    const perQuo = restano.filter((p) => Number(p.quo) === Number(quo));
    if (perQuo.length === 1) return perQuo[0];
  }
  return { ambigui: restano };
}
