// Import del listone e consultazione dei giocatori.

import { state, setImported, save, notify } from '../store.js';
import { parseCsv, autoMap, buildPlayers } from '../domain/csv.js';
import { ROLES } from '../domain/model.js';
import { esc, matches, playerRow, emptyState, toast } from './common.js';

// Stato temporaneo dell'import, vivo solo finche' l'utente conferma la mappatura.
let draft = null;

const FIELDS = [
  ['name', 'Nome', true],
  ['team', 'Squadra', false],
  ['role', 'Ruolo', true],
  ['tier', 'Fascia', false],
  ['price', 'Quotazione', false],
  ['fvm', 'Valore di mercato', false],
  ['roleMantra', 'Ruolo Mantra (se il ruolo classic manca)', false],
  ['notes', 'Note', false],
];

export function ingest(text, fileName) {
  const parsed = parseCsv(text);
  if (!parsed.headers.length) {
    toast('Non riesco a leggere questo file.');
    return;
  }
  draft = { ...parsed, mapping: autoMap(parsed.headers), fileName };
  notify();
}

function preview() {
  const { rows, mapping } = draft;
  const { players, warnings } = buildPlayers(rows, mapping);
  const counts = {};
  for (const r of ROLES) counts[r] = players.filter((p) => p.role === r).length;
  return { players, warnings, counts };
}

function importCard() {
  if (!draft) {
    return `
    <div class="card">
      <h2>Carica il listone</h2>
      <p class="small muted" style="margin-top:0">
        Esporta da Fantalab il CSV con le fasce dei creators e caricalo qui. Serve almeno il <b>nome</b> e il <b>ruolo</b>;
        con <b>fascia</b> e <b>quotazione</b> il piano diventa molto piu' preciso.
      </p>
      <input type="file" id="csvfile" accept=".csv,.tsv,.txt,text/csv" style="display:none" data-action="file">
      <button class="btn primary block" data-action="pickfile">Scegli il file CSV</button>
      <div class="row" style="margin:12px 0 6px"><div class="grow" style="height:1px;background:var(--line)"></div><span class="tiny muted">oppure incolla</span><div class="grow" style="height:1px;background:var(--line)"></div></div>
      <textarea id="pastearea" rows="4" placeholder="Incolla qui il contenuto del CSV" style="width:100%;background:var(--surface-2);border:1px solid var(--line);border-radius:11px;padding:11px"></textarea>
      <button class="btn block" style="margin-top:8px" data-action="paste">Importa dal testo incollato</button>
    </div>`;
  }

  const { players, warnings, counts } = preview();
  const options = (sel) =>
    ['<option value="">— nessuna —</option>']
      .concat(draft.headers.map((h) => `<option value="${esc(h)}" ${h === sel ? 'selected' : ''}>${esc(h)}</option>`))
      .join('');

  return `
  <div class="card">
    <div class="row between"><h2 style="margin:0">Colonne riconosciute</h2><button class="btn ghost" data-action="cancel-import">Annulla</button></div>
    <div class="small muted" style="margin:8px 0 12px">
      ${esc(draft.fileName || 'testo incollato')} · separatore <code>${draft.delimiter === '\t' ? 'tab' : esc(draft.delimiter)}</code> · ${draft.rows.length} righe
    </div>
    ${FIELDS.map(
      ([field, label, req]) => `
      <label class="field">
        <span>${esc(label)}${req ? ' *' : ''}</span>
        <select data-action="map" data-field="${field}">${options(draft.mapping[field])}</select>
      </label>`
    ).join('')}

    <div class="card" style="background:var(--surface-2);box-shadow:none">
      <div class="row between"><b>${players.length} giocatori validi</b><span class="small muted">${ROLES.map((r) => `${r} ${counts[r]}`).join(' · ')}</span></div>
      ${
        warnings.length
          ? `<details style="margin-top:8px"><summary class="small muted">${warnings.length} righe scartate o corrette</summary>
             <div class="tiny muted" style="margin-top:6px;max-height:140px;overflow:auto">${warnings.slice(0, 40).map((w) => esc(w)).join('<br>')}</div></details>`
          : ''
      }
    </div>

    <button class="btn primary block" data-action="confirm-import" ${players.length ? '' : 'disabled'}>Importa ${players.length} giocatori</button>
  </div>`;
}

function browseCard() {
  if (!state.players.length) return '';
  const q = state.ui.listQuery;
  const role = state.ui.listRole;
  const list = state.players
    .filter((p) => (role === 'ALL' || p.role === role) && matches(p, q))
    .filter((p) => !state.ui.onlyAvailable || state.auction.taken[p.id] === undefined)
    .sort((a, b) => (b.expectedPrice ?? 0) - (a.expectedPrice ?? 0))
    .slice(0, 80);

  return `
  <div class="card">
    <div class="row between" style="margin-bottom:10px">
      <h2 style="margin:0">Listone · ${state.players.length}</h2>
      <button class="btn ghost small" data-action="reimport">Sostituisci</button>
    </div>
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
  if (!state.players.length && !draft) {
    return `<div class="view">${importCard()}${emptyState('⚽️', 'Si parte dal listone', 'Tutti i calcoli partono dalle fasce dei creators: senza listone non c\'e\' piano.')}</div>`;
  }
  return `<div class="view">${draft ? importCard() : browseCard()}</div>`;
}

export function onAction(action, target, ev, rerender) {
  switch (action) {
    case 'pickfile':
      document.getElementById('csvfile')?.click();
      return true;
    case 'paste': {
      const text = document.getElementById('pastearea')?.value || '';
      if (!text.trim()) {
        toast('Incolla prima il contenuto del CSV.');
        return true;
      }
      ingest(text, 'testo incollato');
      rerender();
      return true;
    }
    case 'cancel-import':
      draft = null;
      rerender();
      return true;
    case 'reimport':
      draft = null;
      state.ui.listQuery = '';
      rerender();
      return true;
    case 'confirm-import': {
      const { players, warnings } = preview();
      const tierLabels = [...new Set(players.map((p) => p.tier).filter(Boolean))];
      setImported({ roster: players, headers: draft.headers, mapping: draft.mapping, warnings, fileName: draft.fileName, tierLabels });
      draft = null;
      toast(`${players.length} giocatori importati.`);
      state.ui.tab = 'setup';
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
    const file = target.files?.[0];
    if (!file) return true;
    const reader = new FileReader();
    reader.onload = () => {
      ingest(String(reader.result || ''), file.name);
      rerender();
    };
    reader.onerror = () => toast('Non riesco a leggere il file.');
    reader.readAsText(file, 'utf-8');
    return true;
  }
  return false;
}
