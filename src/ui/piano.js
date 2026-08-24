// Il piano: la miglior rosa possibile con i crediti che restano, e come sono distribuiti.

import { state, rebuildPlan, ownedMap } from '../store.js';
import { ROLES, ROLE_LABEL, totalSlots } from '../domain/model.js';
import { tierBudgetReport } from '../domain/advisor.js';
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

    ${ROLES.map((r) => roleBlock(r, plan)).join('')}
    ${tiersCard(plan)}

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
    rerender();
    return true;
  }
  return false;
}
