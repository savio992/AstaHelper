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

  // Alcuni export mettono titolo/legenda prima dell'intestazione vera:
  // prendiamo come header la prima riga con almeno 3 celle non vuote e nessun numero puro.
  let headerIdx = 0;
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const cells = grid[i].map((c) => c.trim()).filter(Boolean);
    const looksNumeric = cells.filter((c) => /^-?\d+([.,]\d+)?$/.test(c)).length;
    if (cells.length >= 3 && looksNumeric <= cells.length / 3) {
      headerIdx = i;
      break;
    }
  }

  const headers = dedupeHeaders(grid[headerIdx].map((h, i) => h.trim() || `col_${i + 1}`));
  const rows = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const raw = grid[i];
    const obj = {};
    headers.forEach((h, j) => {
      obj[h] = (raw[j] ?? '').trim();
    });
    rows.push(obj);
  }
  return { headers, rows, delimiter: d };
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
  price: ['quotazione', 'qt', 'qt a', 'qta', 'quot', 'prezzo', 'crediti', 'quotazione iniziale', 'qi'],
  fvm: ['fvm', 'fantavalore', 'valore di mercato', 'fvm m', 'valore'],
  fantamedia: ['fantamedia', 'fm', 'fanta media', 'fmv'],
  mediavoto: ['media voto', 'mv', 'mediavoto', 'voto medio'],
  matches: ['presenze', 'pg', 'partite', 'presenze campionato'],
  goals: ['gol', 'goal', 'reti', 'gf'],
  assists: ['assist', 'ass', 'assists'],
  penalties: ['rigorista', 'rigori', 'rig', 'calcia rigori'],
  notes: ['note', 'nota', 'commento', 'descrizione', 'consiglio'],
};

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
  return mapping;
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
 * Ritorna { players, warnings, tierLabels } - i giocatori senza nome o ruolo vengono scartati con warning.
 */
export function buildPlayers(rows, mapping) {
  const players = [];
  const warnings = [];
  const tierLabels = new Set();
  const seen = new Set();

  rows.forEach((row, idx) => {
    const name = mapping.name ? (row[mapping.name] || '').trim() : '';
    if (!name) {
      warnings.push(`Riga ${idx + 2}: nome mancante, scartata.`);
      return;
    }
    const rawRole = mapping.role ? row[mapping.role] : '';
    const rawMantra = mapping.roleMantra ? row[mapping.roleMantra] : '';
    const role = normalizeRole(rawRole) || normalizeRole(rawMantra);
    if (!role) {
      warnings.push(`Riga ${idx + 2}: ruolo non riconosciuto per "${name}", scartata.`);
      return;
    }
    const team = mapping.team ? (row[mapping.team] || '').trim() : '';
    const tier = mapping.tier ? (row[mapping.tier] || '').trim() : '';
    if (tier) tierLabels.add(tier);

    const id = makePlayerId(name, team, role);
    if (seen.has(id)) {
      warnings.push(`Riga ${idx + 2}: "${name}" (${team}) duplicato, tenuta la prima occorrenza.`);
      return;
    }
    seen.add(id);

    players.push({
      id,
      name,
      team,
      role,
      roleMantra: (rawMantra || rawRole || '').trim(),
      tier,
      price: mapping.price ? parseNumber(row[mapping.price]) : null,
      fvm: mapping.fvm ? parseNumber(row[mapping.fvm]) : null,
      fantamedia: mapping.fantamedia ? parseNumber(row[mapping.fantamedia]) : null,
      mediavoto: mapping.mediavoto ? parseNumber(row[mapping.mediavoto]) : null,
      matches: mapping.matches ? parseNumber(row[mapping.matches]) : null,
      goals: mapping.goals ? parseNumber(row[mapping.goals]) : null,
      assists: mapping.assists ? parseNumber(row[mapping.assists]) : null,
      penalties: mapping.penalties ? (row[mapping.penalties] || '').trim() : '',
      notes: mapping.notes ? (row[mapping.notes] || '').trim() : '',
    });
  });

  return { players, warnings, tierLabels: [...tierLabels] };
}
