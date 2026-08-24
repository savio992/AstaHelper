// Il piano: la miglior rosa possibile con i crediti che restano, e come sono distribuiti.

import { state, rebuildPlan } from '../store.js';
import { ROLES, ROLE_LABEL, totalSlots } from '../domain/model.js';
import { tierBudgetReport, maxBid, alternatives } from '../domain/advisor.js';
import { clubExposure } from '../domain/valuation.js';
import { ownedMap, unavailableSet } from '../store.js';
import { esc, roleChip, emptyState, playerRow } from './common.js';

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
          .map((p) =>
            playerRow(p, {
              price: p.plannedPrice,
              priceLabel: p.mine ? 'pagato' : 'stima',
              status: p.mine ? 'mine' : null,
            })
          )
          .join('')}
      </ul>
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

function buildScheda(rerender) {
  schedaInCorso = true;
  setTimeout(() => {
    try {
      const args = { players: state.players, settings: state.settings, owned: ownedMap(), unavailable: unavailableSet() };
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
            ${roleChip(row.player.role)} <b>${esc(row.player.name)}</b>
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
    ${exposureCard(plan)}

    <div class="card">
      <div class="small muted">
        Il piano tiene conto di chi hai gia' preso, di chi e' stato preso dagli altri e dei crediti che ti restano.
        Si aggiorna da solo dopo ogni assegnazione durante l'asta.
      </div>
    </div>
  </div>`;
}

export function onAction(action, target, ev, rerender) {
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
