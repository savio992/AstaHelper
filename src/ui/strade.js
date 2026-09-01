// Le strade: quattro rose diverse fra cui scegliere, e come stanno mentre l'asta va avanti.
//
// Il piano dice cosa comprare adesso. Non dice qual e' l'idea, e quindi quando salta un
// giocatore non si capisce se e' saltato un nome o se e' saltata la strada. Qui l'idea si
// vede: si generano alcune rose davvero diverse, si mettono da parte quelle che convincono,
// e a ogni assegnazione si guarda quali reggono ancora.

import {
  state,
  ownedMap,
  unavailableSet,
  obbligatiSet,
  onReset,
  salvaScenario,
  rinominaScenario,
  eliminaScenario,
  adottaScenario,
  abbandonaStrada,
} from '../store.js';
import { generaScenari, valutaScenario, descriviScenario, nucleoScenario } from '../domain/scenari.js';
import { esc, roleChip, toast } from './common.js';

let generate = null;
let generando = false;
// Le valutazioni costano un'ottimizzazione a testa: si rifanno quando cambia il piano, non
// a ogni disegno della scheda.
let valutazioni = { rev: null, voci: [] };
// La chiave e' la revisione del piano piu' l'elenco delle strade: salvarne una nuova non
// rifa' il piano, quindi la sola revisione lascerebbe la strada appena salvata senza voto.
const chiaveValutazioni = () => `${state.revisione}|${state.scenari.map((s) => s.id).join(',')}`;
let valutando = false;
let apertaId = null;

onReset(() => invalidate());

export function invalidate() {
  generate = null;
  generando = false;
  valutazioni = { rev: null, voci: [] };
  apertaId = null;
}

function contesto() {
  return {
    players: state.players,
    settings: state.settings,
    owned: ownedMap(),
    unavailable: unavailableSet(),
    obbligati: obbligatiSet(),
  };
}

function costruisci(rerender) {
  generando = true;
  setTimeout(() => {
    try {
      generate = generaScenari({ ...contesto(), base: state.plan, quante: 4 });
    } catch (err) {
      console.error(err);
      generate = null;
    } finally {
      generando = false;
      rerender();
    }
  }, 30);
}

function valuta(rerender) {
  const rev = chiaveValutazioni();
  valutando = true;
  setTimeout(() => {
    try {
      const ctx = contesto();
      // Il termine di paragone e' lo stesso per tutte: altrimenti le stelle di due strade non
      // sarebbero confrontabili, che e' l'unica cosa per cui servono.
      const riferimento = state.plan;
      valutazioni = {
        rev,
        voci: state.scenari.map((s) => ({ scenario: s, esito: valutaScenario({ scenario: s, ...ctx, riferimento }) })),
      };
    } catch (err) {
      console.error(err);
      valutazioni = { rev, voci: [] };
    } finally {
      valutando = false;
      rerender();
    }
  }, 30);
}

/** Le stelle disegnate, con la mezza. */
function stelline(v) {
  if (!(v > 0)) return '<span class="muted">—</span>';
  const piene = Math.floor(v);
  const mezza = v - piene >= 0.5;
  return `<span class="stelle" title="${v} su 5">${'★'.repeat(piene)}${mezza ? '½' : ''}${'☆'.repeat(5 - piene - (mezza ? 1 : 0))}</span>`;
}

const CLASSE_STATO = { viva: 'plan', completata: 'mine', ferita: 'warn', morta: 'gone' };
const ETICHETTA_STATO = { viva: 'Intatta', completata: 'Completata', ferita: 'Colpita', morta: 'Chiusa' };

function testa(piano, quanti = 4) {
  return piano.picks
    .slice()
    .sort((a, b) => b.plannedPrice - a.plannedPrice)
    .slice(0, quanti)
    .map((p) => `${roleChip(p.role)} ${esc(p.name)} <b class="mono">${p.plannedPrice}</b>`)
    .join(' · ');
}

function generateCard() {
  if (generando) {
    return `<div class="card"><h2>Genera le strade</h2>
      <div class="small muted"><span class="spinner"></span> Cerco rose diverse fra loro…</div></div>`;
  }
  if (!generate) {
    return `<div class="card">
      <h2>Genera le strade</h2>
      <div class="small muted" style="margin-bottom:10px">
        Quattro rose complete e davvero diverse, ottenute togliendo a turno uno dei giocatori piu' cari
        del piano. Servono a scegliere un'idea prima di sedersi all'asta, non a indovinare la rosa.
      </div>
      <button class="btn primary block" data-action="genera-strade">Genera 4 squadre</button>
    </div>`;
  }
  if (!generate.scenari.length) {
    return `<div class="card"><h2>Genera le strade</h2>
      <div class="small">Non riesco a costruire nemmeno una rosa: ${esc(generate.base?.reason || 'il budget non basta.')}</div></div>`;
  }

  const salvati = new Set(state.scenari.map((s) => s.ids.join('|')));
  return `
  <div class="card">
    <div class="row between" style="align-items:center;margin-bottom:8px">
      <h2 style="margin:0">Le strade</h2>
      <button class="btn ghost" style="padding:2px 10px" data-action="genera-strade">Rigenera</button>
    </div>
    ${
      generate.migliorabile
        ? `<div class="verdict edge" style="text-align:left;margin-bottom:10px">
             <div class="small" style="font-weight:600">Cercando le strade ne ho trovata una migliore del piano attuale.</div>
             <div class="small" style="font-weight:500;margin-top:4px">
               Il piano si ferma a una ripartenza sola per restare veloce; qui ne provo sei e ogni tanto salta fuori
               una rosa che vale di piu'. Se ti convince, seguila: il piano si rifa' intorno a lei.
             </div>
           </div>`
        : ''
    }
    <ul class="strade">
      ${generate.scenari
        .map(
          (s, i) => `
        <li>
          <div class="row between" style="align-items:baseline">
            <div><b>${esc(s.nome)}</b> ${s.attuale ? '<span class="chip plan">piano attuale</span>' : ''}</div>
            <div>${stelline(s.stelle)}</div>
          </div>
          <div class="tiny" style="margin:4px 0 6px;line-height:1.7">${testa(s.piano)}</div>
          <div class="row" style="gap:8px;align-items:center">
            <span class="tiny muted grow">${s.costo} crediti · ${s.piano.picks.length} da prendere</span>
            ${
              salvati.has(s.ids.join('|'))
                ? '<span class="tiny muted">gia\' salvata</span>'
                : `<button class="btn ghost" style="padding:2px 10px" data-action="salva-strada" data-i="${i}">Salva</button>`
            }
          </div>
        </li>`
        )
        .join('')}
    </ul>
  </div>`;
}

function salvateCard() {
  if (!state.scenari.length) return '';
  const fresche = valutazioni.rev === chiaveValutazioni();
  const perId = new Map(valutazioni.voci.map((v) => [v.scenario.id, v.esito]));
  const seguendo = Object.keys(state.auction.bloccati || {}).length;

  return `
  <div class="card ${fresche ? '' : 'stantio'}">
    <div class="row between" style="align-items:center;margin-bottom:4px">
      <h2 style="margin:0">Le mie strade</h2>
      ${valutando ? '<span class="tiny muted"><span class="spinner"></span> aggiorno</span>' : ''}
    </div>
    <div class="small muted" style="margin-bottom:10px">
      Le stelle non dicono quanto e' forte la rosa in assoluto: dicono quanto vale rispetto alla migliore
      ancora ottenibile adesso. Scendono da sole mentre i giocatori se ne vanno.
    </div>
    <ul class="strade">
      ${state.scenari
        .map((s) => {
          const e = perId.get(s.id);
          const aperta = apertaId === s.id;
          return `
        <li>
          <div class="row between" style="align-items:center;gap:8px">
            <input class="nome-strada grow" data-action="rinomina-strada" data-id="${esc(s.id)}"
                   value="${esc(s.nome)}" maxlength="40" aria-label="Nome della strada">
            ${e ? stelline(e.stelle) : '<span class="muted tiny">…</span>'}
          </div>
          ${
            e
              ? `<div class="row" style="gap:6px;align-items:center;margin:6px 0 4px">
                   <span class="chip ${CLASSE_STATO[e.stato] || ''}">${ETICHETTA_STATO[e.stato] || e.stato}</span>
                   <span class="tiny muted">${e.presi.length}/${s.ids.length} presi${
                     e.costo !== null ? ` · ancora ${e.daSpendere} crediti` : ''
                   }</span>
                 </div>
                 <div class="tiny" style="line-height:1.65">${esc(descriviScenario(e))}</div>
                 ${e.mancanti.length ? `<div class="tiny muted" style="margin-top:4px">${e.mancanti.length} giocatori non sono piu' nel listone.</div>` : ''}`
              : '<div class="tiny muted" style="margin:6px 0">Calcolo…</div>'
          }
          <div class="row" style="gap:8px;margin-top:8px">
            <button class="btn ghost grow" style="padding:2px 10px" data-action="apri-strada" data-id="${esc(s.id)}">${aperta ? 'Nascondi' : 'Vedi la rosa'}</button>
            <button class="btn ghost" style="padding:2px 10px" data-action="segui-strada" data-id="${esc(s.id)}"
              ${e && e.stato === 'morta' ? 'disabled' : ''}>Segui</button>
            <button class="btn ghost" style="padding:2px 10px" data-action="elimina-strada" data-id="${esc(s.id)}" aria-label="Elimina">✕</button>
          </div>
          ${aperta && e?.piano?.ok ? dettaglio(s, e) : ''}
        </li>`;
        })
        .join('')}
    </ul>
    ${
      seguendo
        ? `<button class="btn ghost block" style="margin-top:10px" data-action="abbandona-strada">
             Abbandona la strada (${seguendo} lucchetti)
           </button>`
        : ''
    }
  </div>`;
}

function dettaglio(scenario, esito) {
  const per = (lista, etichetta, classe) =>
    lista.length
      ? `<div class="tiny" style="margin-top:6px"><span class="${classe}">${etichetta}</span> ${lista
          .map((p) => `${esc(p.name)} <span class="muted mono">${p.previsto ?? Math.round(p.plannedPrice ?? p.expectedPrice ?? 0)}</span>`)
          .join(' · ')}</div>`
      : '';
  return `
  <div class="dettaglio-strada">
    ${per(esito.presi, 'Presi:', 'pos')}
    ${per(esito.liberi, 'Ancora liberi:', '')}
    ${per(esito.persi, 'Persi:', 'neg')}
    ${per(esito.entrati, 'Al loro posto:', '')}
  </div>`;
}

export function render() {
  if (!state.players.length) return '';
  // Le valutazioni si rifanno da sole quando il piano cambia: e' l'unico modo perche' le
  // stelle di una strada salvata scendano mentre l'asta va avanti, che e' tutto il punto.
  return `${generateCard()}${salvateCard()}`;
}

/** Va chiamata dopo aver disegnato, per far ripartire i calcoli in ritardo. */
export function dopoIlDisegno(rerender) {
  if (state.scenari.length && valutazioni.rev !== chiaveValutazioni() && !valutando) valuta(rerender);
}

export function onAction(action, target, ev, rerender) {
  if (action === 'genera-strade') {
    generate = null;
    costruisci(rerender);
    rerender();
    return true;
  }
  if (action === 'salva-strada') {
    const s = generate?.scenari?.[Number(target.dataset.i)];
    if (!s) return true;
    salvaScenario({ nome: s.nome, ids: s.ids, prezzi: s.prezzi, score: s.score });
    toast(`Strada salvata: ${s.nome}`);
    rerender();
    return true;
  }
  if (action === 'apri-strada') {
    apertaId = apertaId === target.dataset.id ? null : target.dataset.id;
    rerender();
    return true;
  }
  if (action === 'segui-strada') {
    const s = state.scenari.find((x) => x.id === target.dataset.id);
    if (!s) return true;
    const ok = adottaScenario(s.id, nucleoScenario(s));
    toast(ok ? `Seguo ${s.nome}: il piano si rifa' intorno a lei.` : 'Con questi lucchetti la rosa non si chiude piu\'.');
    rerender();
    return true;
  }
  if (action === 'elimina-strada') {
    eliminaScenario(target.dataset.id);
    if (apertaId === target.dataset.id) apertaId = null;
    rerender();
    return true;
  }
  if (action === 'abbandona-strada') {
    abbandonaStrada();
    toast('Lucchetti tolti: decide di nuovo il solutore.');
    rerender();
    return true;
  }
  return false;
}

export function onInput(action, target, rerender) {
  if (action === 'rinomina-strada') {
    rinominaScenario(target.dataset.id, target.value);
    return true;
  }
  return false;
}
