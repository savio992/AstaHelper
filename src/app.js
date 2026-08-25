// Punto d'ingresso: schede, instradamento e delega degli eventi.

import { state, load, save, notify, subscribe, rebuildPlan } from './store.js';
import * as asta from './ui/asta.js';
import * as piano from './ui/piano.js';
import * as mercato from './ui/mercato.js';
import * as listone from './ui/listone.js';
import * as setup from './ui/setup.js';

const TABS = [
  ['asta', 'Asta', '🎯'],
  ['mercato', 'Mercato', '📈'],
  ['piano', 'Piano', '📊'],
  ['listone', 'Listone', '📋'],
  ['setup', 'Lega', '⚙️'],
];

const VIEWS = { asta, mercato, piano, listone, setup };

const root = document.getElementById('app');
const tabbar = document.getElementById('tabbar');

let scrollByTab = {};

function renderTabs() {
  tabbar.innerHTML = TABS.map(
    ([id, label, icon]) =>
      `<button data-tab="${id}" aria-current="${state.ui.tab === id}"><span class="ico">${icon}</span>${label}</button>`
  ).join('');
}

/** Ridisegna la vista corrente conservando il focus e la posizione del cursore. */
export function render(opts = {}) {
  const view = VIEWS[state.ui.tab] || asta;
  const active = document.activeElement;
  const focusId = opts.keepFocus ?? (active && active.id ? active.id : null);
  const selection = focusId && active?.id === focusId ? [active.selectionStart, active.selectionEnd] : null;

  root.innerHTML = view.render(render);
  renderTabs();

  if (focusId) {
    const next = document.getElementById(focusId);
    if (next) {
      next.focus({ preventScroll: true });
      if (selection && next.setSelectionRange && next.type !== 'number') {
        try {
          next.setSelectionRange(selection[0], selection[1]);
        } catch {
          /* alcuni input non lo permettono */
        }
      }
    }
  }
}

function switchTab(tab) {
  scrollByTab[state.ui.tab] = window.scrollY;
  state.ui.tab = tab;
  save();
  render();
  window.scrollTo(0, scrollByTab[tab] || 0);
}

function handle(kind, ev) {
  const target = ev.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const view = VIEWS[state.ui.tab] || asta;
  if (kind === 'click') {
    if (target.matches('input, select, textarea')) return;
    if (view.onAction?.(action, target, ev, render)) ev.preventDefault();
  } else if (view.onInput?.(action, target, render)) {
    // gestito dalla vista
  }
}

document.addEventListener('click', (ev) => {
  const tab = ev.target.closest('[data-tab]');
  if (tab) {
    switchTab(tab.dataset.tab);
    return;
  }
  handle('click', ev);
});
document.addEventListener('input', (ev) => handle('input', ev));
document.addEventListener('change', (ev) => handle('input', ev));

subscribe(() => {
  /* le viste si ridisegnano esplicitamente: qui basta tenere il piano allineato */
});

// Avvio
const restored = load();
if (restored && state.players.length && !state.plan) rebuildPlan();
if (!restored) state.ui.tab = 'listone';
render();

// Se il listone c'e' ma il piano no (primo avvio dopo un import), lo calcoliamo subito.
if (state.players.length && !state.plan) {
  setTimeout(() => {
    rebuildPlan();
    render();
  }, 30);
}
