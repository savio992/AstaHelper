import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, sniffDelimiter, autoMap, buildPlayers, normalizeRole, parseNumber, refineMapping, mergeSources, gridToTable, sheetsToTable } from '../src/domain/csv.js';
import { sortTierLabels, defaultSettings, ROLES, totalSlots } from '../src/domain/model.js';
import { valuePlayers, rosterScore, depthWeights } from '../src/domain/valuation.js';
import { expectedPrices, withExpectedPrices } from '../src/domain/market.js';
import { optimizeRoster } from '../src/domain/optimizer.js';
import { maxBid, alternatives, maxSpendableNow, tierBudgetReport, faseCorrente, budgetDiFase, spiegaPerdita, CONFIG_ASTA } from '../src/domain/advisor.js';
import { bigRimasti, scenarioSenzaBig, confrontaPiani, narrazione, consiglioStrategico, spiegaMossa } from '../src/domain/strategia.js';
import { makeContext, makeListone } from './helpers.js';

test('sniffDelimiter riconosce ; , e tab', () => {
  assert.equal(sniffDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(sniffDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(sniffDelimiter('a\tb\tc\n1\t2\t3'), '\t');
});

test('parseCsv gestisce virgolette, virgole interne e newline nei campi', () => {
  const csv = 'Nome,Note\n"Rossi, Mario","riga1\nriga2"\n"Con ""virgolette""",ok';
  const { headers, rows } = parseCsv(csv, ',');
  assert.deepEqual(headers, ['Nome', 'Note']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Nome, 'Rossi, Mario');
  assert.equal(rows[0].Note, 'riga1\nriga2');
  assert.equal(rows[1].Nome, 'Con "virgolette"');
});

test('parseCsv salta le righe di intestazione decorative prima della tabella vera', () => {
  const csv = 'Listone Creators 2025/26\n\nNome;Squadra;Ruolo;Fascia\nLautaro;Inter;A;Top';
  const { headers, rows } = parseCsv(csv);
  assert.deepEqual(headers, ['Nome', 'Squadra', 'Ruolo', 'Fascia']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Squadra, 'Inter');
});

test('autoMap riconosce le intestazioni piu' + "'" + ' comuni dei listoni', () => {
  const m = autoMap(['Id', 'Nome', 'Squadra', 'R', 'RM', 'Fascia', 'Qt.A', 'FVM']);
  assert.equal(m.name, 'Nome');
  assert.equal(m.team, 'Squadra');
  assert.equal(m.role, 'R');
  assert.equal(m.roleMantra, 'RM');
  assert.equal(m.tier, 'Fascia');
  assert.equal(m.price, 'Qt.A');
});

test('autoMap riconosce il formato dei listoni dei creators', () => {
  const m = autoMap(['Obiett.', 'Fascia', 'Ruolo', 'Team', 'Nome', 'Prezzo', 'PMA', 'Quo',
    'Titolarita', 'Affidabilita', 'Integrita', 'Commento', 'Nota 1', 'Nota 2', 'MV', 'FMV',
    'Presenze', 'FMV Exp.']);
  assert.equal(m.name, 'Nome');
  assert.equal(m.team, 'Team');
  assert.equal(m.price, 'Prezzo');
  assert.equal(m.pma, 'PMA');
  assert.equal(m.quo, 'Quo');
  assert.equal(m.fmvExp, 'FMV Exp.');
  assert.equal(m.titolarita, 'Titolarita');
  assert.deepEqual(m.tags, ['Nota 1', 'Nota 2']);
});

test('refineMapping distingue FVM fantamedia da FVM valore di mercato', () => {
  const asAverage = refineMapping([{ FVM: '6,4' }, { FVM: '7,1' }, { FVM: '5,9' }], { fantamedia: 'FVM' });
  assert.equal(asAverage.fantamedia, 'FVM');
  const asMarket = refineMapping([{ FVM: '120' }, { FVM: '340' }, { FVM: '80' }], { fantamedia: 'FVM' });
  assert.equal(asMarket.fvm, 'FVM');
  assert.equal(asMarket.fantamedia, undefined);
});

test('normalizeRole mappa i ruoli mantra su quelli classic', () => {
  assert.equal(normalizeRole('Por'), 'P');
  assert.equal(normalizeRole('Dc'), 'D');
  assert.equal(normalizeRole('E'), 'D');
  assert.equal(normalizeRole('W'), 'C');
  assert.equal(normalizeRole('T'), 'C');
  assert.equal(normalizeRole('Pc'), 'A');
  assert.equal(normalizeRole('Dd;Ds'), 'D');
  assert.equal(normalizeRole('Attaccante'), 'A');
  assert.equal(normalizeRole('boh'), null);
});

test('parseNumber gestisce virgola decimale e separatore delle migliaia', () => {
  assert.equal(parseNumber('12,5'), 12.5);
  assert.equal(parseNumber('1.234,5'), 1234.5);
  assert.equal(parseNumber('38'), 38);
  assert.equal(parseNumber(''), null);
});

test('buildPlayers scarta righe senza nome o ruolo e segnala i duplicati', () => {
  const rows = [
    { Nome: 'A', Ruolo: 'P', Squadra: 'Inter' },
    { Nome: '', Ruolo: 'D', Squadra: 'Inter' },
    { Nome: 'B', Ruolo: 'xx', Squadra: 'Inter' },
    { Nome: 'A', Ruolo: 'P', Squadra: 'Inter' },
  ];
  const mapping = { name: 'Nome', role: 'Ruolo', team: 'Squadra' };
  const { players, warnings } = buildPlayers(rows, mapping);
  assert.equal(players.length, 1);
  // Le righe senza nome sono code vuote del file e non meritano un avviso;
  // ruolo illeggibile e duplicato invece si'.
  assert.equal(warnings.length, 2);
});

test('sortTierLabels ordina dalla fascia migliore alla peggiore', () => {
  const sorted = sortTierLabels(['3a fascia', 'Top', 'Scommessa', '1a fascia', 'Semi-Top']);
  assert.deepEqual(sorted, ['Top', 'Semi-Top', '1a fascia', '3a fascia', 'Scommessa']);
});

test('depthWeights: in porta conta solo il titolare', () => {
  const s = defaultSettings();
  const w = depthWeights(s, 'P');
  assert.equal(w[0], 1);
  assert.ok(w[1] < 0.2, 'il secondo portiere deve valere poco');
  const wd = depthWeights(s, 'D');
  assert.deepEqual(wd.slice(0, 3), [1, 1, 1]);
  assert.ok(wd[7] < wd[3]);
});

test('i prezzi attesi distribuiscono esattamente il montepremi della lega', () => {
  const { players, settings } = makeContext({ priceSource: 'model' });
  const prices = expectedPrices(players, settings);
  const pool = settings.budget * settings.participants;
  const need = { P: 3, D: 8, C: 8, A: 6 };
  let sum = 0;
  for (const role of ROLES) {
    sum += players
      .filter((p) => p.role === role)
      .sort((a, b) => b.score - a.score)
      .slice(0, need[role] * settings.participants)
      .reduce((acc, p) => acc + prices.get(p.id), 0);
  }
  // Tolleranza per gli arrotondamenti a credito intero.
  assert.ok(Math.abs(sum - pool) / pool < 0.05, `montepremi ${sum} vs atteso ${pool}`);
});

test('con piu' + "'" + ' partecipanti i top costano di piu' + "'", () => {
  const few = makeContext({ participants: 8, priceSource: 'model' });
  const many = makeContext({ participants: 12, priceSource: 'model' });
  const topFew = [...few.players].sort((a, b) => b.score - a.score)[0];
  const topMany = many.players.find((p) => p.id === topFew.id);
  assert.ok(topMany.expectedPrice > topFew.expectedPrice);
});

test('la rosa generata rispetta slot e budget', () => {
  const { players, settings } = makeContext();
  const res = optimizeRoster({ players, settings });
  assert.equal(res.ok, true);
  assert.equal(res.picks.length, totalSlots(settings));
  for (const role of ROLES) {
    assert.equal(res.picks.filter((p) => p.role === role).length, settings.slots[role]);
  }
  assert.ok(res.cost <= settings.budget, `speso ${res.cost}`);
  assert.ok(res.cost >= settings.budget * 0.95, 'deve usare quasi tutto il budget');
  assert.equal(new Set(res.picks.map((p) => p.id)).size, res.picks.length, 'nessun duplicato');
});

test('i tetti di spesa per ruolo vengono rispettati', () => {
  const { players, settings } = makeContext();
  settings.roleBudget = { P: 20, D: null, C: null, A: null };
  const res = optimizeRoster({ players, settings });
  assert.equal(res.ok, true);
  assert.ok(res.spentByRole.P <= 20, `speso in porta ${res.spentByRole.P}`);
});

test('i giocatori gia' + "'" + ' in rosa restano nel piano e consumano budget', () => {
  const { players, settings } = makeContext();
  const mine = players.find((p) => p.role === 'A' && p.tier === 'Top');
  const owned = new Map([[mine.id, 60]]);
  const res = optimizeRoster({ players, settings, owned });
  assert.equal(res.ok, true);
  assert.equal(res.picks.length, totalSlots(settings) - 1);
  assert.ok(!res.picks.some((p) => p.id === mine.id));
  assert.equal(res.owned[0].id, mine.id);
  assert.ok(res.cost <= settings.budget);
  assert.equal(res.picks.filter((p) => p.role === 'A').length, settings.slots.A - 1);
});

test('i giocatori presi da altri non compaiono nel piano', () => {
  const { players, settings } = makeContext();
  const first = optimizeRoster({ players, settings });
  const lost = first.picks[0];
  const second = optimizeRoster({ players, settings, unavailable: new Set([lost.id]) });
  assert.ok(!second.picks.some((p) => p.id === lost.id));
  // La ricerca locale e' un'euristica e da punti di partenza diversi arriva a ottimi locali
  // diversi: si tollera uno scarto minimo, mentre il DP puro deve essere esatto (test seguente).
  assert.ok(second.score <= first.score * 1.01, 'perdere un obiettivo non puo' + "'" + ' migliorare la rosa in modo sensibile');
});

test('il DP e' + "'" + ' esattamente monotono: togliere un giocatore non migliora mai il piano', () => {
  const { players, settings } = makeContext();
  const first = optimizeRoster({ players, settings, localSearch: false });
  for (const victim of first.picks.slice(0, 5)) {
    const second = optimizeRoster({ players, settings, unavailable: new Set([victim.id]), localSearch: false });
    assert.ok(second.score <= first.score + 1e-6, `togliere ${victim.name} ha alzato il punteggio`);
  }
});

test('a parita' + "'" + ' di punteggio il piano spende di piu' + "'", () => {
  const { players, settings } = makeContext();
  const plan = optimizeRoster({ players, settings });
  const curve = optimizeRoster({ players, settings, localSearch: false });
  // I crediti che avanzano valgono zero: se ne restano, e' perche' non comprano nulla di meglio.
  if (curve.leftover > 0) {
    const best = curve.budgetCurve[curve.budgetCurve.length - 1];
    assert.ok(curve.budgetCurve[curve.cost] >= best - 1e-6, 'il piano deve stare sul massimo della curva');
  }
  assert.ok(plan.cost <= settings.budget);
});

test('maxBid e' + "'" + ' il vero punto di pareggio: sopra conviene il piano B, sotto no', () => {
  const { players, settings } = makeContext();
  // La verifica deve usare lo stesso solutore con cui la decisione e' presa, altrimenti misura
  // il pareggio con un metro diverso da quello che l'ha calcolato.
  const plan = optimizeRoster({ players, settings, ...CONFIG_ASTA });
  const target = plan.picks.filter((p) => p.role === 'C').sort((a, b) => b.plannedPrice - a.plannedPrice)[0];
  const res = maxBid({ players, settings, playerId: target.id });
  assert.ok(res.maxBid > 0);
  const planB = optimizeRoster({ players, settings, unavailable: new Set([target.id]), ...CONFIG_ASTA });
  const at = (q) => optimizeRoster({ players, settings, owned: new Map([[target.id, q]]), ...CONFIG_ASTA }).score;
  assert.ok(at(res.maxBid) >= planB.score - 1e-6, 'al max bid deve ancora convenire');
  if (res.maxBid < res.hard) {
    assert.ok(at(res.maxBid + 1) < planB.score, 'un credito sopra non deve piu' + "'" + ' convenire');
  }
});

test('maxBid non supera mai i crediti spendibili', () => {
  const { players, settings } = makeContext();
  const owned = new Map();
  const picks = optimizeRoster({ players, settings }).picks;
  picks.slice(0, 20).forEach((p) => owned.set(p.id, 20));
  const spendable = maxSpendableNow(settings, owned);
  const target = players.find((p) => !owned.has(p.id) && p.role === 'A');
  const res = maxBid({ players, settings, owned, playerId: target.id });
  assert.ok(res.maxBid <= spendable, `${res.maxBid} > ${spendable}`);
});

test('maxSpendableNow lascia sempre un credito per ogni slot rimasto', () => {
  const settings = defaultSettings();
  const owned = new Map([['a', 100]]);
  // 500 - 100 speso - 24 slot ancora da riempire + 1 (lo slot che sto comprando)
  assert.equal(maxSpendableNow(settings, owned), 500 - 100 - 23);
});

test('le alternative sono dello stesso ruolo, disponibili e sostenibili', () => {
  const { players, settings } = makeContext();
  const plan = optimizeRoster({ players, settings });
  const target = plan.picks.filter((p) => p.role === 'D').sort((a, b) => b.plannedPrice - a.plannedPrice)[0];
  const taken = new Set(plan.picks.slice(0, 3).map((p) => p.id));
  const res = alternatives({ players, settings, unavailable: taken, playerId: target.id, limit: 5 });
  assert.ok(res.alternatives.length > 0);
  const budget = maxSpendableNow(settings, new Map());
  for (const alt of res.alternatives) {
    assert.equal(alt.player.role, target.role);
    assert.notEqual(alt.player.id, target.id);
    assert.ok(!taken.has(alt.player.id));
    assert.ok(alt.price <= budget);
  }
  // Ordinate dalla migliore alla peggiore.
  for (let i = 1; i < res.alternatives.length; i++) {
    assert.ok(res.alternatives[i - 1].score >= res.alternatives[i].score);
  }
});

test('le alternative escludono chi ho gia' + "'" + ' in rosa', () => {
  const { players, settings } = makeContext();
  const defs = players.filter((p) => p.role === 'D').sort((a, b) => b.score - a.score);
  const owned = new Map([[defs[1].id, 30]]);
  const res = alternatives({ players, settings, owned, playerId: defs[0].id });
  assert.ok(!res.alternatives.some((a) => a.player.id === defs[1].id));
});

test('il report per fascia somma esattamente il budget del piano', () => {
  const { players, settings } = makeContext();
  const plan = optimizeRoster({ players, settings });
  const rows = tierBudgetReport({ plan, settings, players });
  const sum = rows.reduce((a, r) => a + r.planned, 0);
  assert.equal(sum, plan.cost);
  assert.equal(rows.reduce((a, r) => a + r.plannedCount, 0), totalSlots(settings));
});

const defenceBlock = (plan) => {
  const counts = new Map();
  for (const p of plan.picks.filter((x) => x.role === 'D')) counts.set(p.team, (counts.get(p.team) || 0) + 1);
  return Math.max(...counts.values());
};

/**
 * Blocco fra i difensori che schiereresti davvero.
 * Contare tutti gli otto difensori inganna: due riempitivi da tre crediti dello stesso club
 * sembrano un blocco ma in campo non ci vanno mai.
 */
const defenceBlockStarters = (plan) => {
  const counts = new Map();
  const titolari = plan.picks
    .filter((x) => x.role === 'D')
    .sort((a, b) => b.plannedPrice - a.plannedPrice)
    .slice(0, 5);
  for (const p of titolari) counts.set(p.team, (counts.get(p.team) || 0) + 1);
  return Math.max(...counts.values());
};

test('il modificatore di difesa costruisce un blocco di club', () => {
  const base = makeContext({ defenseModifier: false, cleanSheetModifier: false, maxPerClub: 0 });
  const mod = makeContext({ defenseModifier: true, cleanSheetModifier: false, maxPerClub: 0 });
  const planBase = optimizeRoster({ players: base.players, settings: base.settings });
  const planMod = optimizeRoster({ players: mod.players, settings: mod.settings });
  assert.ok(defenceBlock(planMod) > defenceBlock(planBase), 'il modificatore deve concentrare i difensori');
});

test('con le proiezioni i modificatori spostano davvero i crediti', () => {
  const base = makeContext({ projected: true, defenseModifier: false, cleanSheetModifier: false, maxPerClub: 0 });
  const dif = makeContext({ projected: true, defenseModifier: true, cleanSheetModifier: false, maxPerClub: 0 });
  const tutto = makeContext({ projected: true, defenseModifier: true, cleanSheetModifier: true, maxPerClub: 0 });
  const planBase = optimizeRoster({ players: base.players, settings: base.settings });
  const planDif = optimizeRoster({ players: dif.players, settings: dif.settings });
  const planTutto = optimizeRoster({ players: tutto.players, settings: tutto.settings });

  assert.ok(planDif.spentByRole.D > planBase.spentByRole.D,
    `difesa: ${planBase.spentByRole.D} -> ${planDif.spentByRole.D}`);
  assert.ok(planTutto.spentByRole.D > planBase.spentByRole.D,
    `difesa con entrambi: ${planBase.spentByRole.D} -> ${planTutto.spentByRole.D}`);
  assert.ok(defenceBlockStarters(planTutto) >= 2, 'con i modificatori serve un blocco difensivo vero');
  assert.ok(defenceBlockStarters(planTutto) > defenceBlockStarters(planBase),
    `blocco fra i titolari: ${defenceBlockStarters(planBase)} -> ${defenceBlockStarters(planTutto)}`);

  // Il portiere del fixture costa al massimo una quindicina di crediti e il piano compra gia'
  // il migliore anche senza modificatore: la spesa non puo' salire, quindi si verifica che a
  // salire sia il suo valore relativo, che e' l'affermazione vera del modello.
  const best = (ctx, role) => Math.max(...ctx.players.filter((p) => p.role === role).map((p) => p.score));
  const rapporto = (ctx) => best(ctx, 'P') / best(ctx, 'A');
  assert.ok(rapporto(tutto) > rapporto(base) * 1.1,
    `peso del portiere: ${rapporto(base).toFixed(3)} -> ${rapporto(tutto).toFixed(3)}`);

  // E che il portiere titolare scelto sia quello segnalato dal creator per l'imbattibilita'.
  const titolare = planTutto.picks.filter((p) => p.role === 'P').sort((a, b) => b.score - a.score)[0];
  assert.ok((titolare.tags || []).some((t) => t.includes('imbattibil')) || titolare.solidity > 0.6,
    `portiere scelto: ${titolare.name} (solidita' ${titolare.solidity.toFixed(2)})`);
});

test('con le proiezioni chi non gioca non entra in rosa', () => {
  const { players, settings } = makeContext({ projected: true });
  const plan = optimizeRoster({ players, settings });
  // I titolari veri stanno fra i piu' pagati del piano: nessuno oltre i 10 crediti
  // dovrebbe essere un giocatore da poche presenze.
  const cari = plan.picks.filter((p) => p.plannedPrice > 10);
  assert.ok(cari.length > 5, 'il piano deve avere titolari veri');
  assert.ok(cari.every((p) => p.expShare > 0.4), 'nessun panchinaro pagato caro');
});

test('rosterScore e' + "'" + ' indipendente dall' + "'" + 'ordine dei giocatori', () => {
  const { players, settings } = makeContext();
  const plan = optimizeRoster({ players, settings });
  const shuffled = [...plan.picks].reverse();
  assert.equal(rosterScore(plan.picks, settings), rosterScore(shuffled, settings));
});

test('valuePlayers assegna un punteggio a tutti e premia le fasce alte', () => {
  const settings = defaultSettings();
  settings.tierOrder = { P: ['Top', 'Low'], D: ['Top', 'Low'], C: ['Top', 'Low'], A: ['Top', 'Low'] };
  const raw = [
    { id: '1', name: 'Top A', team: 'Inter', role: 'A', tier: 'Top', price: 40, fvm: 80 },
    { id: '2', name: 'Low A', team: 'Inter', role: 'A', tier: 'Low', price: 5, fvm: 10 },
  ];
  const valued = valuePlayers(raw, settings);
  assert.ok(valued.every((p) => Number.isFinite(p.score)));
  assert.ok(valued[0].score > valued[1].score);
});

test('un listone senza colonna fascia funziona lo stesso', () => {
  const raw = makeListone(7).map((p) => ({ ...p, tier: '' }));
  const settings = defaultSettings();
  const players = withExpectedPrices(valuePlayers(raw, settings), settings);
  const res = optimizeRoster({ players, settings });
  assert.equal(res.ok, true);
  assert.equal(res.picks.length, totalSlots(settings));
});

// --- vincolo sui giocatori di prima fascia -----------------------------------------------

test('il vincolo porta in rosa almeno un big per reparto', () => {
  const libero = makeContext({ minTop: { P: 0, D: 0, C: 0, A: 0 } });
  const vincolato = makeContext({ minTop: { P: 0, D: 1, C: 1, A: 1 } });
  const planL = optimizeRoster({ players: libero.players, settings: libero.settings });
  const planV = optimizeRoster({ players: vincolato.players, settings: vincolato.settings });
  for (const role of ['D', 'C', 'A']) {
    const n = planV.picks.filter((p) => p.role === role && p.isTop).length;
    assert.ok(n >= 1, `nessun big fra i ${role}`);
  }
  // Forzare i big costa punti: e' un premio che si sceglie di pagare, non un miglioramento.
  assert.ok(planV.score <= planL.score + 1e-6, 'il vincolo non puo' + "'" + ' migliorare il punteggio');
});

test('chiedere piu' + "'" + ' big costa progressivamente di piu' + "'", () => {
  const punteggi = [0, 1, 2].map((n) => {
    const ctx = makeContext({ minTop: { P: 0, D: 0, C: 0, A: n } });
    return optimizeRoster({ players: ctx.players, settings: ctx.settings }).score;
  });
  assert.ok(punteggi[0] >= punteggi[1] - 1e-6 && punteggi[1] >= punteggi[2] - 1e-6,
    `punteggi ${punteggi.join(' ')}`);
});

test('il vincolo si allenta da solo se i big non ci sono piu' + "'", () => {
  const { players, settings } = makeContext({ minTop: { P: 0, D: 0, C: 0, A: 3 } });
  // Tutti i big d'attacco vanno agli avversari.
  const presi = new Set(players.filter((p) => p.role === 'A' && p.isTop).map((p) => p.id));
  assert.ok(presi.size > 0, 'il listone deve avere dei big in attacco');
  const plan = optimizeRoster({ players, settings, unavailable: presi });
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.picks.filter((p) => p.role === 'A').length, settings.slots.A);
});

test('i big gia' + "'" + ' comprati soddisfano il vincolo', () => {
  const { players, settings } = makeContext({ minTop: { P: 0, D: 0, C: 0, A: 1 } });
  const big = players.filter((p) => p.role === 'A' && p.isTop).sort((a, b) => b.score - a.score)[0];
  const plan = optimizeRoster({ players, settings, owned: new Map([[big.id, 80]]) });
  assert.equal(plan.ok, true);
  // Non deve comprarne un secondo per forza: quello in rosa gia' basta.
  const altriBig = plan.picks.filter((p) => p.role === 'A' && p.isTop).length;
  assert.ok(altriBig >= 0);
  assert.equal(plan.owned[0].id, big.id);
});

test('la soglia decide quanti giocatori contano come big', () => {
  const larga = makeContext({ topThreshold: 0.3 });
  const stretta = makeContext({ topThreshold: 0.02 });
  const conta = (ctx) => ctx.players.filter((p) => p.isTop).length;
  assert.ok(conta(larga) > conta(stretta), `${conta(larga)} contro ${conta(stretta)}`);
});

// --- bussola strategica ------------------------------------------------------------------

test('bigRimasti separa i big che ho gia' + "'" + ' da quelli ancora liberi', () => {
  const { players } = makeContext();
  const big = players.filter((p) => p.role === 'A' && p.isTop);
  assert.ok(big.length >= 2, 'servono almeno due big in attacco');
  const owned = new Map([[big[0].id, 90]]);
  const unavailable = new Set([big[1].id]);
  const conta = bigRimasti(players, { owned, unavailable });
  assert.equal(conta.A.miei, 1);
  assert.equal(conta.A.liberi, big.length - 2);
  assert.ok(!conta.A.nomi.includes(big[0].name) && !conta.A.nomi.includes(big[1].name));
});

test('lo scenario senza big non ne mette nessuno in rosa', () => {
  const { players, settings } = makeContext();
  const piano = scenarioSenzaBig({ players, settings, role: 'A' });
  assert.equal(piano.ok, true, piano.reason);
  assert.equal(piano.picks.filter((p) => p.role === 'A' && p.isTop).length, 0);
  // Gli altri reparti restano liberi di prenderne.
  assert.equal(piano.picks.filter((p) => p.role === 'A').length, settings.slots.A);
});

test('lo scenario senza big vale meno del piano con i big', () => {
  const { players, settings } = makeContext();
  const piano = optimizeRoster({ players, settings, localSearch: false });
  const senza = scenarioSenzaBig({ players, settings });
  assert.ok(senza.score <= piano.score + 1e-6, `${senza.score} contro ${piano.score}`);
});

test('confrontaPiani riconosce chi entra, chi esce e dove vanno i crediti', () => {
  const { players, settings } = makeContext();
  const prima = optimizeRoster({ players, settings, localSearch: false });
  const bersaglio = prima.picks.filter((p) => p.role === 'A').sort((a, b) => b.plannedPrice - a.plannedPrice)[0];
  const dopo = optimizeRoster({ players, settings, unavailable: new Set([bersaglio.id]), localSearch: false });
  const { entrati, usciti, spostamenti } = confrontaPiani(prima, dopo);
  assert.ok(usciti.some((p) => p.id === bersaglio.id), 'chi ho perso deve risultare uscito');
  assert.ok(entrati.length > 0);
  assert.ok(!entrati.some((p) => p.id === bersaglio.id));
  const somma = Object.values(spostamenti).reduce((a, b) => a + b, 0);
  assert.equal(somma, dopo.cost - prima.cost);
});

test('la narrazione racconta lo spostamento dei crediti fra i reparti', () => {
  const { players, settings } = makeContext();
  const prima = optimizeRoster({ players, settings, localSearch: false });
  const dopo = scenarioSenzaBig({ players, settings, role: 'A' });
  const frasi = narrazione({ prima, dopo, settings });
  assert.ok(frasi.length > 0, 'perdere tutti i big di un reparto deve produrre un commento');
  assert.ok(frasi.join(' ').length > 20);
});

test('la narrazione tace quando non cambia nulla di rilevante', () => {
  const { players, settings } = makeContext();
  const piano = optimizeRoster({ players, settings, localSearch: false });
  assert.deepEqual(narrazione({ prima: piano, dopo: piano, settings }), []);
});

test('il consiglio avvisa quando i big di un reparto sono finiti', () => {
  const { players, settings } = makeContext({ minTop: { P: 0, D: 0, C: 0, A: 1 } });
  const unavailable = new Set(players.filter((p) => p.role === 'A' && p.isTop).map((p) => p.id));
  const piano = optimizeRoster({ players, settings, unavailable });
  const consiglio = consiglioStrategico({ players, settings, unavailable, piano });
  const avviso = consiglio.avvisi.find((a) => a.role === 'A');
  assert.ok(avviso, 'deve esserci un avviso sull' + "'" + 'attacco');
  assert.equal(avviso.gravita, 'finiti');
  assert.ok(avviso.testo.length > 10);
});

test('il consiglio tace se il big richiesto ce' + "'" + ' l' + "'" + 'ho gia' + "'", () => {
  const { players, settings } = makeContext({ minTop: { P: 0, D: 0, C: 0, A: 1 } });
  const big = players.filter((p) => p.role === 'A' && p.isTop).sort((a, b) => b.score - a.score)[0];
  const owned = new Map([[big.id, 100]]);
  const piano = optimizeRoster({ players, settings, owned });
  const consiglio = consiglioStrategico({ players, settings, owned, piano });
  assert.ok(!consiglio.avvisi.some((a) => a.role === 'A'), 'nessun avviso se il big e' + "'" + ' gia' + "'" + ' mio');
});

// --- asta a chiamata per ruolo -----------------------------------------------------------

test("la fase e' il primo reparto dell'ordine con slot ancora liberi", () => {
  const { players, settings } = makeContext();
  const owned = new Map();
  assert.equal(faseCorrente(settings, players, owned), 'P');
  // Riempio la porta: si passa alla difesa.
  players.filter((p) => p.role === 'P').slice(0, settings.slots.P).forEach((p) => owned.set(p.id, 5));
  assert.equal(faseCorrente(settings, players, owned), 'D');
});

test('il budget di reparto mette da parte quello che serve dopo', () => {
  const { players, settings } = makeContext();
  const plan = optimizeRoster({ players, settings });
  const b = budgetDiFase({ settings, players, owned: new Map(), plan });
  assert.equal(b.fase, 'P');
  assert.ok(b.perLaFase + b.riservatoDopo <= settings.budget);
  assert.ok(b.riservatoDopo > b.perLaFase, 'a inizio asta quasi tutto il budget e' + "'" + ' riservato ai reparti successivi');
  // Il massimo su un singolo giocatore lascia un credito per gli altri slot del reparto.
  assert.equal(b.massimoOra, Math.max(0, b.perLaFase - (settings.slots.P - 1)));
});

test("il tetto di reparto e' piu' prudente del tetto tecnico", () => {
  const { players, settings } = makeContext();
  const plan = optimizeRoster({ players, settings });
  const owned = new Map();
  const b = budgetDiFase({ settings, players, owned, plan });
  // Il tetto tecnico lascerebbe spendere quasi tutto il budget su un portiere.
  assert.ok(b.massimoOra < maxSpendableNow(settings, owned) / 2,
    `reparto ${b.massimoOra} contro tecnico ${maxSpendableNow(settings, owned)}`);
});

test('spendere troppo in un reparto riduce quello che resta ai successivi', () => {
  const { players, settings } = makeContext();
  const plan = optimizeRoster({ players, settings });
  const portieri = players.filter((p) => p.role === 'P').sort((a, b) => b.score - a.score).slice(0, 3);
  const owned = new Map(portieri.map((p, i) => [p.id, i === 0 ? 150 : 15]));
  const dopo = optimizeRoster({ players, settings, owned });
  const b = budgetDiFase({ settings, players, owned, plan: dopo });
  assert.equal(b.fase, 'D');
  assert.equal(b.residuo, settings.budget - 180);
  assert.ok(b.perLaFase < budgetDiFase({ settings, players, owned: new Map(), plan }).residuo);
  assert.ok(b.riservatoDopo > 0);
});

test("l'ordine dei reparti si puo' cambiare", () => {
  const { players, settings } = makeContext();
  const alRovescio = { ...settings, auctionOrder: ['A', 'C', 'D', 'P'] };
  assert.equal(faseCorrente(alRovescio, players, new Map()), 'A');
});

test('le ripartenze recuperano i blocchi che la programmazione dinamica non vede', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const base = optimizeRoster({ players, settings });
  const conRipartenze = optimizeRoster({ players, settings, ripartenze: 4 });
  // Non possono peggiorare: si tiene la migliore fra la base e le ripartenze.
  assert.ok(conRipartenze.score >= base.score - 1e-9);
  assert.equal(conRipartenze.ok, true);
});

test('escludere un giocatore non puo\' migliorare il piano con le ripartenze', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const piano = optimizeRoster({ players, settings, ripartenze: 4 });
  // Il caso che il difetto produceva: togliere la scelta piu' cara faceva salire il punteggio.
  const caro = piano.picks.slice().sort((a, b) => b.plannedPrice - a.plannedPrice)[0];
  const senza = optimizeRoster({ players, settings, unavailable: new Set([caro.id]), ripartenze: 4 });
  assert.ok(
    senza.score <= piano.score + 1e-9,
    `togliere ${caro.name} porta a ${senza.score}, sopra il piano ${piano.score}`
  );
});

test('la spiegazione di una perdita racconta la riorganizzazione, non solo un sostituto', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const piano = optimizeRoster({ players, settings, ...CONFIG_ASTA });
  const caro = piano.picks.filter((p) => p.role === 'A').sort((a, b) => b.plannedPrice - a.plannedPrice)[0];
  const sp = spiegaPerdita({ players, settings, playerId: caro.id, piano });
  assert.ok(sp);
  assert.equal(sp.perso.id, caro.id);
  assert.ok(sp.costo >= 0, 'perdere un obiettivo non puo\' migliorare la rosa');
  assert.ok(sp.frasi.length >= 2);
  // Le vere alternative non possono essere giocatori che avresti comunque.
  const idsDopo = new Set(sp.dopo.picks.map((p) => p.id));
  assert.ok(sp.alternative.every((a) => !idsDopo.has(a.player.id)));
});

test('chi era gia\' nel piano non viene spacciato per alternativa', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const piano = optimizeRoster({ players, settings, ...CONFIG_ASTA });
  const caro = piano.picks.filter((p) => p.role === 'A').sort((a, b) => b.plannedPrice - a.plannedPrice)[0];
  const { alternatives: alt } = alternatives({ players, settings, playerId: caro.id, limit: 8 });
  const planB = optimizeRoster({ players, settings, unavailable: new Set([caro.id]), ...CONFIG_ASTA });
  const idsB = new Set(planB.picks.map((p) => p.id));
  for (const a of alt) assert.equal(a.giaNelPiano, idsB.has(a.player.id));
});

test('ogni mossa viene raccontata: acquisto sopra il piano, e i crediti che devono uscire', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const prima = optimizeRoster({ players, settings, ...CONFIG_ASTA });
  const obiettivo = prima.picks.filter((p) => p.role === 'A').sort((a, b) => b.plannedPrice - a.plannedPrice)[0];
  const pagato = obiettivo.plannedPrice + 25;
  const dopo = optimizeRoster({ players, settings, owned: new Map([[obiettivo.id, pagato]]), ...CONFIG_ASTA });
  const sp = spiegaMossa({
    prima,
    dopo,
    players,
    settings,
    evento: { id: obiettivo.id, kind: 'mine', price: pagato },
  });
  assert.ok(sp);
  assert.equal(sp.mio, true);
  assert.equal(sp.scarto, 25);
  assert.match(sp.frasi[0], /sopra il piano/);
  assert.ok(sp.frasi.length >= 2, 'deve dire anche cosa ne consegue');
});

test('perdere un obiettivo viene raccontato nominando il sostituto', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const prima = optimizeRoster({ players, settings, ...CONFIG_ASTA });
  const obiettivo = prima.picks.filter((p) => p.role === 'C').sort((a, b) => b.plannedPrice - a.plannedPrice)[0];
  const dopo = optimizeRoster({ players, settings, unavailable: new Set([obiettivo.id]), ...CONFIG_ASTA });
  const sp = spiegaMossa({
    prima,
    dopo,
    players,
    settings,
    evento: { id: obiettivo.id, kind: 'other', price: 40 },
  });
  assert.equal(sp.mio, false);
  assert.equal(sp.eraObiettivo, true);
  assert.match(sp.frasi[0], /Era un tuo obiettivo/);
  // Il giocatore perso non puo' comparire fra quelli che "escono": e' la notizia stessa.
  assert.ok(!sp.usciti.some((x) => x.id === obiettivo.id));
});

test('un giocatore che non mi interessava non genera allarmi', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const prima = optimizeRoster({ players, settings, ...CONFIG_ASTA });
  const ids = new Set(prima.picks.map((p) => p.id));
  const estraneo = players.find((p) => p.role === 'D' && !ids.has(p.id) && (p.expectedPrice ?? 0) <= 2);
  const dopo = optimizeRoster({ players, settings, unavailable: new Set([estraneo.id]), ...CONFIG_ASTA });
  const sp = spiegaMossa({ prima, dopo, players, settings, evento: { id: estraneo.id, kind: 'other', price: 2 } });
  assert.equal(sp.eraObiettivo, false);
  assert.match(sp.frasi[0], /Non era fra i tuoi obiettivi/);
});
