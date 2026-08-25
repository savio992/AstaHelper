// Il piano: la miglior rosa possibile con i crediti che restano, e come sono distribuiti.

import { state, rebuildPlan, blocca, scarta, liberaScelta, statoScelta, obbligatiSet } from '../store.js';
import { ROLES, ROLE_LABEL, totalSlots } from '../domain/model.js';
import { tierBudgetReport, maxBid, alternatives } from '../domain/advisor.js';
import { clubExposure } from '../domain/valuation.js';
import { ownedMap, unavailableSet, onReset } from '../store.js';
import { spiegaModifica } from '../domain/strategia.js';
import { esc, roleChip, emptyState, playerRow, edgeBadge, toast } from './common.js';

/**
 * L'effetto di una correzione fatta a mano.
 *
 * Il piano si rifa' per intero a ogni blocco o scarto, ma senza dirlo sembra che non sia
 * successo niente. E la differenza fra i due casi va vista: scartare il terzo portiere cambia
 * davvero solo il terzo portiere, scartare il primo puo' spostare settanta crediti in difesa.
 */
function modificaCard() {
  const mod = state.ultimaModifica;
  if (!mod || modificaChiusa === mod.at) return '';
  const p = state.players.find((x) => x.id === mod.id);
  if (!p) return '';

  if (mod.rifiutata) {
    return `
    <div class="card" style="border-left:3px solid var(--danger)">
      <div class="row between" style="align-items:flex-start;margin-bottom:6px">
        <b>Non posso: ${esc(p.name)} resta come prima.</b>
        <button class="btn ghost" style="padding:2px 8px" data-action="chiudi-modifica" aria-label="Chiudi">✕</button>
      </div>
      <div class="small">${esc(mod.motivo)}</div>
    </div>`;
  }

  const sp = spiegaModifica({
    prima: state.prevPlan,
    dopo: state.plan,
    players: state.players,
    settings: state.settings,
    id: mod.id,
    azione: mod.azione,
  });
  if (!sp) return '';

  return `
  <div class="card" style="border-left:3px solid var(--${sp.azione === 'scarta' ? 'danger' : 'accent'})">
    <div class="row between" style="align-items:flex-start;margin-bottom:6px">
      <b>${esc(sp.titolo)}</b>
      <button class="btn ghost" style="padding:2px 8px" data-action="chiudi-modifica" aria-label="Chiudi">✕</button>
    </div>
    <div class="small" style="line-height:1.6">${sp.frasi.map((f) => esc(f)).join(' ')}</div>
    ${
      sp.mosse.length
        ? `<div class="row wrap" style="gap:6px;margin-top:10px">
             ${sp.mosse
               .map(
                 (m) =>
                   `<span class="chip">${esc(ROLE_LABEL[m.role])} <b class="mono" style="color:var(--${
                     m.delta > 0 ? 'accent' : 'danger'
                   })">${m.delta > 0 ? '+' : ''}${m.delta}</b></span>`
               )
               .join('')}
           </div>`
        : ''
    }
  </div>`;
}

let modificaChiusa = null;

/**
 * Il piano non e' un verdetto: e' una proposta.
 *
 * Il lucchetto impone un giocatore e il solutore ricalcola tutto il resto attorno a lui, con i
 * crediti che restano; la crocetta lo toglie di mezzo per sempre. Sono le due cose che
 * un'ottimizzazione non puo' sapere da sola — che quel portiere lo vuoi comunque, o che di
 * quell'attaccante non ti fidi.
 */
function sceltaBottoni(p) {
  const stato = statoScelta(p.id);
  return `<div class="row" style="gap:4px">
    <button class="btn ${stato === 'bloccato' ? 'primary' : 'ghost'}" style="padding:8px 10px;min-width:40px"
      data-action="${stato === 'bloccato' ? 'libera' : 'blocca'}" data-id="${esc(p.id)}"
      aria-label="${stato === 'bloccato' ? 'Lascia decidere al piano' : 'Voglio questo giocatore'}"
      title="${stato === 'bloccato' ? 'Lascia decidere al piano' : 'Voglio questo giocatore'}">${stato === 'bloccato' ? '🔒' : '🔓'}</button>
    <button class="btn ${stato === 'escluso' ? 'danger' : 'ghost'}" style="padding:8px 10px;min-width:40px"
      data-action="${stato === 'escluso' ? 'libera' : 'scarta'}" data-id="${esc(p.id)}"
      aria-label="Non lo voglio" title="Non lo voglio">✕</button>
  </div>`;
}

function roleBlock(role, plan) {
  const owned = plan.owned.filter((p) => p.role === role).map((p) => ({ ...p, plannedPrice: p.paid, mine: true }));
  const picks = plan.picks.filter((p) => p.role === role);
  const all = [...owned, ...picks].sort((a, b) => b.plannedPrice - a.plannedPrice);
  const spent = plan.spentByRole[role] || 0;
  const cap = state.settings.roleBudget?.[role];
  const budget = state.settings.budget || 500;
  return `
  <div class="card">
    <div class="row between" style="margin-bottom:10px">
      <h3 style="margin:0">${roleChip(role)} ${ROLE_LABEL[role]}</h3>
      <div class="mono"><b>${spent}</b> <span class="small muted">cr · ${Math.round((spent / budget) * 100)}%${cap ? ` · tetto ${cap}` : ''}</span></div>
    </div>
    <div class="listwrap">
      <ul class="plist">
        ${all
          .map(
            (p) => `<li>
              ${roleChip(p.role)}
              <div class="grow">
                <div class="nm">${esc(p.name)}${p.bloccato ? ' <span class="chip plan">scelto da te</span>' : ''}</div>
                <div class="sub">${esc(p.team || '—')}${p.tier ? ' · ' + esc(p.tier) : ''}</div>
              </div>
              <div class="pr mono">${p.plannedPrice}<small>${p.mine ? 'pagato' : 'stima'}</small></div>
              ${p.mine ? '' : sceltaBottoni(p)}
            </li>`
          )
          .join('')}
      </ul>
    </div>
  </div>`;
}

/** Chi ho scartato a mano: deve restare visibile, altrimenti sparisce senza spiegazione. */
function scartatiCard() {
  const ids = Object.keys(state.auction.esclusi || {});
  if (!ids.length) return '';
  const scartati = ids.map((id) => state.players.find((p) => p.id === id)).filter(Boolean);
  if (!scartati.length) return '';
  return `
  <div class="card">
    <h2>Scartati da te</h2>
    <div class="tiny muted" style="margin-bottom:10px">Il piano non li propone piu'. Tocca per rimetterli in gioco.</div>
    <div class="row wrap" style="gap:6px">
      ${scartati
        .map((p) => `<button class="chip" data-action="libera" data-id="${esc(p.id)}">${roleChip(p.role)} ${esc(p.name)} ↩︎</button>`)
        .join('')}
    </div>
  </div>`;
}

function exposureCard(plan) {
  const all = [...plan.owned.map((p) => ({ ...p, plannedPrice: p.paid })), ...plan.picks];
  const rows = [...clubExposure(all, state.settings).entries()]
    .map(([team, v]) => ({ team, ...v }))
    .sort((a, b) => b.effettivi - a.effettivi)
    .slice(0, 6);
  if (!rows.length) return '';
  const cap = Number(state.settings.maxPerClub) || 0;
  return `
  <div class="card">
    <h2>Esposizione per club</h2>
    <div class="tiny muted" style="margin-bottom:10px">
      Quanti giocatori di ogni squadra finiresti per schierare davvero. I riempitivi contano per una frazione.
    </div>
    <table class="tiers">
      <thead><tr><th>Club</th><th class="r">In rosa</th><th class="r">Titolari</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr>
              <td>${esc(r.team || '—')}</td>
              <td class="r">${r.inRosa}</td>
              <td class="r ${cap && r.effettivi > cap ? '' : ''}"><b>${r.effettivi.toFixed(1)}</b></td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table>
    ${cap ? `<div class="tiny muted" style="margin-top:8px">Tetto impostato: ${cap} titolari per club.</div>` : ''}
  </div>`;
}

// La scheda d'asta si calcola su richiesta: sono 25 ottimizzazioni complete.
let scheda = null;
let schedaInCorso = false;

onReset(() => {
  scheda = null;
  schedaInCorso = false;
  modificaChiusa = null;
});

function buildScheda(rerender) {
  schedaInCorso = true;
  setTimeout(() => {
    try {
      const args = { players: state.players, settings: state.settings, owned: ownedMap(), unavailable: unavailableSet(), obbligati: obbligatiSet() };
      scheda = (state.plan?.picks || [])
        .slice()
        .sort((a, b) => b.plannedPrice - a.plannedPrice)
        .map((p) => ({
          player: p,
          bid: maxBid({ ...args, playerId: p.id }).maxBid,
          alts: alternatives({ ...args, playerId: p.id, limit: 3 }).alternatives,
        }));
    } catch (err) {
      console.error(err);
      scheda = [];
    } finally {
      schedaInCorso = false;
      rerender();
    }
  }, 30);
}

function schedaCard() {
  if (schedaInCorso) {
    return `<div class="card"><h2>Scheda d'asta</h2><div class="small muted"><span class="spinner"></span> Calcolo offerte massime e alternative…</div></div>`;
  }
  if (!scheda) {
    return `
    <div class="card">
      <h2>Scheda d'asta</h2>
      <p class="small muted" style="margin-top:0">
        Il foglio da tenere sott'occhio: per ogni obiettivo l'offerta massima e le tre alternative
        migliori se te lo soffiano. Preparalo prima di iniziare.
      </p>
      <button class="btn primary block" data-action="scheda">Prepara la scheda</button>
    </div>`;
  }
  return `
  <div class="card">
    <div class="row between" style="margin-bottom:10px">
      <h2 style="margin:0">Scheda d'asta</h2>
      <button class="btn ghost small" data-action="scheda">Ricalcola</button>
    </div>
    ${scheda
      .map(
        (row) => `
      <div style="padding:10px 0;border-bottom:1px solid var(--line)">
        <div class="row between">
          <div class="grow">
            ${roleChip(row.player.role)} <b>${esc(row.player.name)}</b> ${edgeBadge(row.player)}
            <span class="small muted">${esc(row.player.team || '')}</span>
          </div>
          <div class="mono" style="text-align:right">
            <b style="font-size:19px;color:var(--accent)">${row.bid}</b>
            <div class="tiny muted">max</div>
          </div>
        </div>
        ${
          row.alts.length
            ? `<div class="tiny muted" style="margin-top:4px">se lo perdi: ${row.alts
                .map((a) => `${esc(a.player.name)} <b>${a.price}</b>`)
                .join(' · ')}</div>`
            : ''
        }
      </div>`
      )
      .join('')}
  </div>`;
}

function tiersCard(plan) {
  const rows = tierBudgetReport({ plan, settings: state.settings, players: state.players, owned: ownedMap() });
  if (!rows.length) return '';
  return `
  <div class="card">
    <h2>Budget per fascia</h2>
    <table class="tiers">
      <thead><tr><th>Ruolo</th><th>Fascia</th><th class="r">Giocatori</th><th class="r">Crediti</th><th class="r">Speso</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr>
              <td>${roleChip(r.role)}</td>
              <td>${esc(r.tier)}</td>
              <td class="r">${r.plannedCount}</td>
              <td class="r"><b>${r.planned}</b></td>
              <td class="r ${r.spent ? '' : 'muted'}">${r.spent || '—'}</td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table>
  </div>`;
}

export function render() {
  if (!state.players.length) {
    return `<div class="view">${emptyState('📋', 'Nessun listone caricato', 'Importa prima il CSV delle fasce.')}</div>`;
  }
  if (!state.plan) rebuildPlan();
  const plan = state.plan;

  if (!plan?.ok) {
    return `<div class="view">
      <div class="card">
        <h3>Piano non calcolabile</h3>
        <div class="small" style="margin-top:8px">${esc(plan?.reason || 'Errore sconosciuto.')}</div>
      </div>
    </div>`;
  }

  const budget = state.settings.budget || 500;
  const filled = plan.owned.length;
  return `
  <div class="view">
    ${modificaCard()}
    <div class="card">
      <div class="row between">
        <div>
          <div class="credits mono" style="font-size:26px;font-weight:800">${plan.cost}<small style="font-size:11px;color:var(--muted)">crediti impegnati su ${budget}</small></div>
        </div>
        <button class="btn" data-action="replan">Rigenera</button>
      </div>
      <div class="bar" style="margin-top:12px"><i style="width:${Math.min(100, (plan.cost / budget) * 100)}%"></i></div>
      <div class="row between small muted" style="margin-top:8px">
        <span>${filled} presi · ${plan.picks.length} da prendere</span>
        <span>avanzo ${plan.leftover} cr</span>
      </div>
      <div class="grid4" style="margin-top:12px">
        ${ROLES.map(
          (r) => `<div class="slotbar"><div><b class="mono">${plan.spentByRole[r]}</b><span>${r}</span></div></div>`
        ).join('')}
      </div>
    </div>

    ${schedaCard()}
    ${ROLES.map((r) => roleBlock(r, plan)).join('')}
    ${tiersCard(plan)}
    ${scartatiCard()}
    ${exposureCard(plan)}

    <div class="card">
      <div class="small muted">
        Il piano tiene conto di chi hai gia' preso, di chi e' stato preso dagli altri e dei crediti che ti restano.
        Si aggiorna da solo dopo ogni assegnazione durante l'asta.
        Con <b>🔓</b> imponi un giocatore e il resto si ricalcola attorno a lui; con <b>✕</b> lo togli di mezzo.
      </div>
    </div>
  </div>`;
}

export function onAction(action, target, ev, rerender) {
  if (action === 'blocca' || action === 'scarta' || action === 'libera') {
    const id = target.dataset.id;
    const ok = action === 'blocca' ? blocca(id) : action === 'scarta' ? scarta(id) : liberaScelta(id);
    if (ok === false) toast('Con questo scarto la rosa non si chiude piu\'.');
    scheda = null;
    modificaChiusa = null;
    rerender();
    return true;
  }
  if (action === 'chiudi-modifica') {
    modificaChiusa = state.ultimaModifica?.at ?? null;
    rerender();
    return true;
  }
  if (action === 'replan') {
    rebuildPlan();
    scheda = null;
    rerender();
    return true;
  }
  if (action === 'scheda') {
    scheda = null;
    buildScheda(rerender);
    rerender();
    return true;
  }
  return false;
}
