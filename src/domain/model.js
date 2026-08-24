// Impostazioni della lega e valori di default.

export const ROLES = ['P', 'D', 'C', 'A'];

export const ROLE_LABEL = { P: 'Portieri', D: 'Difensori', C: 'Centrocampisti', A: 'Attaccanti' };
export const ROLE_LABEL_SHORT = { P: 'Por', D: 'Dif', C: 'Cen', A: 'Att' };

// Scala unica di qualita' delle fasce: piu' basso = fascia migliore.
// Serve solo a proporre un ordinamento automatico all'import; resta tutto modificabile a mano.
const NAMED_TIERS = [
  [/^(top|top player|fuoriclasse|campione)/, 0],
  [/^(semi ?top|quasi top)/, 0.5],
  [/^(jolly)/, 90],
  [/^(sorpresa|rivelazione)/, 91],
  [/^(scommessa|scommesse)/, 92],
  [/^(low ?cost|occasione)/, 93],
  [/^(riserva|riserve|panchina)/, 94],
  [/^(terzo portiere|terzi portieri)/, 95],
  [/^(da evitare|evitare|sconsigliat)/, 99],
];

const ORDINAL_WORDS = { prima: 1, seconda: 2, terza: 3, quarta: 4, quinta: 5, sesta: 6, settima: 7, ottava: 8 };

function tierSortKey(label) {
  const n = String(label)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  for (const [re, value] of NAMED_TIERS) {
    if (re.test(n)) return [value, n];
  }
  for (const [word, value] of Object.entries(ORDINAL_WORDS)) {
    if (n.includes(word)) return [value, n];
  }
  const num = n.match(/(\d+)/);
  if (num) return [Number(num[1]), n];
  // Etichetta sconosciuta: la mettiamo a meta' classifica, l'utente potra' spostarla.
  return [50, n];
}

/** Ordina un elenco di etichette di fascia dalla migliore alla peggiore, con euristica. */
export function sortTierLabels(labels) {
  return [...labels].sort((a, b) => {
    const ka = tierSortKey(a);
    const kb = tierSortKey(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    return ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0;
  });
}

export function defaultSettings() {
  return {
    budget: 500,
    participants: 10,
    slots: { P: 3, D: 8, C: 8, A: 6 },
    // Quanti giocatori per ruolo schieri di solito (modulo di riferimento, default 3-4-3).
    // Serve a non far spendere crediti su panchinari: in porta ne gioca uno solo.
    starters: { P: 1, D: 3, C: 4, A: 3 },
    // Modificatore di difesa attivo: alza il peso di difensori e portiere e premia il blocco di club.
    defenseModifier: true,
    // Modificatore imbattibilita' del portiere: alza molto il peso del portiere titolare.
    cleanSheetModifier: true,
    // Quanto il mercato "impenna" sui top: 1 = lineare, 2 = aste molto aggressive sui big.
    aggressiveness: 1.55,
    // Da dove arrivano i prezzi attesi: modello di mercato, quotazioni del listone, o media.
    priceSource: 'blend',
    // Tetti opzionali di spesa per ruolo (crediti). null = nessun vincolo.
    roleBudget: { P: null, D: null, C: null, A: null },
    // Ordine delle fasce per ruolo (dalla migliore alla peggiore), popolato all'import.
    tierOrder: { P: [], D: [], C: [], A: [] },
    // Massimo numero di giocatori dallo stesso club (0 = nessun limite).
    maxPerClub: 0,
  };
}

export function totalSlots(settings) {
  return ROLES.reduce((sum, r) => sum + (settings.slots[r] || 0), 0);
}

/** Chiave stabile per una coppia ruolo+fascia. */
export function tierKey(role, tier) {
  return `${role}::${tier || '—'}`;
}

export function tierRank(settings, role, tier) {
  const order = settings.tierOrder?.[role] || [];
  const idx = order.indexOf(tier);
  return idx >= 0 ? idx : order.length;
}
