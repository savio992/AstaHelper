// Parsing CSV robusto e mappatura colonne per gli export dei listoni (Fantalab, Fantacalcio.it, ecc.)
// Nessuna dipendenza esterna: l'app deve girare offline da un singolo file.

export const DELIMITERS = [';', ',', '\t', '|'];

/** Sceglie il separatore piu' plausibile: quello con conteggio piu' regolare fra le righe. */
export function sniffDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  if (!lines.length) return ',';
  let best = ',';
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => splitLine(l, d).length);
    // Il conteggio di riferimento e' quello piu' frequente: la prima riga puo' essere
    // un titolo o una legenda e non rispetta la struttura della tabella.
    const freq = new Map();
    for (const c of counts) freq.set(c, (freq.get(c) || 0) + 1);
    let mode = 1;
    let modeCount = 0;
    for (const [c, n] of freq) {
      if (c >= 2 && (n > modeCount || (n === modeCount && c > mode))) {
        mode = c;
        modeCount = n;
      }
    }
    if (mode < 2) continue;
    const score = (modeCount / counts.length) * 10 + Math.min(mode, 30) / 30;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function splitLine(line, delimiter) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Parsing completo con supporto a virgolette e newline dentro i campi.
 * Ritorna { headers, rows } dove rows e' un array di oggetti { header: valore }.
 */
export function parseCsv(text, delimiter) {
  const clean = text.replace(/^﻿/, '');
  const d = delimiter || sniffDelimiter(clean);
  const records = [];
  let field = '';
  let record = [];
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === d) {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || record.length) {
    record.push(field);
    records.push(record);
  }

  const grid = records.filter((r) => r.some((c) => c.trim() !== ''));
  if (!grid.length) return { headers: [], rows: [], delimiter: d };

  return { ...gridToTable(grid), delimiter: d };
}

/**
 * Da griglia di celle a tabella con intestazioni.
 * Alcuni export mettono titolo o legenda prima della tabella vera: si sceglie come
 * intestazione la prima riga con almeno 3 celle non vuote e pochi numeri puri.
 */
export function gridToTable(grid) {
  const rowsRaw = grid.filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  if (!rowsRaw.length) return { headers: [], rows: [] };

  let headerIdx = 0;
  for (let i = 0; i < Math.min(rowsRaw.length, 10); i++) {
    const cells = rowsRaw[i].map((c) => String(c ?? '').trim()).filter(Boolean);
    const looksNumeric = cells.filter((c) => /^-?\d+([.,]\d+)?$/.test(c)).length;
    if (cells.length >= 3 && looksNumeric <= cells.length / 3) {
      headerIdx = i;
      break;
    }
  }

  const headers = dedupeHeaders(rowsRaw[headerIdx].map((h, i) => String(h ?? '').trim() || `col_${i + 1}`));
  const rows = [];
  for (let i = headerIdx + 1; i < rowsRaw.length; i++) {
    const raw = rowsRaw[i];
    const obj = {};
    headers.forEach((h, j) => {
      obj[h] = String(raw[j] ?? '').trim();
    });
    rows.push(obj);
  }
  return { headers, rows };
}

/**
 * Unisce i fogli di un xlsx in un'unica tabella.
 * I listoni dei creators hanno un foglio per ruolo: il nome del foglio serve da
 * ruolo di riserva se la colonna Ruolo manca.
 */
export function sheetsToTable(sheets) {
  const headers = [];
  const rows = [];
  for (const sheet of sheets) {
    const table = gridToTable(sheet.grid);
    if (!table.rows.length) continue;
    for (const h of table.headers) if (!headers.includes(h)) headers.push(h);
    for (const row of table.rows) rows.push({ ...row, __foglio: sheet.name });
  }
  return { headers, rows, sheetNames: sheets.map((s) => s.name) };
}

function dedupeHeaders(headers) {
  const seen = new Map();
  return headers.map((h) => {
    const n = (seen.get(h) || 0) + 1;
    seen.set(h, n);
    return n === 1 ? h : `${h} (${n})`;
  });
}

export function normalizeHeader(h) {
  return String(h)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Sinonimi noti, in ordine di priorita': il primo che combacia vince.
const FIELD_SYNONYMS = {
  name: ['nome', 'giocatore', 'calciatore', 'player', 'nome giocatore', 'cognome'],
  team: ['squadra', 'team', 'club', 'squadra serie a', 'sq'],
  role: ['ruolo', 'r', 'ruolo classic', 'role', 'pos', 'posizione'],
  roleMantra: ['ruolo mantra', 'rm', 'mantra', 'ruoli mantra'],
  tier: ['fascia', 'fasce', 'tier', 'fascia creator', 'fascia creators', 'categoria', 'livello'],
  // Prezzo consigliato dal creator: e' la stima d'asta migliore quando c'e'.
  price: ['prezzo', 'prezzo consigliato', 'quotazione', 'qt a', 'qt', 'qta', 'quot', 'crediti', 'quotazione iniziale', 'qi'],
  // Percentuale massima del budget da investire sul giocatore.
  pma: ['pma', 'percentuale max asta', 'perc max asta', 'max asta'],
  // Quotazione ufficiale del listone.
  quo: ['quo', 'quotazione ufficiale', 'qt i'],
  // Fantamedia attesa per la stagione che inizia: il predittore piu' forte.
  fmvExp: ['fmv exp', 'fmv exp.', 'fmv atteso', 'fm exp', 'fantamedia attesa', 'fantamedia prevista'],
  fvm: ['fvm m', 'fantavalore', 'valore di mercato'],
  fantamedia: ['fmv', 'fantamedia', 'fm', 'fanta media'],
  mediavoto: ['mv', 'media voto', 'mediavoto', 'voto medio'],
  // Giudizi 0-5 del creator.
  titolarita: ['titolarita', 'titolarieta', 'tit'],
  affidabilita: ['affidabilita', 'affidabilita rendimento'],
  integrita: ['integrita', 'integrita fisica'],
  matches: ['presenze', 'pg', 'partite', 'presenze campionato'],
  starts: ['pt tit', 'partite da titolare', 'titolarita partite'],
  minutes: ['minuti', 'min giocati'],
  injuries: ['pt inf', 'partite saltate', 'infortuni'],
  goals: ['gol', 'goal', 'reti', 'gf'],
  assists: ['assist', 'ass', 'assists'],
  goalsAgainst: ['gol subiti', 'reti subite'],
  penaltiesSaved: ['rig parati', 'rigori parati'],
  penalties: ['rig segnati', 'rigorista', 'rigori', 'calcia rigori'],
  notes: ['commento', 'note', 'nota', 'descrizione', 'consiglio'],
};

// Colonne di etichette: "Nota 1", "Nota 2", ... Vengono raccolte tutte insieme.
const TAG_HEADER = /^nota ?\d*$|^tag ?\d*$|^etichett[ae] ?\d*$/;

// Campi calcolati dopo l'import, normalizzati all'interno di ogni fonte.
const DERIVED_FIELDS = ['tierPct', 'pmaShare'];

const NUMERIC_FIELDS = [
  'price', 'pma', 'quo', 'fmvExp', 'fvm', 'fantamedia', 'mediavoto',
  'titolarita', 'affidabilita', 'integrita', 'matches', 'starts', 'minutes',
  'injuries', 'goals', 'assists', 'goalsAgainst', 'penaltiesSaved',
];

/** Deduce automaticamente quale colonna del CSV corrisponde a quale campo. */
export function autoMap(headers) {
  const norm = headers.map((h) => ({ header: h, n: normalizeHeader(h) }));
  const mapping = {};
  const used = new Set();
  for (const [field, synonyms] of Object.entries(FIELD_SYNONYMS)) {
    let found = null;
    for (const syn of synonyms) {
      found = norm.find((h) => !used.has(h.header) && h.n === syn);
      if (found) break;
    }
    if (!found) {
      for (const syn of synonyms) {
        found = norm.find((h) => !used.has(h.header) && (h.n.startsWith(syn + ' ') || h.n.endsWith(' ' + syn)));
        if (found) break;
      }
    }
    if (found) {
      mapping[field] = found.header;
      used.add(found.header);
    }
  }
  mapping.tags = norm.filter((h) => TAG_HEADER.test(h.n)).map((h) => h.header);
  for (const h of mapping.tags) used.add(h);
  return mapping;
}

/**
 * Corregge la mappatura guardando i valori, non solo le intestazioni.
 * "FVM" vuol dire fantamedia nei listoni dei creators e fantavalore di mercato in quelli
 * ufficiali: sono la stessa parola per due cose diverse, e solo la scala dei numeri lo dice.
 */
export function refineMapping(rows, mapping) {
  const out = { ...mapping };
  const median = (header) => {
    const vals = rows
      .map((r) => parseNumber(r[header]))
      .filter((v) => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);
    return vals.length ? vals[Math.floor(vals.length / 2)] : null;
  };
  for (const [from, to] of [['fantamedia', 'fvm'], ['fvm', 'fantamedia']]) {
    const header = out[from];
    if (!header || out[to]) continue;
    const m = median(header);
    if (m === null) continue;
    // Una fantamedia sta sotto 12; un valore di mercato e' molto piu' grande.
    const isAverage = m < 12;
    if ((from === 'fantamedia') !== isAverage) {
      delete out[from];
      out[to] = header;
    }
  }
  return out;
}

export const ROLES = ['P', 'D', 'C', 'A'];

const MANTRA_TO_CLASSIC = {
  por: 'P',
  dc: 'D',
  dd: 'D',
  ds: 'D',
  e: 'D',
  m: 'C',
  c: 'C',
  w: 'C',
  t: 'C',
  a: 'A',
  pc: 'A',
};

/** Normalizza un ruolo scritto in qualunque modo (classic o mantra) al ruolo classic P/D/C/A. */
export function normalizeRole(raw) {
  if (!raw) return null;
  const tokens = String(raw)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const s = tokens.join('');
  if (!s) return null;
  if (/^(p|por|portiere|gk|goalkeeper)$/.test(s)) return 'P';
  if (/^(d|dif|difensore|def)$/.test(s)) return 'D';
  if (/^(c|cen|centrocampista|mid|m)$/.test(s)) return 'C';
  if (/^(a|att|attaccante|fw|pc)$/.test(s)) return 'A';
  // Mantra multi-ruolo tipo "Dd;Dc" oppure "W/T": vale il primo riconosciuto.
  for (const t of tokens) {
    if (MANTRA_TO_CLASSIC[t]) return MANTRA_TO_CLASSIC[t];
  }
  return null;
}

export function parseNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/[^\d,.\-]/g, '');
  if (!s) return null;
  // "1.234,5" -> 1234.5 ; "12,5" -> 12.5 ; "12.5" -> 12.5
  let t = s;
  if (t.includes(',') && t.includes('.')) t = t.replace(/\./g, '').replace(',', '.');
  else if (t.includes(',')) t = t.replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

let uid = 0;
export function makePlayerId(name, team, role) {
  const base = `${normalizeHeader(name)}|${normalizeHeader(team)}|${role || ''}`;
  return base.replace(/\s+/g, '_') || `p${++uid}`;
}

/**
 * Converte le righe grezze in giocatori tipizzati.
 * Ritorna { players, warnings, tierLabels }: le righe senza nome o ruolo vengono
 * scartate con un avviso, cosi' l'utente vede sempre cosa e' rimasto fuori.
 */
export function buildPlayers(rows, mapping, opts = {}) {
  const source = opts.source || '';
  const players = [];
  const warnings = [];
  const tierLabels = new Set();
  const seen = new Map();

  const num = (row, field) => (mapping[field] ? parseNumber(row[mapping[field]]) : null);

  rows.forEach((row, idx) => {
    const name = mapping.name ? (row[mapping.name] || '').trim() : '';
    if (!name) return; // riga vuota di coda: non vale un avviso
    const rawRole = mapping.role ? row[mapping.role] : '';
    const rawMantra = mapping.roleMantra ? row[mapping.roleMantra] : '';
    // Nei listoni a fogli separati il nome del foglio e' gia' il ruolo.
    const role = normalizeRole(rawRole) || normalizeRole(rawMantra) || normalizeRole(row.__foglio);
    if (!role) {
      warnings.push(`Riga ${idx + 2}: ruolo non riconosciuto per "${name}", scartata.`);
      return;
    }
    const team = mapping.team ? (row[mapping.team] || '').trim() : '';
    const tier = mapping.tier ? (row[mapping.tier] || '').trim() : '';
    if (tier) tierLabels.add(tier);

    const tags = [];
    for (const header of mapping.tags || []) {
      const v = (row[header] || '').trim();
      if (v) tags.push(v.toLowerCase());
    }

    const id = makePlayerId(name, team, role);
    if (seen.has(id)) {
      warnings.push(`Riga ${idx + 2}: "${name}" (${team}) duplicato, tenuta la prima occorrenza.`);
      return;
    }

    const player = {
      id,
      name,
      team,
      role,
      roleMantra: (rawMantra || '').trim(),
      tier,
      tags,
      notes: mapping.notes ? (row[mapping.notes] || '').trim() : '',
      sources: source ? [source] : [],
    };
    for (const field of NUMERIC_FIELDS) player[field] = num(row, field);

    seen.set(id, player);
    players.push(player);
  });

  return { players, warnings, tierLabels: [...tierLabels] };
}

/**
 * Unisce i listoni di piu' creators in uno solo.
 * Stesso giocatore = stesso nome e squadra. I valori numerici diventano la media
 * delle fonti, le etichette si sommano: il consenso vale piu' di una firma sola.
 */
export function mergeSources(lists) {
  const valid = lists.filter((l) => l && l.length);
  if (valid.length <= 1) return valid[0] || [];

  const merged = new Map();
  for (const list of valid) {
    for (const p of list) {
      const key = p.id;
      if (!merged.has(key)) {
        merged.set(key, { ...p, tiersBySource: {}, bySource: {}, _acc: {}, _n: {} });
      }
      const target = merged.get(key);
      for (const src of p.sources) if (!target.sources.includes(src)) target.sources.push(src);
      const src = p.sources[0] || `fonte ${valid.indexOf(list) + 1}`;
      if (p.tier) target.tiersBySource[src] = p.tier;
      target.bySource = target.bySource || {};
      target.bySource[src] = { tier: p.tier, price: p.price, pma: p.pma, fmvExp: p.fmvExp, tierPct: p.tierPct };
      // Campi gia' normalizzati per fonte: si mediano come gli altri ma non stanno
      // fra i valori grezzi importati dal file.
      for (const field of DERIVED_FIELDS) {
        if (!Number.isFinite(p[field])) continue;
        target._acc[field] = (target._acc[field] || 0) + p[field];
        target._n[field] = (target._n[field] || 0) + 1;
      }
      for (const tag of p.tags) if (!target.tags.includes(tag)) target.tags.push(tag);
      if (p.notes && !target.notes.includes(p.notes)) target.notes = target.notes ? `${target.notes}\n\n${p.notes}` : p.notes;
      for (const field of NUMERIC_FIELDS) {
        const v = p[field];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        target._acc[field] = (target._acc[field] || 0) + v;
        target._n[field] = (target._n[field] || 0) + 1;
      }
    }
  }

  return [...merged.values()].map((p) => {
    const out = { ...p };
    for (const field of NUMERIC_FIELDS) {
      out[field] = p._n[field] ? p._acc[field] / p._n[field] : null;
    }
    for (const field of DERIVED_FIELDS) out[field] = p._n[field] ? p._acc[field] / p._n[field] : null;
    delete out._acc;
    delete out._n;
    // La fascia mostrata e' quella della prima fonte che ne ha una.
    out.tier = Object.values(p.tiersBySource)[0] || p.tier || '';

    // Quanto le fonti sono d'accordo sul prezzo. Un disaccordo forte e' un'occasione:
    // il mercato seguira' una via di mezzo, e chi lo valuta di piu' ha visto qualcosa.
    const prices = Object.values(out.bySource || {})
      .map((v) => v.price)
      .filter((v) => Number.isFinite(v));
    if (prices.length > 1) {
      out.priceMin = Math.min(...prices);
      out.priceMax = Math.max(...prices);
      const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
      out.priceSpread = mean > 0 ? (out.priceMax - out.priceMin) / mean : 0;
    } else {
      out.priceMin = out.price;
      out.priceMax = out.price;
      out.priceSpread = 0;
    }
    return out;
  });
}
