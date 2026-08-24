// Import dei listoni (xlsx dei creators o CSV) e consultazione dei giocatori.

import { state, addSource, removeSource } from '../store.js';
import { parseCsv, sheetsToTable, autoMap, refineMapping, buildPlayers } from '../domain/csv.js';
import { readXlsx } from '../domain/xlsx.js';
import { ROLES } from '../domain/model.js';
import { esc, matches, playerRow, emptyState, toast } from './common.js';

// Import in corso: vive solo finche' l'utente conferma la mappatura delle colonne.
let draft = null;
let showMapping = false;

const FIELDS = [
  ['name', 'Nome', true],
  ['team', 'Squadra', false],
  ['role', 'Ruolo', true],
  ['tier', 'Fascia', false],
  ['price', 'Prezzo consigliato', false],
  ['fmvExp', 'Fantamedia attesa', false],
  ['titolarita', 'Titolarita', false],
  ['integrita', 'Integrita', false],
  ['notes', 'Commento', false],
];

function sourceName(fileName) {
  return String(fileName || 'listone')
    .replace(/\.(xlsx|xlsm|csv|tsv|txt)$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .slice(0, 40);
}

/** Prende un file (o un testo incollato) e prepara l'anteprima dell'import. */
export async function ingestFile(file) {
  const name = file.name || 'listone';
  try {
    let table;
    if (/\.(xlsx|xlsm)$/i.test(name)) {
      const sheets = await readXlsx(await file.arrayBuffer());
      table = sheetsToTable(sheets);
      table.origine = `${sheets.length} fogli`;
    } else {
      const parsed = parseCsv(await file.text());
      table = { ...parsed, origine: `separatore ${parsed.delimiter === '\t' ? 'tab' : parsed.delimiter}` };
    }
    if (!table.headers?.length) {
      toast('Non riesco a leggere questo file.');
      return;
    }
    const mapping = refineMapping(table.rows, autoMap(table.headers));
    draft = { ...table, mapping, fileName: name, source: sourceName(name) };
    showMapping = !mapping.name || !mapping.role;
  } catch (err) {
    console.error(err);
    toast(err.message || 'Import non riuscito.');
  }
}

export function ingestText(text) {
  const parsed = parseCsv(text);
  if (!parsed.headers.length) {
    toast('Non riesco a leggere il testo incollato.');
    return;
  }
  const mapping = refineMapping(parsed.rows, autoMap(parsed.headers));
  draft = { ...parsed, mapping, fileName: 'testo incollato', source: 'incollato', origine: `separatore ${parsed.delimiter}` };
  showMapping = !mapping.name || !mapping.role;
}

function preview() {
  const { players, warnings } = buildPlayers(draft.rows, draft.mapping, { source: draft.source });
  const counts = {};
  for (const r of ROLES) counts[r] = players.filter((p) => p.role === r).length;
  const withTier = players.filter((p) => p.tier).length;
  const withProjection = players.filter((p) => Number.isFinite(p.fmvExp)).length;
  return { players, warnings, counts, withTier, withProjection };
}

function emptyImport() {
  return `
  <div class="card">
    <h2>Carica il listone</h2>
    <p class="small muted" style="margin-top:0">
      Il file <b>.xlsx</b> del creator va bene cosi' com'e', con i suoi quattro fogli per ruolo.
      Puoi caricarne <b>piu' di uno</b>: l'app fa la media dei giudizi e ti segnala dove i creators non sono d'accordo.
    </p>
    <input type="file" id="csvfile" accept=".xlsx,.xlsm,.csv,.tsv,.txt" multiple style="display:none" data-action="file">
    <button class="btn primary block" data-action="pickfile">Scegli il file</button>
    <div class="row" style="margin:12px 0 6px"><div class="grow" style="height:1px;background:var(--line)"></div><span class="tiny muted">oppure incolla un CSV</span><div class="grow" style="height:1px;background:var(--line)"></div></div>
    <textarea id="pastearea" rows="3" placeholder="Incolla qui il contenuto" style="width:100%;background:var(--surface-2);border:1px solid var(--line);border-radius:11px;padding:11px"></textarea>
    <button class="btn block" style="margin-top:8px" data-action="paste">Importa dal testo</button>
  </div>`;
}

function draftCard() {
  const { players, warnings, counts, withTier, withProjection } = preview();
  const options = (sel) =>
    ['<option value="">— nessuna —</option>']
      .concat(draft.headers.map((h) => `<option value="${esc(h)}" ${h === sel ? 'selected' : ''}>${esc(h)}</option>`))
      .join('');

  return `
  <div class="card">
    <div class="row between"><h2 style="margin:0">Anteprima</h2><button class="btn ghost" data-action="cancel-import">Annulla</button></div>
    <div class="small muted" style="margin:8px 0 12px">${esc(draft.fileName)} · ${esc(draft.origine || '')} · ${draft.rows.length} righe</div>

    <div class="card" style="background:var(--surface-2);box-shadow:none;margin-bottom:12px">
      <div class="row between"><b>${players.length} giocatori</b><span class="small muted">${ROLES.map((r) => `${r} ${counts[r]}`).join(' · ')}</span></div>
      <div class="tiny muted" style="margin-top:6px">
        ${withTier} con fascia · ${withProjection} con fantamedia attesa
      </div>
      ${
        warnings.length
          ? `<details style="margin-top:8px"><summary class="small muted">${warnings.length} righe scartate</summary>
             <div class="tiny muted" style="margin-top:6px;max-height:120px;overflow:auto">${warnings.slice(0, 30).map((w) => esc(w)).join('<br>')}</div></details>`
          : ''
      }
    </div>

    <label class="field"><span>Nome del creator</span>
      <input type="text" id="srcname" value="${esc(draft.source)}" data-action="srcname"></label>

    <button class="btn ghost block" data-action="togglemap">${showMapping ? 'Nascondi' : 'Correggi'} le colonne riconosciute</button>
    <div class="${showMapping ? '' : 'hidden'}" style="margin-top:12px">
      ${FIELDS.map(
        ([field, label, req]) => `
        <label class="field">
          <span>${esc(label)}${req ? ' *' : ''}</span>
          <select data-action="map" data-field="${field}">${options(draft.mapping[field])}</select>
        </label>`
      ).join('')}
    </div>

    <button class="btn primary block" style="margin-top:12px" data-action="confirm-import" ${players.length ? '' : 'disabled'}>
      Aggiungi ${players.length} giocatori
    </button>
  </div>`;
}

function sourcesCard() {
  if (!state.sources.length) return '';
  return `
  <div class="card">
    <h2>Creators caricati</h2>
    <div class="listwrap">
      <ul class="plist">
        ${state.sources
          .map(
            (s) => `<li>
              <div class="grow"><div class="nm">${esc(s.name)}</div><div class="sub">${s.players.length} giocatori</div></div>
              <button class="btn ghost" data-action="removesource" data-name="${esc(s.name)}">Rimuovi</button>
            </li>`
          )
          .join('')}
      </ul>
    </div>
    ${
      state.sources.length > 1
        ? `<div class="tiny muted" style="margin-top:8px">Valori mediati fra le fonti. Dove i creators non sono d'accordo lo vedi sulla scheda del giocatore.</div>`
        : `<div class="tiny muted" style="margin-top:8px">Puoi aggiungere un secondo creator: il confronto rende le stime piu' solide.</div>`
    }
    <button class="btn block" style="margin-top:10px" data-action="pickfile">Aggiungi un altro listone</button>
    <input type="file" id="csvfile" accept=".xlsx,.xlsm,.csv,.tsv,.txt" multiple style="display:none" data-action="file">
  </div>`;
}

function browseCard() {
  const q = state.ui.listQuery;
  const role = state.ui.listRole;
  const list = state.players
    .filter((p) => (role === 'ALL' || p.role === role) && matches(p, q))
    .filter((p) => !state.ui.onlyAvailable || state.auction.taken[p.id] === undefined)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 80);

  return `
  <div class="card">
    <h2>Listone · ${state.players.length}</h2>
    <input type="search" id="listQuery" placeholder="Cerca…" value="${esc(q)}" data-action="listquery" autocomplete="off">
    <div class="segment" style="margin-top:10px">
      ${['ALL', ...ROLES]
        .map((r) => `<button data-action="listrole" data-role="${r}" aria-pressed="${role === r}">${r === 'ALL' ? 'Tutti' : r}</button>`)
        .join('')}
    </div>
    <div class="switch" style="margin-top:6px">
      <span class="lbl small">Nascondi chi e' gia' stato preso</span>
      <input type="checkbox" data-action="onlyavail" ${state.ui.onlyAvailable ? 'checked' : ''}>
    </div>
    <div class="listwrap" style="margin-top:6px">
      <ul class="plist">
        ${
          list.length
            ? list
                .map((p) =>
                  playerRow(p, {
                    status: state.auction.owned[p.id] !== undefined ? 'mine' : state.auction.taken[p.id] !== undefined ? 'other' : null,
                    inPlan: state.plan?.picks?.some((x) => x.id === p.id),
                  })
                )
                .join('')
            : '<li class="muted small">Nessun risultato.</li>'
        }
      </ul>
    </div>
  </div>`;
}

export function render() {
  if (draft) return `<div class="view">${draftCard()}</div>`;
  if (!state.players.length) {
    return `<div class="view">${emptyImport()}${emptyState('⚽️', 'Si parte dal listone', 'Senza listone non c\'e\' piano: carica il file del tuo creator.')}</div>`;
  }
  return `<div class="view">${sourcesCard()}${browseCard()}</div>`;
}

export function onAction(action, target, ev, rerender) {
  switch (action) {
    case 'pickfile':
      document.getElementById('csvfile')?.click();
      return true;
    case 'paste': {
      const text = document.getElementById('pastearea')?.value || '';
      if (!text.trim()) {
        toast('Incolla prima il contenuto.');
        return true;
      }
      ingestText(text);
      rerender();
      return true;
    }
    case 'togglemap':
      showMapping = !showMapping;
      rerender();
      return true;
    case 'cancel-import':
      draft = null;
      rerender();
      return true;
    case 'removesource':
      removeSource(target.dataset.name);
      rerender();
      return true;
    case 'confirm-import': {
      const { players, warnings } = preview();
      addSource({
        name: draft.source || 'listone',
        players,
        headers: draft.headers,
        mapping: draft.mapping,
        warnings,
        fileName: draft.fileName,
      });
      const n = players.length;
      draft = null;
      showMapping = false;
      toast(`${n} giocatori aggiunti.`);
      rerender();
      return true;
    }
    case 'listrole':
      state.ui.listRole = target.dataset.role;
      rerender();
      return true;
    case 'select':
      state.ui.selectedId = target.dataset.id;
      state.ui.tab = 'asta';
      rerender();
      return true;
    default:
      return false;
  }
}

export function onInput(action, target, rerender) {
  if (action === 'map') {
    draft.mapping = { ...draft.mapping, [target.dataset.field]: target.value || undefined };
    rerender();
    return true;
  }
  if (action === 'srcname') {
    draft.source = target.value;
    return true;
  }
  if (action === 'listquery') {
    state.ui.listQuery = target.value;
    rerender({ keepFocus: 'listQuery' });
    return true;
  }
  if (action === 'onlyavail') {
    state.ui.onlyAvailable = target.checked;
    rerender();
    return true;
  }
  if (action === 'file') {
    const files = [...(target.files || [])];
    if (!files.length) return true;
    (async () => {
      for (const file of files) {
        await ingestFile(file);
        // Con piu' file in coda importiamo subito quelli riconosciuti senza chiedere nulla.
        if (draft && files.length > 1 && draft.mapping.name && draft.mapping.role) {
          const { players, warnings } = preview();
          addSource({ name: draft.source, players, headers: draft.headers, mapping: draft.mapping, warnings, fileName: draft.fileName });
          draft = null;
        }
      }
      rerender();
    })();
    return true;
  }
  return false;
}
