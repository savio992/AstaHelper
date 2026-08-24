// Utilita' condivise di rendering. Niente framework: template string + delega degli eventi.

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function n(v, d = 0) {
  const x = Number(v);
  if (!Number.isFinite(x)) return '—';
  return x.toFixed(d);
}

export const ROLE_NAME = { P: 'Por', D: 'Dif', C: 'Cen', A: 'Att' };

export function roleChip(role) {
  return `<span class="chip ${role}">${ROLE_NAME[role] || role}</span>`;
}

let toastTimer = null;
export function toast(msg) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    document.body.appendChild(node);
  }
  node.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 2200);
}

/** Ricerca tollerante: ignora accenti e maiuscole, accetta parole in qualunque ordine. */
export function matches(player, query) {
  if (!query) return true;
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  const hay = `${norm(player.name)} ${norm(player.team)}`;
  return norm(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** Riga di elenco giocatore, usata sia nel listone sia nella ricerca d'asta. */
export function playerRow(p, { status, price, priceLabel = 'atteso', selected, inPlan } = {}) {
  const badges = [];
  if (status === 'mine') badges.push('<span class="chip mine">Mio</span>');
  else if (status === 'other') badges.push('<span class="chip gone">Preso</span>');
  else if (inPlan) badges.push('<span class="chip plan">In piano</span>');
  return `
    <li class="${selected ? 'sel' : ''} ${status === 'other' ? 'gone' : ''}" data-action="select" data-id="${esc(p.id)}">
      ${roleChip(p.role)}
      <div class="grow">
        <div class="nm">${esc(p.name)} ${badges.join(' ')}</div>
        <div class="sub">${esc(p.team || '—')}${p.tier ? ' · ' + esc(p.tier) : ''}</div>
      </div>
      <div class="pr mono">${price ?? Math.round(p.expectedPrice ?? 0)}<small>${esc(priceLabel)}</small></div>
    </li>`;
}

export function emptyState(icon, title, text) {
  return `<div class="empty"><div class="big">${icon}</div><div><b>${esc(title)}</b></div><div class="small" style="margin-top:6px">${text}</div></div>`;
}
