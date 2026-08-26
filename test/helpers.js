import { defaultSettings, inferTierOrder, annotateTierPct, annotatePmaShare, annotatePriceShare, ROLES } from '../src/domain/model.js';
import { valuePlayers, markTopPlayers } from '../src/domain/valuation.js';
import { withExpectedPrices } from '../src/domain/market.js';

const CLUBS = ['Inter', 'Napoli', 'Juventus', 'Milan', 'Atalanta', 'Roma', 'Lazio', 'Bologna',
  'Fiorentina', 'Torino', 'Udinese', 'Genoa', 'Como', 'Cagliari', 'Verona', 'Lecce',
  'Parma', 'Empoli', 'Monza', 'Venezia'];

const TIERS = ['Top', 'Semi-Top', '1a fascia', '2a fascia', '3a fascia', 'Scommessa', 'Low cost'];

// Generatore deterministico, cosi' i test non sfarfallano.
function mulberry(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Listone con le proiezioni dei creators: fantamedia attesa, titolarita' e integrita'.
 * E' il percorso principale del modello; `makeListone` copre invece il ripiego per i
 * listoni poveri, che hanno solo fasce e quotazioni.
 */
export function makeListoneProjected(seed = 7) {
  const rnd = mulberry(seed);
  return makeListone(seed).map((p) => {
    const tierIdx = TIERS.indexOf(p.tier);
    // I portieri hanno fantamedie tutte vicine, come nei listoni veri.
    const spread = p.role === 'P' ? 0.5 : p.role === 'D' ? 1.6 : p.role === 'C' ? 2.0 : 2.6;
    const base = p.role === 'P' ? 4.9 : 5.9;
    return {
      ...p,
      fmvExp: Math.round((base + spread * (1 - tierIdx / (TIERS.length - 1)) + rnd() * 0.2) * 100) / 100,
      titolarita: Math.max(1, Math.min(5, 5 - Math.floor(tierIdx * 0.8))),
      integrita: 3 + Math.floor(rnd() * 3),
      tags: p.role === 'D' && tierIdx <= 1 ? ['modificatore'] : p.role === 'P' && tierIdx === 0 ? ['imbattibilita'] : [],
    };
  });
}

/** Listone sintetico realistico: 3 portieri, 9 difensori, 9 centrocampisti, 6 attaccanti per club. */
export function makeListone(seed = 42) {
  const rnd = mulberry(seed);
  const players = [];
  const perRole = { P: 3, D: 9, C: 9, A: 6 };
  for (const club of CLUBS) {
    for (const role of ROLES) {
      for (let i = 0; i < perRole[role]; i++) {
        const tierIdx = Math.min(TIERS.length - 1, Math.floor(i * (TIERS.length / perRole[role]) + rnd() * 1.2));
        const tier = TIERS[tierIdx];
        const base = Math.max(1, Math.round((30 - tierIdx * 4.5) * (role === 'A' ? 1.6 : role === 'C' ? 1.1 : role === 'D' ? 0.8 : 0.5) * (0.6 + rnd())));
        players.push({
          id: `${club}-${role}-${i}`,
          name: `${role}${i} ${club}`,
          team: club,
          role,
          roleMantra: role,
          tier,
          price: base,
          fvm: base * 2,
          fantamedia: null, mediavoto: null, matches: null, goals: null, assists: null,
          penalties: '', notes: '',
        });
      }
    }
  }
  return players;
}

/**
 * Ricostruisce la stessa catena dello store, cosi' i test vedono i giocatori come li vede
 * l'applicazione: quote normalizzate, fasce in percentile, prezzi attesi e marcatura dei top.
 */
export function makeContext(overrides = {}, seed = 42) {
  const raw = overrides.projected ? makeListoneProjected(seed) : makeListone(seed);
  const settings = { ...defaultSettings(), ...overrides };
  if (overrides.minTop) settings.minTop = { ...defaultSettings().minTop, ...overrides.minTop };
  const annotated = annotatePriceShare(annotatePmaShare(annotateTierPct(raw)));
  for (const role of ROLES) settings.tierOrder[role] = inferTierOrder(annotated, role);
  const players = markTopPlayers(withExpectedPrices(valuePlayers(annotated, settings), settings), settings);
  return { players, settings };
}
