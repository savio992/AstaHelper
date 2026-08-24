// La schermata che uso durante l'asta: crediti, offerta massima, alternative.

import { state, assign, release, undo, ownedMap, unavailableSet, playerById, creditsLeft, rebuildPlan } from '../store.js';
import { ROLES, totalSlots } from '../domain/model.js';
import { maxBid, alternatives, maxSpendableNow, slotsLeftByRole } from '../domain/advisor.js';
import { esc, roleChip, matches, playerRow, emptyState, toast } from './common.js';

// I calcoli d'asta costano decine di millisecondi: li teniamo in cache finche' non cambia nulla.
let cache = { key: null, bid: null, alts: null };
let pending = false;

function cacheKey() {
  return `${state.ui.selectedId}|${state.auction.log.length}|${JSON.stringify(state.settings)}`;
}

export function invalidate() {
  cache = { key: null, bid: null, alts: null };
}

function ensureAdvice(rerender) {
  const key = cacheKey();
  if (cache.key === key || !state.ui.selectedId || pending) return;
  pending = true;
  // Un frame di respiro cosi' lo spinner viene disegnato prima del calcolo.
  setTimeout(() => {
    try {
      const args = {
        players: state.players,
        settings: state.settings,
        owned: ownedMap(),
        unavailable: unavailableSet(),
        playerId: state.ui.selectedId,
      };
      cache = { key, bid: maxBid(args), alts: alternatives({ ...args, limit: 5 }) };
    } catch (err) {
      console.error(err);
      cache = { key, bid: null, alts: null };
    } finally {
      pending = false;
      rerender();
    }
  }, 16);
}

function hud() {
  const left = creditsLeft();
  const budget = state.settings.budget || 500;
  const owned = ownedMap();
  const slots = slotsLeftByRole(state.settings, state.players, owned);
  const filled = owned.size;
  const pct = Math.max(0, Math.min(100, (left / budget) * 100));
  const spendable = maxSpendableNow(state.settings, owned);
  return `
  <div class="card">
    <div class="hud">
      <div class="credits mono">${left}<small>crediti liberi</small></div>
      <div>
        <div class="bar"><i style="width:${pct}%" class="${left < 0 ? 'over' : ''}"></i></div>
        <div class="row between small muted" style="margin-top:6px">
          <span>${filled}/${totalSlots(state.settings)} slot</span>
          <span>max su un giocatore: <b class="mono">${spendable}</b></span>
        </div>
      </div>
    </div>
    <div class="slotbar" style="margin-top:12px">
      ${ROLES.map((r) => `<div><b class="mono">${slots[r]}</b><span>${r === 'P' ? 'POR' : r === 'D' ? 'DIF' : r === 'C' ? 'CEN' : 'ATT'}</span></div>`).join('')}
    </div>
  </div>`;
}

function verdictFor(price, bid) {
  if (!bid) return '';
  if (bid.maxBid <= 0) return `<div class="verdict stop">Lascialo andare: non migliora la rosa.</div>`;
  if (price > bid.maxBid) return `<div class="verdict stop">Fermati. Oltre ${bid.maxBid} conviene il piano B.</div>`;
  if (price >= bid.maxBid - Math.max(1, Math.round(bid.maxBid * 0.08)))
    return `<div class="verdict edge">Sei al limite: puoi arrivare a ${bid.maxBid}, non oltre.</div>`;
  return `<div class="verdict go">Rilancia pure: hai margine fino a ${bid.maxBid}.</div>`;
}

function detail(p) {
  const owned = ownedMap();
  const status = state.auction.owned[p.id] !== undefined ? 'mine' : state.auction.taken[p.id] !== undefined ? 'other' : null;
  const bid = cache.key === cacheKey() ? cache.bid : null;
  const alts = cache.key === cacheKey() ? cache.alts : null;
  const inPlan = state.plan?.picks?.some((x) => x.id === p.id);
  const planned = state.plan?.picks?.find((x) => x.id === p.id)?.plannedPrice;
  const current = state.ui.bidPrice ?? Math.round(p.expectedPrice ?? 1);
  const spendable = maxSpendableNow(state.settings, owned);

  const paid = status === 'mine' ? state.auction.owned[p.id] : status === 'other' ? state.auction.taken[p.id] : null;

  return `
  <div class="card">
    <div class="row between" style="align-items:flex-start">
      <div class="grow">
        <h3 style="margin-bottom:4px">${esc(p.name)}</h3>
        <div class="row wrap" style="gap:6px">
          ${roleChip(p.role)}
          <span class="chip">${esc(p.team || '—')}</span>
          ${p.tier ? `<span class="chip">${esc(p.tier)}</span>` : ''}
          ${inPlan ? '<span class="chip plan">In piano</span>' : ''}
          ${status === 'mine' ? `<span class="chip mine">Mio a ${paid}</span>` : ''}
          ${status === 'other' ? `<span class="chip gone">Preso da altri a ${paid}</span>` : ''}
        </div>
      </div>
      <button class="btn ghost" data-action="close-detail" aria-label="Chiudi">✕</button>
    </div>

    ${creatorInfo(p)}

    ${
      status
        ? `<div style="margin-top:14px"><button class="btn block" data-action="release" data-id="${esc(p.id)}">Annulla assegnazione</button></div>`
        : `
    <div class="maxbid">
      ${
        bid
          ? `<div class="n mono ${bid.maxBid <= 0 ? 'zero' : ''}">${bid.maxBid}</div>
             <div class="lbl">offerta massima conveniente</div>
             ${bid.reason ? `<div class="small muted" style="margin-top:6px">${esc(bid.reason)}</div>` : ''}`
          : `<div class="n mono"><span class="spinner"></span></div><div class="lbl">calcolo in corso</div>`
      }
    </div>

    <div class="row between small muted" style="margin-bottom:10px">
      <span>prezzo atteso <b class="mono">${Math.round(p.expectedPrice ?? 0)}</b></span>
      ${planned ? `<span>a piano <b class="mono">${planned}</b></span>` : ''}
      <span>tetto tecnico <b class="mono">${spendable}</b></span>
    </div>

    <div class="stepper">
      <button class="btn" data-action="bid-minus">−</button>
      <input type="number" inputmode="numeric" class="mono" id="bidprice" value="${current}" min="0" max="${spendable}" data-action="bid-input">
      <button class="btn" data-action="bid-plus">+</button>
    </div>
    <div style="margin-top:10px">${verdictFor(current, bid)}</div>

    <div class="grid2" style="margin-top:12px">
      <button class="btn primary" data-action="take-mine" data-id="${esc(p.id)}">L'ho preso io</button>
      <button class="btn danger" data-action="take-other" data-id="${esc(p.id)}">Preso da altri</button>
    </div>`
    }
  </div>

  ${status === 'other' || !status ? altsCard(p, alts) : ''}
  `;
}

/** Quello che i creators dicono di lui: giudizi, etichette, disaccordo sul prezzo. */
function creatorInfo(p) {
  const bits = [];
  if (Number.isFinite(p.titolarita)) bits.push(`titolarita' ${'●'.repeat(Math.round(p.titolarita))}${'○'.repeat(5 - Math.round(p.titolarita))}`);
  if (Number.isFinite(p.integrita)) bits.push(`integrita' ${'●'.repeat(Math.round(p.integrita))}${'○'.repeat(5 - Math.round(p.integrita))}`);
  if (Number.isFinite(p.expShare)) bits.push(`~${Math.round(p.expShare * 38)} presenze attese`);

  const disagreement =
    Number.isFinite(p.priceMin) && Number.isFinite(p.priceMax) && p.priceMax > p.priceMin
      ? `<div class="verdict edge" style="margin-top:10px;text-align:left">
           I creators non sono d'accordo: da <b>${Math.round(p.priceMin)}</b> a <b>${Math.round(p.priceMax)}</b> crediti.
           ${p.priceSpread > 0.35 ? 'Divario ampio: se va via al prezzo basso puo' + "'" + ' essere un affare.' : ''}
         </div>`
      : '';

  const tiers = p.tiersBySource
    ? Object.entries(p.tiersBySource).map(([src, tier]) => `<span class="chip">${esc(src)}: ${esc(tier)}</span>`).join(' ')
    : '';

  if (!bits.length && !p.tags?.length && !disagreement && !p.notes) return '';

  return `
  <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
    ${bits.length ? `<div class="small muted mono">${bits.join(' · ')}</div>` : ''}
    ${p.tags?.length ? `<div class="row wrap" style="gap:5px;margin-top:8px">${p.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
    ${tiers ? `<div class="row wrap" style="gap:5px;margin-top:8px">${tiers}</div>` : ''}
    ${disagreement}
    ${p.notes ? `<details style="margin-top:10px"><summary class="small muted">Commento del creator</summary><div class="small" style="margin-top:6px;white-space:pre-wrap">${esc(p.notes.slice(0, 1200))}</div></details>` : ''}
  </div>`;
}

function altsCard(p, alts) {
  if (!alts) {
    return `<div class="card"><h2>Se lo perdo</h2><div class="small muted"><span class="spinner"></span> Ricalcolo la rosa senza di lui…</div></div>`;
  }
  if (!alts.alternatives.length) {
    return `<div class="card"><h2>Se lo perdo</h2><div class="small muted">Nessuna alternativa sostenibile con i crediti rimasti.</div></div>`;
  }
  return `
  <div class="card">
    <h2>Se lo perdo</h2>
    <div class="small muted" style="margin-bottom:10px">
      Rosa ricalcolata senza di lui. <b>Δ</b> = punti guadagnati o persi rispetto a prenderlo al suo prezzo atteso.
    </div>
    ${alts.alternatives
      .map((a) => {
        const d = a.deltaVsTarget;
        const cls = d === null ? '' : d >= 0 ? 'pos' : 'neg';
        const sign = d === null ? '' : d > 0 ? '+' : '';
        return `
      <div class="alt" data-action="select" data-id="${esc(a.player.id)}">
        ${roleChip(a.player.role)}
        <div class="grow">
          <div class="nm">${esc(a.player.name)}</div>
          <div class="sub small muted">${esc(a.player.team || '—')}${a.player.tier ? ' · ' + esc(a.player.tier) : ''} · ${a.price} cr</div>
        </div>
        <div class="delta ${cls}">${sign}${d === null ? '—' : d}</div>
      </div>`;
      })
      .join('')}
  </div>`;
}

function targetsCard() {
  const plan = state.plan;
  if (!plan?.ok) return '';
  const pending = plan.picks.filter((p) => !state.auction.owned[p.id] && !state.auction.taken[p.id]);
  if (!pending.length) return '';
  const byRole = {};
  for (const p of pending) (byRole[p.role] ||= []).push(p);
  return `
  <div class="card">
    <div class="row between" style="margin-bottom:8px">
      <h2 style="margin:0">Obiettivi ancora liberi</h2>
      <span class="tiny muted">${pending.length}</span>
    </div>
    <div class="tiny muted" style="margin-bottom:10px">
      Durante l'asta tocca <b>✕</b> quando uno di questi va a un avversario: un solo tocco, senza prezzo.
      Gli altri giocatori puoi ignorarli.
    </div>
    <div class="listwrap">
      <ul class="plist">
        ${ROLES.flatMap((r) => (byRole[r] || []).sort((a, b) => b.plannedPrice - a.plannedPrice))
          .map(
            (p) => `<li>
              ${roleChip(p.role)}
              <div class="grow" data-action="select" data-id="${esc(p.id)}">
                <div class="nm">${esc(p.name)}</div>
                <div class="sub">${esc(p.team || '—')}${p.tier ? ' · ' + esc(p.tier) : ''}</div>
              </div>
              <div class="pr mono" data-action="select" data-id="${esc(p.id)}">${p.plannedPrice}<small>a piano</small></div>
              <button class="btn danger" style="min-width:46px;padding:10px" data-action="quick-gone" data-id="${esc(p.id)}" aria-label="Preso da un avversario">✕</button>
            </li>`
          )
          .join('')}
      </ul>
    </div>
  </div>`;
}

export function render(rerender) {
  if (!state.players.length) {
    return `<div class="view">${emptyState('📋', 'Nessun listone caricato', 'Vai su <b>Listone</b> e importa il CSV delle fasce dei creators.')}</div>`;
  }
  if (!state.plan) rebuildPlan();

  const selected = state.ui.selectedId ? playerById(state.ui.selectedId) : null;
  if (selected) ensureAdvice(rerender);

  const q = state.ui.query;
  const roleFilter = state.ui.roleFilter;
  let results = [];
  if (q.trim()) {
    results = state.players
      .filter((p) => (roleFilter === 'ALL' || p.role === roleFilter) && matches(p, q))
      .sort((a, b) => (b.expectedPrice ?? 0) - (a.expectedPrice ?? 0))
      .slice(0, 40);
  }

  return `
  <div class="view">
    ${hud()}

    <div class="card">
      <input type="search" id="astaQuery" placeholder="Cerca il giocatore all'asta…" value="${esc(q)}" data-action="query" autocomplete="off" autocorrect="off" spellcheck="false">
      <div class="segment" style="margin-top:10px">
        ${['ALL', ...ROLES]
          .map(
            (r) =>
              `<button data-action="rolefilter" data-role="${r}" aria-pressed="${roleFilter === r}">${r === 'ALL' ? 'Tutti' : r}</button>`
          )
          .join('')}
      </div>
      ${
        results.length
          ? `<div class="listwrap" style="margin-top:12px"><ul class="plist">${results
              .map((p) =>
                playerRow(p, {
                  status: state.auction.owned[p.id] !== undefined ? 'mine' : state.auction.taken[p.id] !== undefined ? 'other' : null,
                  selected: p.id === state.ui.selectedId,
                  inPlan: state.plan?.picks?.some((x) => x.id === p.id),
                })
              )
              .join('')}</ul></div>`
          : q.trim()
            ? `<div class="small muted center" style="padding:14px">Nessun giocatore trovato.</div>`
            : ''
      }
    </div>

    ${selected ? detail(selected) : ''}
    ${selected ? '' : targetsCard()}

    <div class="row" style="gap:10px">
      <button class="btn grow" data-action="undo" ${state.auction.log.length ? '' : 'disabled'}>↩︎ Annulla ultima</button>
    </div>
  </div>`;
}

export function onAction(action, target, ev, rerender) {
  const id = target.dataset.id;
  switch (action) {
    case 'select':
      state.ui.selectedId = id;
      state.ui.bidPrice = null;
      rerender();
      return true;
    case 'close-detail':
      state.ui.selectedId = null;
      state.ui.bidPrice = null;
      rerender();
      return true;
    case 'rolefilter':
      state.ui.roleFilter = target.dataset.role;
      rerender();
      return true;
    case 'bid-minus':
    case 'bid-plus': {
      const input = document.getElementById('bidprice');
      const step = action === 'bid-plus' ? 1 : -1;
      state.ui.bidPrice = Math.max(0, (Number(input?.value) || 0) + step);
      rerender();
      return true;
    }
    case 'take-mine':
    case 'take-other': {
      const price = Number(document.getElementById('bidprice')?.value) || 0;
      const p = playerById(id);
      if (action === 'take-mine') {
        const spendable = maxSpendableNow(state.settings, ownedMap());
        if (price > spendable) {
          toast(`Non puoi spendere ${price}: il tetto e' ${spendable}.`);
          return true;
        }
      }
      assign(id, action === 'take-mine' ? 'mine' : 'other', price);
      invalidate();
      state.ui.selectedId = null;
      state.ui.bidPrice = null;
      state.ui.query = '';
      toast(action === 'take-mine' ? `${p?.name} tuo a ${price}.` : `${p?.name} va a un avversario.`);
      rerender();
      return true;
    }
    case 'quick-gone': {
      const p = playerById(id);
      // Il prezzo pagato dagli avversari non entra in nessun calcolo: registriamo la stima
      // per avere comunque uno storico, senza chiedere niente durante l'asta.
      assign(id, 'other', Math.round(p?.expectedPrice ?? 0));
      invalidate();
      toast(`${p?.name} va via.`);
      rerender();
      return true;
    }
    case 'release':
      release(id);
      invalidate();
      rerender();
      return true;
    case 'undo':
      undo();
      invalidate();
      state.ui.selectedId = null;
      rerender();
      return true;
    default:
      return false;
  }
}

export function onInput(action, target, rerender) {
  if (action === 'query') {
    state.ui.query = target.value;
    rerender({ keepFocus: 'astaQuery' });
    return true;
  }
  if (action === 'bid-input') {
    state.ui.bidPrice = Number(target.value) || 0;
    rerender({ keepFocus: 'bidprice' });
    return true;
  }
  return false;
}
