// Impostazioni della lega: e' qui che si dice all'app che asta si sta giocando.

import { state, updateSettings, resetAll, rebuildPlan } from '../store.js';
import { ROLES, ROLE_LABEL, totalSlots } from '../domain/model.js';
import { esc, roleChip, toast } from './common.js';

function tierEditor() {
  const role = state.ui.tierRole || 'D';
  const order = state.settings.tierOrder?.[role] || [];
  if (!state.players.length) return '';
  return `
  <div class="card">
    <h2>Ordine delle fasce</h2>
    <p class="small muted" style="margin-top:0">
      Dalla migliore alla peggiore. L'ordine e' dedotto dalle etichette del tuo listone: correggilo se non
      corrisponde a come le usano i creators.
    </p>
    <div class="segment" style="margin-bottom:10px">
      ${ROLES.map((r) => `<button data-action="tierrole" data-role="${r}" aria-pressed="${role === r}">${r}</button>`).join('')}
    </div>
    ${
      order.length
        ? `<div class="listwrap"><ul class="plist tiersort">
            ${order
              .map(
                (t, i) => `<li>
                  <span class="idx">${i + 1}</span>
                  <span class="grow">${esc(t)}</span>
                  <button class="btn ghost" data-action="tierup" data-role="${role}" data-i="${i}" ${i === 0 ? 'disabled' : ''}>▲</button>
                  <button class="btn ghost" data-action="tierdown" data-role="${role}" data-i="${i}" ${i === order.length - 1 ? 'disabled' : ''}>▼</button>
                </li>`
              )
              .join('')}
          </ul></div>`
        : `<div class="small muted">Il listone importato non ha una colonna fascia per questo ruolo.</div>`
    }
  </div>`;
}

export function render() {
  const s = state.settings;
  return `
  <div class="view">
    <div class="card">
      <h2>La lega</h2>
      <div class="grid2">
        <label class="field"><span>Crediti a squadra</span>
          <input type="number" inputmode="numeric" value="${s.budget}" data-action="set" data-key="budget" min="1"></label>
        <label class="field"><span>Partecipanti</span>
          <input type="number" inputmode="numeric" value="${s.participants}" data-action="set" data-key="participants" min="2" max="30"></label>
      </div>
      <div class="small muted">Con ${s.participants} squadre girano <b>${s.budget * s.participants}</b> crediti in totale: e' da qui che nasce la stima dei prezzi d'asta.</div>
    </div>

    <div class="card">
      <h2>Rosa</h2>
      <div class="grid4">
        ${ROLES.map(
          (r) => `<label class="field" style="margin:0"><span>${r}</span>
            <input type="number" inputmode="numeric" value="${s.slots[r]}" data-action="setslot" data-key="${r}" min="0" max="15"></label>`
        ).join('')}
      </div>
      <div class="small muted" style="margin-top:4px">${totalSlots(s)} giocatori in rosa.</div>
    </div>

    <div class="card">
      <h2>Modulo di riferimento</h2>
      <p class="small muted" style="margin-top:0">Quanti ne schieri per ruolo. Serve a non farti spendere crediti sui panchinari: in porta ne gioca uno solo.</p>
      <div class="grid4">
        ${ROLES.map(
          (r) => `<label class="field" style="margin:0"><span>${r}</span>
            <input type="number" inputmode="numeric" value="${s.starters[r]}" data-action="setstarter" data-key="${r}" min="1" max="${s.slots[r]}"></label>`
        ).join('')}
      </div>
    </div>

    <div class="card">
      <h2>Modificatori</h2>
      <div class="switch">
        <div class="grow"><div class="lbl">Modificatore di difesa</div><div class="tiny muted">Alza il peso della difesa e premia i blocchi di club</div></div>
        <input type="checkbox" data-action="toggle" data-key="defenseModifier" ${s.defenseModifier ? 'checked' : ''}>
      </div>
      <div class="switch">
        <div class="grow"><div class="lbl">Imbattibilita' del portiere</div><div class="tiny muted">Premia il portiere titolare di una squadra solida</div></div>
        <input type="checkbox" data-action="toggle" data-key="cleanSheetModifier" ${s.cleanSheetModifier ? 'checked' : ''}>
      </div>
    </div>

    <div class="card">
      <h2>Come stimare i prezzi</h2>
      <div class="segment">
        ${[
          ['blend', 'Media'],
          ['model', 'Modello'],
          ['listone', 'Listone'],
        ]
          .map(([v, l]) => `<button data-action="pricesource" data-v="${v}" aria-pressed="${s.priceSource === v}">${l}</button>`)
          .join('')}
      </div>
      <div class="small muted" style="margin-top:8px">
        <b>Modello</b>: ridistribuisce i crediti della lega in base ai punteggi. <b>Listone</b>: usa le quotazioni del CSV.
        <b>Media</b>: la via di mezzo, consigliata.
      </div>
      <label class="field" style="margin-top:14px"><span>Aggressivita' del mercato sui top: ${Number(s.aggressiveness).toFixed(2)}</span>
        <input type="range" min="1" max="2.4" step="0.05" value="${s.aggressiveness}" data-action="aggr" style="width:100%">
      </label>
      <div class="tiny muted">Piu' e' alta, piu' l'app si aspetta aste furiose sui big.</div>
    </div>

    <div class="card">
      <h2>Tetti di spesa per ruolo</h2>
      <p class="small muted" style="margin-top:0">Facoltativi. Vincolano il piano: lascia vuoto per lasciar decidere all'ottimizzatore.</p>
      <div class="grid4">
        ${ROLES.map(
          (r) => `<label class="field" style="margin:0"><span>${r}</span>
            <input type="number" inputmode="numeric" placeholder="—" value="${s.roleBudget?.[r] ?? ''}" data-action="setcap" data-key="${r}" min="0"></label>`
        ).join('')}
      </div>
    </div>

    <div class="card">
      <h2>Concentrazione per club</h2>
      <p class="small muted" style="margin-top:0">
        Con il modificatore di difesa conviene avere piu' difensori della stessa squadra: prendono voto
        alto nella stessa giornata e la soglia scatta. Ma legare mezza rosa a un solo club significa
        crollare tutti insieme se quella squadra va male. Il conteggio e' sui <b>titolari</b>: i
        riempitivi da un credito non pesano.
      </p>
      <label class="field" style="margin-bottom:0"><span>Massimo titolari dallo stesso club${s.maxPerClub ? '' : ' — nessun limite'}</span>
        <input type="number" inputmode="numeric" value="${s.maxPerClub || ''}" placeholder="nessun limite" data-action="setmaxclub" min="0" max="11">
      </label>
      <div class="tiny muted" style="margin-top:6px">4 lascia passare il blocco portiere + tre difensori e ferma tutto il resto.</div>
    </div>

    ${tierEditor()}

    <div class="card">
      <button class="btn danger block" data-action="reset">Cancella tutto e ricomincia</button>
      <div class="tiny muted center" style="margin-top:8px">Listone, impostazioni e asta in corso restano solo su questo dispositivo.</div>
    </div>
  </div>`;
}

export function onAction(action, target, ev, rerender) {
  const s = state.settings;
  switch (action) {
    case 'pricesource':
      updateSettings({ priceSource: target.dataset.v });
      rerender();
      return true;
    case 'tierrole':
      state.ui.tierRole = target.dataset.role;
      rerender();
      return true;
    case 'tierup':
    case 'tierdown': {
      const role = target.dataset.role;
      const i = Number(target.dataset.i);
      const order = [...(s.tierOrder[role] || [])];
      const j = action === 'tierup' ? i - 1 : i + 1;
      if (j < 0 || j >= order.length) return true;
      [order[i], order[j]] = [order[j], order[i]];
      updateSettings({ tierOrder: { ...s.tierOrder, [role]: order } });
      rerender();
      return true;
    }
    case 'reset':
      if (confirm('Cancello listone, impostazioni e asta in corso. Confermi?')) {
        resetAll();
        toast('Tutto azzerato.');
        rerender();
      }
      return true;
    default:
      return false;
  }
}

export function onInput(action, target, rerender) {
  const s = state.settings;
  switch (action) {
    case 'set': {
      const v = Math.max(1, Number(target.value) || 0);
      updateSettings({ [target.dataset.key]: v });
      rerender({ keepFocus: null, soft: true });
      return true;
    }
    case 'setslot': {
      const slots = { ...s.slots, [target.dataset.key]: Math.max(0, Number(target.value) || 0) };
      const starters = { ...s.starters };
      // I titolari non possono superare gli slot disponibili.
      for (const r of ROLES) starters[r] = Math.min(starters[r], Math.max(1, slots[r]));
      updateSettings({ slots, starters });
      rerender({ soft: true });
      return true;
    }
    case 'setstarter': {
      const r = target.dataset.key;
      const v = Math.min(Math.max(1, Number(target.value) || 1), s.slots[r] || 1);
      updateSettings({ starters: { ...s.starters, [r]: v } });
      rerender({ soft: true });
      return true;
    }
    case 'setcap': {
      const raw = target.value.trim();
      updateSettings({ roleBudget: { ...s.roleBudget, [target.dataset.key]: raw === '' ? null : Math.max(0, Number(raw) || 0) } });
      rerender({ soft: true });
      return true;
    }
    case 'setmaxclub': {
      const raw = target.value.trim();
      updateSettings({ maxPerClub: raw === '' ? 0 : Math.max(0, Number(raw) || 0) });
      rerender({ soft: true });
      return true;
    }
    case 'toggle':
      updateSettings({ [target.dataset.key]: target.checked });
      rerender();
      return true;
    case 'aggr':
      updateSettings({ aggressiveness: Number(target.value) });
      rerender({ soft: true });
      return true;
    default:
      return false;
  }
}
