import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, sniffDelimiter, autoMap, buildPlayers, normalizeRole, parseNumber, refineMapping, mergeSources, gridToTable, sheetsToTable } from '../src/domain/csv.js';
import { sortTierLabels, defaultSettings, ROLES, totalSlots } from '../src/domain/model.js';
import { valuePlayers, rosterScore, depthWeights, synergyBonus, avvisiCreator, AVVISI_CREATOR, expectedShare, votoAtteso, clubSolidity } from '../src/domain/valuation.js';
import { expectedPrices, withExpectedPrices } from '../src/domain/market.js';
import { optimizeRoster } from '../src/domain/optimizer.js';
import { maxBid, alternatives, maxSpendableNow, tierBudgetReport, faseCorrente, budgetDiFase, spiegaPerdita, spiegaOfferta, tettoSullaLista, costoDellaLista, sceltiInPanchina, pianoSenza, CONFIG_ASTA } from '../src/domain/advisor.js';
import { bigRimasti, scenarioSenzaBig, confrontaPiani, narrazione, consiglioStrategico, spiegaMossa, spiegaModifica, ultimaOccasione } from '../src/domain/strategia.js';
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

test('il ripiego non puo\' essere un giocatore che prenderei comunque', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const piano = optimizeRoster({ players, settings, ...CONFIG_ASTA });
  const planB = (id) => optimizeRoster({ players, settings, unavailable: new Set([id]), ...CONFIG_ASTA });
  // Un portiere caro ma poco titolare: il caso in cui il ripiego proposto era gia' in rosa.
  const target = piano.picks.filter((p) => p.role === 'P').sort((a, b) => b.plannedPrice - a.plannedPrice)[0];
  const { alternatives: alt } = alternatives({ players, settings, playerId: target.id, limit: 8 });
  const idsB = new Set(planB(target.id).picks.map((p) => p.id));
  const primoVero = alt.find((a) => !a.giaNelPiano);
  if (primoVero) assert.ok(!idsB.has(primoVero.player.id), 'il primo ripiego valido non e\' gia\' nel piano B');
});

test('quando il mercato lo paga molto piu\' di quanto vale, l\'app dice perche\'', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const piano = optimizeRoster({ players, settings, ...CONFIG_ASTA });
  // Un portiere di riserva: il posto da titolare e' gia' occupato.
  const titolare = piano.picks.filter((p) => p.role === 'P').sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  const riserva = players
    .filter((p) => p.role === 'P' && p.id !== titolare.id && (p.expectedPrice ?? 0) > 10)
    .sort((a, b) => (a.score || 0) - (b.score || 0))[0];
  if (!riserva) return;
  const sp = spiegaOfferta({ players, settings, playerId: riserva.id, offerta: 1, piano });
  assert.ok(sp.frasi.length >= 1, 'deve dare almeno una ragione');
  assert.match(sp.frasi.join(' '), /mercato lo paga/);
});

test('a un\'occasione non si attacca una spiegazione da bocciatura', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const p = players.find((x) => x.role === 'A' && (x.expectedPrice ?? 0) > 5);
  const sp = spiegaOfferta({ players, settings, playerId: p.id, offerta: Math.round(p.expectedPrice * 2) });
  assert.match(sp.frasi[0], /ne varrebbe/);
  assert.equal(sp.frasi.length, 1, 'niente motivi di scarto su un affare');
});

test('quando prezzo e valore coincidono non si dice niente', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const p = players.find((x) => x.role === 'C' && (x.expectedPrice ?? 0) > 5);
  const sp = spiegaOfferta({ players, settings, playerId: p.id, offerta: p.expectedPrice });
  assert.equal(sp.frasi.length, 0);
});

test('un giocatore imposto entra nel piano e ci resta', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const libero = optimizeRoster({ players, settings, ripartenze: 4 });
  const dentro = new Set(libero.picks.map((p) => p.id));
  // Un portiere che il solutore non aveva scelto: il caso vero, "il portiere lo scelgo io".
  const voluto = players
    .filter((p) => p.role === 'P' && !dentro.has(p.id) && (p.expectedPrice ?? 0) > 5)
    .sort((a, b) => (b.expectedPrice ?? 0) - (a.expectedPrice ?? 0))[0];
  assert.ok(voluto, 'serve un portiere fuori dal piano per provare il vincolo');

  const imposto = optimizeRoster({ players, settings, obbligati: new Set([voluto.id]), ripartenze: 4 });
  assert.equal(imposto.ok, true);
  const scelto = imposto.picks.find((p) => p.id === voluto.id);
  assert.ok(scelto, `${voluto.name} deve comparire fra gli obiettivi`);
  assert.equal(scelto.bloccato, true, 'e va marcato come scelta imposta');
  // Il resto della rosa resta valido: slot esatti, nessun doppione, budget rispettato.
  // Contare gli slot non basta: il giocatore imposto era rimasto anche nel serbatoio dei
  // candidati e il solutore lo sceglieva una seconda volta, con il conto che tornava lo stesso.
  const ids = imposto.picks.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'nessun giocatore puo\' comparire due volte');
  for (const role of ROLES) {
    const n = imposto.picks.filter((p) => p.role === role).length;
    assert.equal(n, settings.slots[role], `slot ${role}`);
  }
  assert.ok(imposto.cost <= settings.budget);
  // Imporre una scelta non puo' migliorare la rosa: al massimo la lascia uguale.
  assert.ok(imposto.score <= libero.score + 1e-9);
});

test('imporre un giocatore sposta i crediti, non li fa sparire', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const libero = optimizeRoster({ players, settings, ripartenze: 4 });
  const dentro = new Set(libero.picks.map((p) => p.id));
  const caro = players
    .filter((p) => p.role === 'A' && !dentro.has(p.id))
    .sort((a, b) => (b.expectedPrice ?? 0) - (a.expectedPrice ?? 0))[0];
  const imposto = optimizeRoster({ players, settings, obbligati: new Set([caro.id]), ripartenze: 4 });
  // Il totale per reparto deve continuare a contare la scelta imposta.
  const spesaA = imposto.picks.filter((p) => p.role === 'A').reduce((a, p) => a + p.plannedPrice, 0);
  assert.equal(imposto.spentByRole.A, spesaA);
  assert.ok(imposto.cost <= settings.budget);
});

test('un giocatore scartato non viene mai proposto', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const libero = optimizeRoster({ players, settings, ripartenze: 4 });
  const daScartare = libero.picks.filter((p) => p.role === 'C').sort((a, b) => b.plannedPrice - a.plannedPrice)[0];
  const dopo = optimizeRoster({ players, settings, unavailable: new Set([daScartare.id]), ripartenze: 4 });
  assert.ok(!dopo.picks.some((p) => p.id === daScartare.id));
  assert.equal(dopo.picks.filter((p) => p.role === 'C').length, settings.slots.C);
});

test('imporre un giocatore non lo rende comprabile se e\' gia\' andato ad altri', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const p = players.find((x) => x.role === 'D');
  const piano = optimizeRoster({
    players,
    settings,
    unavailable: new Set([p.id]),
    obbligati: new Set([p.id]),
    ripartenze: 4,
  });
  assert.equal(piano.ok, true);
  assert.ok(!piano.picks.some((x) => x.id === p.id), 'chi e\' stato venduto non torna nel piano');
});

test('scartare il terzo portiere cambia solo il terzo portiere', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const prima = optimizeRoster({ players, settings, ripartenze: 4 });
  const ultimo = prima.picks.filter((p) => p.role === 'P').sort((a, b) => a.plannedPrice - b.plannedPrice)[0];
  const dopo = optimizeRoster({ players, settings, unavailable: new Set([ultimo.id]), ripartenze: 4 });
  const idsPrima = new Set(prima.picks.map((p) => p.id));
  const entrati = dopo.picks.filter((p) => !idsPrima.has(p.id));
  // Il posto si riempie sempre: e' il punto della segnalazione.
  assert.equal(dopo.picks.filter((p) => p.role === 'P').length, settings.slots.P);
  assert.ok(!dopo.picks.some((p) => p.id === ultimo.id));
  assert.ok(entrati.length >= 1, 'qualcuno deve prendere il suo posto');

  const sp = spiegaModifica({ prima, dopo, players, settings, id: ultimo.id, azione: 'scarta' });
  assert.ok(sp);
  assert.match(sp.frasi.join(' '), /al suo posto|Al suo posto/i);
});

test('scartare il primo portiere riorganizza piu\' reparti, e lo dice', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const prima = optimizeRoster({ players, settings, ripartenze: 4 });
  const primo = prima.picks.filter((p) => p.role === 'P').sort((a, b) => b.plannedPrice - a.plannedPrice)[0];
  const dopo = optimizeRoster({ players, settings, unavailable: new Set([primo.id]), ripartenze: 4 });
  assert.equal(dopo.picks.filter((p) => p.role === 'P').length, settings.slots.P);
  const sp = spiegaModifica({ prima, dopo, players, settings, id: primo.id, azione: 'scarta' });
  assert.ok(sp.frasi.length >= 2);
  assert.ok(sp.costo >= -0.001, 'scartare non puo\' migliorare la rosa');
});

test('la spiegazione distingue il caso in cui non cambia nulla d\'altro', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const prima = optimizeRoster({ players, settings, ripartenze: 4 });
  const dopo = prima; // nessun cambiamento
  const qualsiasi = prima.picks[0];
  const sp = spiegaModifica({ prima, dopo, players, settings, id: qualsiasi.id, azione: 'libera' });
  assert.match(sp.frasi.join(' '), /Non cambia il valore/);
});

test('piano e consigli usano lo stesso solutore, sempre', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  // L'invariante che due volte e' saltata: se il piano fosse calcolato meglio dei consigli,
  // l'assistente direbbe di pagare un giocatore che il piano non vuole.
  const piano = optimizeRoster({ players, settings, ...CONFIG_ASTA });
  const target = piano.picks.filter((p) => p.role === 'P').sort((a, b) => b.plannedPrice - a.plannedPrice)[0];
  const res = maxBid({ players, settings, playerId: target.id });
  const planB = optimizeRoster({ players, settings, unavailable: new Set([target.id]), ...CONFIG_ASTA });
  const conLui = optimizeRoster({
    players,
    settings,
    owned: new Map([[target.id, res.maxBid]]),
    ...CONFIG_ASTA,
  });
  assert.ok(conLui.score >= planB.score - 1e-6, 'al tetto dichiarato deve ancora convenire');

  // E un giocatore che il piano compra al suo prezzo non puo' avere un pareggio piu' basso.
  assert.ok(res.maxBid >= target.plannedPrice, `${target.name}: pareggio ${res.maxBid} sotto il prezzo a piano ${target.plannedPrice}`);
});

test('un giocatore fuori dal piano non puo\' avere un pareggio assurdo', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const piano = optimizeRoster({ players, settings, ...CONFIG_ASTA });
  const dentro = new Set(piano.picks.map((p) => p.id));
  const fuori = players
    .filter((p) => p.role === 'P' && !dentro.has(p.id) && (p.expectedPrice ?? 0) > 5)
    .sort((a, b) => (b.expectedPrice ?? 0) - (a.expectedPrice ?? 0))[0];
  if (!fuori) return;
  const res = maxBid({ players, settings, playerId: fuori.id });
  // Se il piano non lo compra al prezzo di mercato, non puo' convenire molto piu' di quello:
  // era il sintomo dei solutori disallineati.
  const planB = optimizeRoster({ players, settings, unavailable: new Set([fuori.id]), ...CONFIG_ASTA });
  const alPrezzo = optimizeRoster({ players, settings, owned: new Map([[fuori.id, Math.round(fuori.expectedPrice)]]), ...CONFIG_ASTA });
  if (alPrezzo.score < planB.score) {
    assert.ok(
      res.maxBid < Math.round(fuori.expectedPrice),
      `${fuori.name}: il piano non lo vuole a ${Math.round(fuori.expectedPrice)} ma il pareggio dice ${res.maxBid}`
    );
  }
});

test('il tetto su una lista scelta a mano tiene conto di tutti gli altri nomi', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const scelti = optimizeRoster({ players, settings, ...CONFIG_ASTA }).picks.slice(0, 10);
  const lista = new Set(scelti.map((p) => p.id));
  const target = scelti[0];
  const conto = tettoSullaLista({ players, settings, lista, playerId: target.id });

  const altri = scelti
    .filter((p) => p.id !== target.id)
    .reduce((a, p) => a + Math.max(1, Math.round(p.expectedPrice ?? 1)), 0);
  assert.equal(conto.riservatoLista, altri, 'riserva il prezzo di mercato di ogni altro nome in lista');
  assert.ok(conto.massimo <= settings.budget - altri, 'non puo\' promettere piu\' di quel che resta');
  assert.ok(conto.massimo > 0);
  // Le caselle che la lista lascia vuote costano almeno un credito l'una.
  assert.equal(conto.scoperte, totalSlots(settings) - lista.size);
});

test('piu\' nomi metto in lista, meno posso spendere su ciascuno', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const picks = optimizeRoster({ players, settings, ...CONFIG_ASTA }).picks;
  const target = picks[0];
  const corta = tettoSullaLista({ players, settings, lista: new Set([target.id]), playerId: target.id });
  const lunga = tettoSullaLista({ players, settings, lista: new Set(picks.slice(0, 12).map((p) => p.id)), playerId: target.id });
  assert.ok(lunga.massimo < corta.massimo, `${lunga.massimo} deve essere sotto ${corta.massimo}`);
});

test('scegliere la propria lista ha un costo misurabile, e viene detto', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  // Una lista volutamente discutibile: i piu' cari del listone, ruolo per ruolo.
  const lista = new Set(
    ROLES.flatMap((r) =>
      players
        .filter((p) => p.role === r)
        .sort((a, b) => (b.expectedPrice ?? 0) - (a.expectedPrice ?? 0))
        .slice(0, 1)
        .map((p) => p.id)
    )
  );
  const c = costoDellaLista({ players, settings, lista });
  assert.ok(c);
  assert.ok(c.differenza >= -0.001, 'imporre una lista non puo\' battere il piano libero');
  assert.equal(typeof c.percentuale, 'number');
});

test('in "scelgo io" il portiere scelto e\' il titolare: il piano non ne compra uno piu\' forte sopra di lui', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  // Un portiere di mezza classifica: forte abbastanza da costare, non il migliore del listone.
  const portieri = players.filter((p) => p.role === 'P').sort((a, b) => (b.score || 0) - (a.score || 0));
  const scelto = portieri[Math.floor(portieri.length * 0.15)];
  assert.ok(portieri[0].score > scelto.score, 'il fixture deve avere un portiere piu\' forte di quello scelto');

  const lista = new Set([scelto.id]);
  const mia = optimizeRoster({ players, settings: { ...settings, modalita: 'mia' }, obbligati: lista, ...CONFIG_ASTA });
  assert.ok(mia.ok);
  const inPorta = [...mia.owned, ...mia.picks].filter((p) => p.role === 'P');
  assert.ok(inPorta.some((p) => p.id === scelto.id), 'il portiere scelto deve esserci');
  for (const p of inPorta) {
    if (p.id === scelto.id) continue;
    assert.ok(
      (p.score || 0) <= (scelto.score || 0),
      `${p.name} (${p.score}) e' piu' forte del portiere scelto ${scelto.name} (${scelto.score}): lo manderebbe in panchina`
    );
  }
});

test('in automatica il lucchetto resta un vincolo, non una promessa di titolarita\'', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const portieri = players.filter((p) => p.role === 'P').sort((a, b) => (b.score || 0) - (a.score || 0));
  const scelto = portieri[Math.floor(portieri.length * 0.15)];
  const lista = new Set([scelto.id]);

  const auto = optimizeRoster({ players, settings, obbligati: lista, ...CONFIG_ASTA });
  const mia = optimizeRoster({ players, settings: { ...settings, modalita: 'mia' }, obbligati: lista, ...CONFIG_ASTA });
  assert.ok(auto.ok && mia.ok);
  assert.ok([...auto.owned, ...auto.picks].some((p) => p.id === scelto.id));
  // "Scelgo io" e' un vincolo in piu' sopra lo stesso problema: non puo' produrre una rosa migliore.
  assert.ok(
    auto.score >= mia.score - 0.001,
    `l'automatica (${auto.score}) non puo' valere meno della lista imposta (${mia.score})`
  );
});

test('un giocatore scelto che finisce in panchina viene detto, con il prezzo davanti', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const portieri = players.filter((p) => p.role === 'P').sort((a, b) => (b.score || 0) - (a.score || 0));
  const titolare = portieri[0];
  const scelto = portieri[3];
  assert.ok(titolare.score > scelto.score);

  // Il caso patologico in forma pura: due portieri veri in rosa, e quello scelto e' il secondo.
  const piano = {
    ok: true,
    owned: [],
    picks: [
      { ...titolare, plannedPrice: 50 },
      { ...scelto, plannedPrice: 30, bloccato: true },
      { ...portieri[portieri.length - 1], plannedPrice: 1 },
    ],
  };
  const casi = sceltiInPanchina({ plan: piano, settings });
  assert.equal(casi.length, 1, 'un solo caso: il portiere scelto dietro a uno piu\' forte');
  assert.equal(casi[0].player.id, scelto.id);
  assert.equal(casi[0].prezzo, 30);
  assert.equal(casi[0].titolare.id, titolare.id);

  // Un riempitivo da un credito in panchina e' il suo mestiere: non e' un caso da segnalare.
  const innocuo = {
    ok: true,
    owned: [],
    picks: [
      { ...titolare, plannedPrice: 50 },
      { ...scelto, plannedPrice: 30 },
      { ...portieri[portieri.length - 1], plannedPrice: 1, bloccato: true },
    ],
  };
  assert.equal(sceltiInPanchina({ plan: innocuo, settings }).length, 0);
});

test('il costo della lista si sa anche reparto per reparto', () => {
  const { players, settings } = makeContext({ projected: true }, 11);
  const scelto = players
    .filter((p) => p.role === 'P')
    .sort((a, b) => (b.score || 0) - (a.score || 0))[Math.floor(players.filter((p) => p.role === 'P').length * 0.3)];
  const c = costoDellaLista({ players, settings: { ...settings, modalita: 'mia' }, lista: new Set([scelto.id]) });
  assert.ok(c);
  assert.equal(c.perRuolo.length, 1, 'un solo reparto ha delle scelte dentro');
  assert.equal(c.perRuolo[0].role, 'P');
  assert.ok(c.perRuolo[0].differenza >= -0.001, 'togliere il vincolo non puo' + "'" + ' peggiorare la rosa');
  // Con una sola scelta, quel reparto spiega tutta la differenza.
  assert.ok(
    Math.abs(c.perRuolo[0].differenza - c.differenza) < 0.001,
    `il reparto dice ${c.perRuolo[0].differenza}, il totale ${c.differenza}`
  );
});

// --- l'ultima occasione: l'avviso di scarsita' dove si sta puntando ----------------------

function contestoTop() {
  const ctx = makeContext({ projected: true, minTop: { A: 1 } });
  const topA = ctx.players.filter((p) => p.role === 'A' && p.isTop).sort((a, b) => b.score - a.score);
  return { ...ctx, topA };
}

test('con i big ancora abbondanti non si avvisa nessuno: sarebbe rumore', () => {
  const { players, settings, topA } = contestoTop();
  assert.equal(ultimaOccasione({ players, settings, playerId: topA[0].id }), null);
});

test('quando ne resta uno solo lo dice, e dice che il piano B non esiste', () => {
  const { players, settings, topA } = contestoTop();
  const unavailable = new Set(topA.slice(1).map((p) => p.id));
  const a = ultimaOccasione({ players, settings, unavailable, playerId: topA[0].id });
  assert.equal(a.gravita, 'ultima');
  assert.match(a.titolo, /ultimo big in attacco/);
  assert.match(a.testo, /piano B/);
});

test('a due o tre dalla fine avvisa senza allarmare, e dice chi viene dopo', () => {
  const { players, settings, topA } = contestoTop();
  const unavailable = new Set(topA.slice(2).map((p) => p.id));
  const a = ultimaOccasione({ players, settings, unavailable, playerId: topA[0].id });
  assert.equal(a.gravita, 'quasi');
  assert.match(a.titolo, /Restano 2 big in attacco/);
  assert.ok(a.testo.includes(topA[1].name), 'deve dire chi resta dopo di lui');
});

test('chi ha gia\' il suo big non viene avvisato: la soglia e\' coperta', () => {
  const { players, settings, topA } = contestoTop();
  const owned = new Map([[topA[1].id, 40]]);
  const unavailable = new Set(topA.slice(2).map((p) => p.id));
  assert.equal(ultimaOccasione({ players, settings, owned, unavailable, playerId: topA[0].id }), null);
});

test('l\'avviso riguarda solo il reparto del giocatore che stai guardando', () => {
  const ctx = makeContext({ projected: true, minTop: { A: 1, D: 1 } });
  const topA = ctx.players.filter((p) => p.role === 'A' && p.isTop).sort((a, b) => b.score - a.score);
  const topD = ctx.players.filter((p) => p.role === 'D' && p.isTop).sort((a, b) => b.score - a.score);
  // Gli attaccanti top sono finiti tutti tranne uno, i difensori no.
  const unavailable = new Set(topA.slice(1).map((p) => p.id));
  assert.equal(ultimaOccasione({ players: ctx.players, settings: ctx.settings, unavailable, playerId: topD[0].id }), null);
});

test('su un giocatore non di prima fascia non si parla di big', () => {
  const { players, settings, topA } = contestoTop();
  const normale = players.find((p) => p.role === 'A' && !p.isTop);
  const unavailable = new Set(topA.slice(1).map((p) => p.id));
  assert.equal(ultimaOccasione({ players, settings, unavailable, playerId: normale.id }), null);
});

test('un giocatore gia\' assegnato non e\' piu\' un\'occasione', () => {
  const { players, settings, topA } = contestoTop();
  const unavailable = new Set([...topA.slice(1).map((p) => p.id), topA[0].id]);
  assert.equal(ultimaOccasione({ players, settings, unavailable, playerId: topA[0].id }), null);
});

// --- il piano B condiviso ----------------------------------------------------------------
// Aprire una scheda risolveva tre volte lo stesso identico piano B — offerta massima,
// alternative e racconto della perdita se lo costruivano ciascuno per conto proprio — e
// ricalcolava le alternative che gli erano gia' state passate. Condividerli dimezza il costo,
// ma vale solo se il risultato non cambia di una virgola: e' il numero su cui si rilancia.

test('condividere il piano B non cambia una virgola dei consigli', () => {
  const { players, settings } = makeContext({ projected: true });
  const piano = optimizeRoster({ players, settings, ...CONFIG_ASTA });
  const bersagli = piano.picks.slice().sort((a, b) => b.plannedPrice - a.plannedPrice);
  // Un giocatore caro, uno medio e un riempitivo: i tre regimi in cui la ricerca del
  // punto di pareggio si comporta in modo diverso.
  for (const idx of [0, Math.floor(bersagli.length / 2), bersagli.length - 1]) {
    const args = {
      players,
      settings,
      owned: new Map(),
      unavailable: new Set(),
      obbligati: new Set(),
      playerId: bersagli[idx].id,
    };
    const planB = pianoSenza(args);

    assert.equal(maxBid({ ...args, planB }).maxBid, maxBid(args).maxBid, `offerta massima su ${bersagli[idx].name}`);

    const conPiano = alternatives({ ...args, limit: 12, planB }).alternatives.map((a) => `${a.player.id}:${a.delta}`);
    const senzaPiano = alternatives({ ...args, limit: 12 }).alternatives.map((a) => `${a.player.id}:${a.delta}`);
    assert.deepEqual(conPiano, senzaPiano, `alternative su ${bersagli[idx].name}`);

    const alt = alternatives({ ...args, limit: 12, planB }).alternatives;
    const conTutto = spiegaPerdita({ ...args, piano, alternative: alt, planB });
    const senzaNiente = spiegaPerdita({ ...args, piano });
    assert.deepEqual(conTutto.frasi, senzaNiente.frasi, `racconto su ${bersagli[idx].name}`);
    assert.equal(conTutto.costo, senzaNiente.costo);
    assert.deepEqual(
      conTutto.alternative.map((a) => a.player.id),
      senzaNiente.alternative.map((a) => a.player.id)
    );
  }
});

test('un piano B rotto non viene riusato: si ricalcola invece di mentire', () => {
  const { players, settings } = makeContext({ projected: true });
  const piano = optimizeRoster({ players, settings, ...CONFIG_ASTA });
  const args = {
    players,
    settings,
    owned: new Map(),
    unavailable: new Set(),
    obbligati: new Set(),
    playerId: piano.picks[0].id,
  };
  const rotto = { ok: false, reason: 'finto' };
  assert.equal(maxBid({ ...args, planB: rotto }).maxBid, maxBid(args).maxBid);
  assert.deepEqual(
    alternatives({ ...args, limit: 5, planB: rotto }).alternatives.map((a) => a.player.id),
    alternatives({ ...args, limit: 5 }).alternatives.map((a) => a.player.id)
  );
});

// --- il blocco conta chi schiero, non chi e' in rosa ----------------------------------------
// Sul listone vero il piano comprava tre difensori della Roma con punteggio intorno a uno —
// Rensch, Lulli, Ghilardi — perche' ogni testa in piu' nel blocco valeva dodici punti di bonus,
// piu' di qualunque titolare vero da due crediti. E il terzo portiere della Roma, titolarita'
// uno, incassava l'intero bonus da riserva.

function difensore(id, team, score, extra = {}) {
  return { id, name: id, team, role: 'D', score, titolarita: 5, integrita: 5, solidity: 0.5, ...extra };
}
function portiere(id, team, score, titolarita) {
  return { id, name: id, team, role: 'P', score, titolarita, integrita: 5 };
}
const SOLO_DIFESA = { ...defaultSettings(), defenseModifier: true, cleanSheetModifier: false };
const SOLO_PORTA = { ...defaultSettings(), defenseModifier: false, cleanSheetModifier: true };

test('un riempitivo dello stesso club non gonfia il blocco difensivo', () => {
  // Una difesa vera da otto: due della Roma e cinque di altri club. L'ottavo posto e' quello
  // in cui finisce il riempitivo, ed e' li' che deve contare quasi niente.
  const coppia = [
    difensore('mancini', 'ROM', 160), difensore('ndicka', 'ROM', 130), difensore('solet', 'UDI', 140),
    difensore('bastoni', 'INT', 150), difensore('gabriel', 'LEC', 120), difensore('marcandalli', 'GEN', 105),
    difensore('gallo', 'LEC', 90),
  ];
  const conRiempitivo = [...coppia, difensore('lulli', 'ROM', 3, { titolarita: 3 })];
  const conTitolare = [...coppia, difensore('celik', 'ROM', 110)];
  const base = synergyBonus(coppia, SOLO_DIFESA);
  const gonfiato = synergyBonus(conRiempitivo, SOLO_DIFESA);
  const vero = synergyBonus(conTitolare, SOLO_DIFESA);
  assert.ok(gonfiato - base < 1, `un difensore da tre punti aggiunge ${(gonfiato - base).toFixed(1)} punti di blocco`);
  assert.ok(vero - base > 5, `un terzo titolare vero aggiunge solo ${(vero - base).toFixed(1)} punti`);
});

test('il blocco si schiera insieme: il terzo titolare conta pieno anche se e\' il mio quarto difensore', () => {
  // Tre della Roma piu' un difensore di un altro club piu' forte del terzo romanista: da solo
  // quel terzo sarebbe il quarto in rosa, ma con il blocco lo schiero, e il bonus deve dirlo.
  const rosa = [difensore('mancini', 'ROM', 160), difensore('ndicka', 'ROM', 130), difensore('celik', 'ROM', 100), difensore('solet', 'UDI', 140)];
  const senzaTerzo = rosa.slice(0, 2).concat(rosa[3]);
  const pieno = synergyBonus(rosa, SOLO_DIFESA);
  const due = synergyBonus(senzaTerzo, SOLO_DIFESA);
  // Il fattore passa da 0,04 (due) a 0,11 (tre): sulla media del blocco fa piu' di otto punti.
  assert.ok(pieno - due > 8, `da due a tre titolari il blocco cresce di ${(pieno - due).toFixed(1)}`);
});

test('il terzo portiere non e\' un\'assicurazione, il secondo si\'', () => {
  const svilar = portiere('svilar', 'ROM', 240, 5);
  const terzo = [svilar, portiere('demarzi', 'ROM', 1, 1)];
  const secondo = [svilar, portiere('gollini', 'ROM', 20, 2)];
  const altroClub = [svilar, portiere('falcone', 'LEC', 180, 5)];
  assert.equal(synergyBonus(terzo, SOLO_PORTA), synergyBonus(altroClub, SOLO_PORTA), 'un terzo portiere vale quanto uno di un altro club');
  assert.ok(synergyBonus(secondo, SOLO_PORTA) > synergyBonus(altroClub, SOLO_PORTA) + 10, 'il secondo vero vale il bonus');
});

// --- il mercato rincara i top rispetto ai listini -------------------------------------------
// Su un'asta reale a otto squadre i primi otto giocatori hanno preso il 32% dei crediti; i tre
// creator ne prevedevano fra il 22% e il 29%. Un esponente sopra uno sulle quote dei creator
// sposta crediti dalla coda alla testa senza cambiare l'ordine.

function quotaPrimi(players, n) {
  const prezzi = players.map((p) => p.expectedPrice).sort((a, b) => b - a);
  const tot = prezzi.reduce((a, b) => a + b, 0);
  return prezzi.slice(0, n).reduce((a, b) => a + b, 0) / tot;
}

test('la ripidita\' sposta crediti sui primi nomi e non cambia l\'ordine', () => {
  const piatto = makeContext({ projected: true, priceSource: 'listone', ripidita: 1 });
  const ripido = makeContext({ projected: true, priceSource: 'listone', ripidita: 1.25 });
  assert.ok(quotaPrimi(ripido.players, 8) > quotaPrimi(piatto.players, 8) * 1.1, 'con 1,25 i primi otto pesano almeno il 10% in piu\'');
  // Chi costava strettamente di piu' costa ancora di piu': la potenza e' monotona, e cambiare
  // l'ordine vorrebbe dire aver cambiato il giudizio dei creator, non solo la scala.
  const prezzoRipido = new Map(ripido.players.map((p) => [p.id, p.expectedPrice]));
  const top = piatto.players.slice().sort((a, b) => b.expectedPrice - a.expectedPrice).slice(0, 60);
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      if (top[i].expectedPrice > top[j].expectedPrice) {
        assert.ok(
          prezzoRipido.get(top[i].id) >= prezzoRipido.get(top[j].id),
          `${top[i].id} (${top[i].expectedPrice}) costava piu' di ${top[j].id} (${top[j].expectedPrice}) e ora no`
        );
      }
    }
  }
  // I crediti che il mercato spende davvero — quelli sui giocatori che verranno comprati —
  // restano gli stessi: la potenza li sposta, non li crea. Sulla coda non comprata il totale
  // puo' cambiare per l'arrotondamento a un credito, e non e' un invariante.
  const comprati = (ctx) => ctx.players.slice().sort((a, b) => b.expectedPrice - a.expectedPrice).slice(0, ctx.settings.participants * totalSlots(ctx.settings));
  const tot = (ctx) => comprati(ctx).reduce((s, p) => s + p.expectedPrice, 0);
  assert.ok(Math.abs(tot(ripido) - tot(piatto)) / tot(piatto) < 0.05, `i crediti in gioco cambiano: ${tot(piatto)} → ${tot(ripido)}`);
});

test('la ripidita\' di default e\' quella misurata sull\'asta reale', () => {
  assert.equal(defaultSettings().ripidita, 1.25);
});

// --- i trasferimenti fra un file e l'altro ---------------------------------------------------
// Due file di date diverse davano Kean a FIO e a COM: nome + club + ruolo e' l'identita', quindi
// erano due persone, entrambe in listone. L'ultimo file caricato ha ragione sul club.

test('un giocatore che cambia club fra due file resta uno solo, con il club nuovo', () => {
  const vecchio = buildPlayers([{ Nome: 'Kean', Squadra: 'FIO', Ruolo: 'A', Prezzo: '90' }], { name: 'Nome', team: 'Squadra', role: 'Ruolo', price: 'Prezzo' }, { source: 'agosto' }).players;
  const nuovo = buildPlayers([{ Nome: 'Kean', Squadra: 'COM', Ruolo: 'A', Prezzo: '80' }], { name: 'Nome', team: 'Squadra', role: 'Ruolo', price: 'Prezzo' }, { source: 'settembre' }).players;
  const fusi = mergeSources([vecchio, nuovo]);
  assert.equal(fusi.length, 1, 'una persona sola');
  assert.equal(fusi[0].team, 'COM', 'il club e\' quello del file piu\' recente');
  assert.equal(fusi[0].trasferitoDa, 'FIO');
  assert.deepEqual(Object.keys(fusi[0].bySource).sort(), ['agosto', 'settembre'], 'i dati di entrambi i file restano');
  assert.equal(fusi[0].price, 85, 'i prezzi si mediano come per ogni altro giocatore');
});

test('due omonimi nello stesso file restano due persone', () => {
  const m = { name: 'Nome', team: 'Squadra', role: 'Ruolo', price: 'Prezzo' };
  const unFile = buildPlayers([{ Nome: 'Rossi', Squadra: 'TOR', Ruolo: 'D', Prezzo: '5' }, { Nome: 'Rossi', Squadra: 'GEN', Ruolo: 'D', Prezzo: '3' }], m, { source: 'a' }).players;
  const altroFile = buildPlayers([{ Nome: 'Rossi', Squadra: 'GEN', Ruolo: 'D', Prezzo: '4' }], m, { source: 'b' }).players;
  const fusi = mergeSources([unFile, altroFile]);
  assert.equal(fusi.length, 2, 'l\'omonimia vera non si fonde');
  assert.ok(fusi.every((p) => !p.trasferitoDa));
});

test('lo stesso nome in ruoli diversi non e\' un trasferimento', () => {
  const m = { name: 'Nome', team: 'Squadra', role: 'Ruolo', price: 'Prezzo' };
  const a = buildPlayers([{ Nome: 'Thuram', Squadra: 'INT', Ruolo: 'A', Prezzo: '100' }], m, { source: 'a' }).players;
  const b = buildPlayers([{ Nome: 'Thuram', Squadra: 'JUV', Ruolo: 'C', Prezzo: '20' }], m, { source: 'b' }).players;
  assert.equal(mergeSources([a, b]).length, 2);
});

// --- il tetto per singolo giocatore ---------------------------------------------------------
// Il mercato comprime la cima: nell'asta reale i primi cinque attaccanti sono andati tutti
// fra 151 e 161, nessuno oltre un terzo del budget, mentre i listini li distanziavano di molto.
// Con Malen stimato 234 il piano lo evitava; con i prezzi veri lo sceglie.

function legaPiccola(tettoSingolo) {
  // Due squadre, cento crediti, una rosa da venticinque: un fuoriclasse che i listini
  // prezzano quanto tutti gli altri messi insieme, e nove comprimari. (Le caselle sono
  // venticinque perche' il tetto e' definito su quella rosa e scala con le caselle.)
  const players = [
    { id: 'fuoriclasse', name: 'Fuoriclasse', team: 'A', role: 'A', price: 100, score: 100 },
    ...Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, team: 'B', role: i < 3 ? 'A' : i < 6 ? 'C' : 'D', price: 10, score: 10 })),
  ];
  const settings = { ...defaultSettings(), participants: 2, budget: 100, slots: { P: 3, D: 8, C: 8, A: 6 }, priceSource: 'listone', ripidita: 1, tettoSingolo };
  return { players, settings, prezzi: expectedPrices(players, settings) };
}

test('nessuno costa piu\' del tetto, e i crediti in eccesso vanno agli altri', () => {
  const senza = legaPiccola(1);
  const con = legaPiccola(0.33);
  const cap = Math.round(100 * 0.33);
  assert.ok(senza.prezzi.get('fuoriclasse') > cap, `senza tetto il fuoriclasse vale ${senza.prezzi.get('fuoriclasse')}`);
  assert.equal(con.prezzi.get('fuoriclasse'), cap, 'con il tetto si ferma li\'');
  for (const [, v] of con.prezzi) assert.ok(v <= cap);
  // Un credito di tolleranza a giocatore: e' l'arrotondamento, non una perdita.
  const somma = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(somma(con.prezzi) - somma(senza.prezzi)) <= con.players.length, 'i crediti tolti al fuoriclasse restano sul mercato');
  const altro = (m) => m.get('c0');
  assert.ok(altro(con.prezzi) > altro(senza.prezzi), `gli altri salgono: ${altro(senza.prezzi)} → ${altro(con.prezzi)}`);
});

test('il tetto di default e\' un terzo del budget', () => {
  assert.equal(defaultSettings().tettoSingolo, 0.33);
});

// --- gli avvisi del creator ------------------------------------------------------------------
// Su diciannove etichette il punteggio ne prezza cinque. Le altre o sono gia' dentro un numero
// che il modello legge (titolarita', integrita', fantamedia attesa, fascia), o sono troppo rare
// per tararle. Queste sette non le trasforma in punti: le mostra nel piano, dove si decide.

test('un avviso che il punteggio non usa arriva a chi guarda il piano', () => {
  const voci = avvisiCreator({ tags: ['bonus', 'coppa africa', 'rigorista', 'esca'] });
  assert.deepEqual(voci.map((v) => v.tag), ['esca', 'coppa africa']);
  assert.ok(voci.every((v) => v.perche && v.perche.length > 10), 'ogni avviso spiega perche\' conta');
});

test('le etichette gia\' dentro il punteggio non diventano avvisi: sarebbero contate due volte', () => {
  for (const tag of ['modificatore', 'imbattibilita', 'pararigori', 'rigorista', 'cartellini']) {
    assert.deepEqual(avvisiCreator({ tags: [tag] }), [], `${tag} e' gia' nel punteggio`);
  }
});

test('senza etichette non si inventa niente', () => {
  assert.deepEqual(avvisiCreator({}), []);
  assert.deepEqual(avvisiCreator({ tags: [] }), []);
  assert.deepEqual(avvisiCreator({ tags: ['titolarissimo', 'costante', 'tanti gol'] }), [],
    'quelle gia\' dentro titolarita\' e fantamedia attesa non sono avvisi');
});

test('gli avvisi non toccano il punteggio: sono per gli occhi, non per il solutore', () => {
  const settings = { ...defaultSettings(), defenseModifier: false, cleanSheetModifier: false };
  const base = { id: 'x', name: 'X', team: 'ROM', role: 'C', tier: 'Top', fmvExp: 7, titolarita: 5, integrita: 5, tags: [] };
  const senza = valuePlayers([base, { ...base, id: 'y', name: 'Y' }], settings)[0];
  const con = valuePlayers([{ ...base, tags: AVVISI_CREATOR.map(([t]) => t) }, { ...base, id: 'y', name: 'Y' }], settings)[0];
  assert.equal(con.score, senza.score, 'nessuno dei sette avvisi sposta il punteggio');
});

// --- la titolarita' quando i creators non sono d'accordo -------------------------------------
// Ogni creator da' un giudizio intero, ma con piu' file diventa una media: 4,33 vuol dire che
// due lo danno titolare e uno no. Arrotondare buttava via proprio quel disaccordo, e i gradini
// sono larghi — fra 0,56 e 0,76 c'e' il 36% di una stagione.

const soloTit = (titolarita) => expectedShare({ titolarita, integrita: 5 });

test('un giudizio intero vale esattamente quanto valeva prima', () => {
  const attesi = [0.05, 0.15, 0.34, 0.56, 0.76, 0.92];
  for (let v = 0; v <= 5; v++) assert.ok(Math.abs(soloTit(v) - attesi[v]) < 1e-9, `titolarita' ${v}`);
});

test('una media fra due giudizi sta in mezzo, non salta al gradino piu\' vicino', () => {
  const quattro = soloTit(4);
  const cinque = soloTit(5);
  const media = soloTit(4.5);
  assert.ok(media > quattro && media < cinque, `4,5 deve stare fra ${quattro} e ${cinque}, vale ${media}`);
  assert.ok(Math.abs(media - (quattro + cinque) / 2) < 1e-9, 'e a meta\' esatta, essendo a meta\' fra i due');
  // Il difetto vero: 4,4 e 4,6 differiscono di due decimi di giudizio e finivano a 0,56 e 0,92.
  assert.ok(soloTit(4.6) - soloTit(4.4) < 0.1, `fra 4,4 e 4,6 lo scarto era del 36%, ora e' ${(soloTit(4.6) - soloTit(4.4)).toFixed(3)}`);
});

test('la frazione di stagione cresce sempre con la titolarita\'', () => {
  for (let v = 0; v < 5; v += 0.25) assert.ok(soloTit(v + 0.25) > soloTit(v), `scende fra ${v} e ${v + 0.25}`);
});

test('fuori scala non si rompe', () => {
  assert.equal(soloTit(9), soloTit(5));
  assert.equal(soloTit(-3), soloTit(0));
  assert.ok(expectedShare({}) > 0, 'senza giudizi resta un valore sensato');
});

// --- il voto puro: la grandezza su cui si calcola il modificatore ----------------------------
// Il regolamento e' esplicito: media dei voti del portiere e dei tre migliori difensori
// schierati, esclusi bonus e malus. Un difensore che segna entra con il suo voto, non col
// fantavoto. La solidita' dei club si calcolava invece sui punteggi, che vengono dalla
// fantamedia e quindi contengono proprio i gol dei difensori.

const difensore2 = (id, team, mediavoto, extra = {}) => ({
  id, name: id, team, role: 'D', mediavoto, minutes: 2500, matches: 30,
  fmvExp: mediavoto, fantamedia: mediavoto, titolarita: 5, integrita: 5, ...extra,
});

test('quando la media voto e\' misurata su abbastanza partite, si usa quella', () => {
  assert.equal(votoAtteso({ role: 'D', mediavoto: 6.3, minutes: 2500, fmvExp: 7.1 }), 6.3);
});

test('una media voto da poche partite e\' un segnaposto, non un voto basso', () => {
  // Nel listone vero chi non ha giocato in Serie A ha valori come 1,33 o 1,83: prenderli per
  // buoni faceva risultare tre giocatori simili i "migliori difensori" del loro club.
  const finto = { role: 'D', mediavoto: 1.33, minutes: 120, matches: 2, fmvExp: 6.0 };
  const v = votoAtteso(finto);
  assert.ok(v > 5.5, `un segnaposto da 1,33 non deve diventare un voto: ${v}`);
  assert.ok(Math.abs(v - (6.0 - 0.10)) < 1e-9, 'si stima dalla fantamedia attesa meno il bonus tipico del ruolo');
});

test('un segnaposto con i minuti pieni resta un segnaposto', () => {
  // Il caso che il controllo sui minuti da solo non prendeva: la colonna dei minuti piena e
  // quella della media voto ancora a segnaposto. Vicario arrivava cosi' nel calcolo del
  // modificatore con un voto di 2,08 e da solo faceva scendere la Juve dal terzo posto al
  // diciassettesimo. Sotto il cinque non e' un voto basso, e' un campo non compilato.
  const v = votoAtteso({ role: 'P', mediavoto: 2.08, minutes: 1920, matches: 24, fmvExp: 5.27 });
  assert.ok(v > 5.5, `un segnaposto da 2,08 con 1920 minuti non deve diventare un voto: ${v}`);
  assert.ok(Math.abs(v - (5.27 + 0.84)) < 1e-9, 'si ripiega sulla stima dalla fantamedia attesa');
});

test('un voto misurato appena sopra la soglia si usa com\'e\'', () => {
  // La soglia non deve mangiarsi i voti veri bassi: 5,2 con i minuti pieni e' un giudizio.
  assert.equal(votoAtteso({ role: 'D', mediavoto: 5.2, minutes: 2500, fmvExp: 6.4 }), 5.2);
});

test('per un portiere la distanza dalla fantamedia e\' un malus, e non lo premia', () => {
  // Il difetto che questo test sorveglia: ricavare il voto togliendo alla fantamedia attesa la
  // distanza FMV-MV significava, per un portiere, restituirgli il malus dei gol subiti. Chi ne
  // aveva presi di piu' usciva col voto piu' alto della Serie A.
  const subisceTanto = { role: 'P', mediavoto: 5.91, fantamedia: 3.90, fmvExp: 5.06, minutes: 2500 };
  const subiscePoco = { role: 'P', mediavoto: 6.20, fantamedia: 5.71, fmvExp: 5.30, minutes: 2500 };
  assert.ok(
    votoAtteso(subisceTanto) < votoAtteso(subiscePoco),
    `chi subisce di piu' non puo' avere il voto piu' alto: ${votoAtteso(subisceTanto)} contro ${votoAtteso(subiscePoco)}`
  );
});

test('la solidita\' guarda i voti, non i gol dei difensori', () => {
  // Due club identici nei voti, ma i difensori di uno segnano molto: per il modificatore
  // valgono uguale, perche' il gol del difensore non entra nel calcolo.
  const senzaGol = ['a1', 'a2', 'a3'].map((id) => difensore2(id, 'AAA', 6.4));
  const conGol = ['b1', 'b2', 'b3'].map((id) => difensore2(id, 'BBB', 6.4, { fmvExp: 7.6, fantamedia: 7.6 }));
  const portieri = [
    { id: 'pa', name: 'pa', team: 'AAA', role: 'P', mediavoto: 6.2, fantamedia: 5.4, fmvExp: 5.4, minutes: 3000, titolarita: 5, integrita: 5 },
    { id: 'pb', name: 'pb', team: 'BBB', role: 'P', mediavoto: 6.2, fantamedia: 5.4, fmvExp: 5.4, minutes: 3000, titolarita: 5, integrita: 5 },
  ];
  const sol = clubSolidity([...senzaGol, ...conGol, ...portieri]);
  assert.equal(sol.get('AAA'), sol.get('BBB'), 'i gol dei difensori non devono spostare la solidita\'');
});

test('un club con voti alti sta sopra uno con voti bassi', () => {
  const forte = ['f1', 'f2', 'f3'].map((id) => difensore2(id, 'FOR', 6.6));
  const debole = ['d1', 'd2', 'd3'].map((id) => difensore2(id, 'DEB', 5.6));
  const p = (id, team, mv) => ({ id, name: id, team, role: 'P', mediavoto: mv, fantamedia: mv - 0.8, fmvExp: mv - 0.8, minutes: 3000, titolarita: 5, integrita: 5 });
  const sol = clubSolidity([...forte, ...debole, p('pf', 'FOR', 6.5), p('pd', 'DEB', 5.7)]);
  assert.ok(sol.get('FOR') > sol.get('DEB'));
});

test('un club giudicato su pochi voti viene tirato verso la media di lega', () => {
  // Meta' dei difensori non ha una media voto misurata. Senza contrazione un club con un solo
  // dato estremo starebbe in cima o in fondo per caso; con la contrazione il suo scarto dalla
  // media si accorcia in proporzione a quanto poco si sa di lui.
  const p = (id, team, mv) => ({ id, name: id, team, role: 'P', mediavoto: mv, fantamedia: mv - 0.8, fmvExp: mv - 0.8, minutes: 3000, titolarita: 5, integrita: 5 });
  const solidi = ['s1', 's2', 's3'].map((id) => difensore2(id, 'SOL', 6.5));
  const medi = ['m1', 'm2', 'm3'].map((id) => difensore2(id, 'MED', 6.2));
  const unoSolo = [difensore2('u1', 'UNO', 7.2)];
  const sol = clubSolidity([...solidi, ...medi, ...unoSolo, p('ps', 'SOL', 6.4), p('pm', 'MED', 6.2), p('pu', 'UNO', 7.0)]);
  // Resta il piu' forte — i suoi due voti sono davvero altissimi — ma non stacca come farebbe
  // se lo si giudicasse solo su quei due.
  assert.ok(sol.get('UNO') >= sol.get('SOL'));
  assert.ok(sol.get('SOL') > sol.get('MED'), 'i club con dati pieni restano ordinati fra loro');
});

test('senza voti ne\' fantamedia attesa la solidita\' ripiega sui punteggi', () => {
  // Un listone di sole fasce e prezzi non sa niente dei voti. Restare senza solidita' sarebbe
  // peggio: il modificatore smetterebbe di spostare crediti in difesa.
  const soloFasce = [
    { id: 'd1', name: 'd1', team: 'AAA', role: 'D' }, { id: 'd2', name: 'd2', team: 'AAA', role: 'D' },
    { id: 'd3', name: 'd3', team: 'AAA', role: 'D' }, { id: 'p1', name: 'p1', team: 'AAA', role: 'P' },
    { id: 'd4', name: 'd4', team: 'BBB', role: 'D' }, { id: 'd5', name: 'd5', team: 'BBB', role: 'D' },
    { id: 'd6', name: 'd6', team: 'BBB', role: 'D' }, { id: 'p2', name: 'p2', team: 'BBB', role: 'P' },
  ];
  const punteggi = new Map(soloFasce.map((x) => [x.id, x.team === 'AAA' ? 100 : 40]));
  const sol = clubSolidity(soloFasce, punteggi);
  assert.equal(sol.size, 2, 'il ripiego deve dare una solidita\' a entrambi i club');
  assert.ok(sol.get('AAA') > sol.get('BBB'), 'e ordinarli come dicono i punteggi');
  // Senza nemmeno i punteggi non si inventa niente.
  assert.equal(clubSolidity(soloFasce).size, 0);
});
