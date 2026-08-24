import { defaultSettings, sortTierLabels, ROLES } from '../src/domain/model.js';
import { valuePlayers } from '../src/domain/valuation.js';
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

export function makeContext(overrides = {}, seed = 42) {
  const raw = makeListone(seed);
  const settings = { ...defaultSettings(), ...overrides };
  for (const role of ROLES) {
    const labels = [...new Set(raw.filter((p) => p.role === role).map((p) => p.tier))];
    settings.tierOrder[role] = sortTierLabels(labels);
  }
  const players = withExpectedPrices(valuePlayers(raw, settings), settings);
  return { players, settings };
}
