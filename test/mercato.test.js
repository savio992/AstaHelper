import test from 'node:test';
import assert from 'node:assert/strict';

import { makeContext } from './helpers.js';
import { ROLES, totalSlots } from '../src/domain/model.js';
import {
  statoMercato,
  prezziLive,
  applyPrezziLive,
  avversari,
  concorrenza,
  verdettoConcorrenza,
  momentoGiusto,
  normalizeTaken,
  nomiSquadre,
} from '../src/domain/mercato.js';
import { pianoDiReparto, abbinamentoPortiere } from '../src/domain/advisor.js';
import { optimizeRoster } from '../src/domain/optimizer.js';

const ctx = () => makeContext({ projected: true, participants: 8, budget: 500 }, 11);

test('a mercato vergine gli slot residui sono esattamente quelli della lega', () => {
  const { players, settings } = ctx();
  const m = statoMercato({ settings, players });
  for (const role of ROLES) {
    assert.equal(m.residui[role], settings.slots[role] * settings.participants);
  }
  assert.equal(m.slotResidui, totalSlots(settings) * settings.participants);
  assert.equal(m.creditiResidui, settings.budget * settings.participants);
  assert.equal(m.discrezionali, (settings.budget - totalSlots(settings)) * settings.participants);
});

test('gli slot residui si contano esattamente, anche senza conoscere i prezzi', () => {
  const { players, settings } = ctx();
  const attaccanti = players.filter((p) => p.role === 'A').slice(0, 5);
  // Registrati senza prezzo: il conteggio degli slot non ne ha bisogno.
  const taken = new Map(attaccanti.map((p) => [p.id, { price: 0, by: null }]));
  const m = statoMercato({ settings, players, taken });
  assert.equal(m.residui.A, settings.slots.A * settings.participants - 5);
  assert.equal(m.residui.D, settings.slots.D * settings.participants);
  assert.equal(m.slotAssegnati, 5);
  assert.equal(m.copertura, 0);
});

test('se il mercato strapaga i primi, per quelli dopo restano meno crediti', () => {
  const { players, settings } = ctx();
  const primi = players
    .filter((p) => p.role === 'A')
    .sort((a, b) => b.expectedPrice - a.expectedPrice)
    .slice(0, 12);

  const caro = new Map(primi.map((p) => [p.id, { price: p.expectedPrice * 3, by: null }]));
  const conveniente = new Map(primi.map((p) => [p.id, { price: Math.max(1, Math.round(p.expectedPrice * 0.4)), by: null }]));

  const mCaro = statoMercato({ settings, players, taken: caro });
  const mConv = statoMercato({ settings, players, taken: conveniente });

  assert.ok(mCaro.creditiResidui < mConv.creditiResidui, 'strapagare deve prosciugare la stanza');
  const lCaro = prezziLive(players, settings, mCaro).lambda;
  const lConv = prezziLive(players, settings, mConv).lambda;
  assert.ok(lCaro < lConv, `dopo gli eccessi i prezzi devono scendere (${lCaro} vs ${lConv})`);

  // E il singolo giocatore ancora libero costa davvero meno nello scenario caro.
  const libero = players.find((p) => p.role === 'C' && p.expectedPrice > 20);
  const a = prezziLive(players, settings, mCaro).prezzi.get(libero.id);
  const b = prezziLive(players, settings, mConv).prezzi.get(libero.id);
  assert.ok(a < b, `${libero.name}: ${a} nel mercato caro contro ${b} in quello conveniente`);
});

test('a inizio asta il riscalamento non stravolge le stime del listone', () => {
  const { players, settings } = ctx();
  const m = statoMercato({ settings, players });
  const { lambda } = prezziLive(players, settings, m);
  // I due modelli normalizzano sullo stesso montepremi: devono coincidere quasi esattamente.
  // I due modelli normalizzano sullo stesso montepremi e sullo stesso insieme di venduti:
  // devono coincidere quasi esattamente, altrimenti aprire l'app sposterebbe i prezzi.
  assert.ok(Math.abs(lambda - 1) < 0.03, `lambda a mercato vergine = ${lambda}`);
});

test('applyPrezziLive conserva la stima statica e aggiorna il margine', () => {
  const { players, settings } = ctx();
  const m = statoMercato({ settings, players });
  const live = applyPrezziLive(players, settings, m);
  const p = live.find((x) => x.consigliato !== null);
  assert.equal(p.expectedPriceBase, players.find((x) => x.id === p.id).expectedPrice);
  assert.equal(p.edge, p.consigliato - p.expectedPrice);
});

test('il tabellone sa quanto puo\' ancora offrire ogni avversario', () => {
  const { players, settings } = ctx();
  const rosa = totalSlots(settings);
  const bersagli = players.filter((p) => p.role === 'A').slice(0, 3);
  const taken = new Map([
    [bersagli[0].id, { price: 200, by: 1 }],
    [bersagli[1].id, { price: 150, by: 1 }],
    [bersagli[2].id, { price: 10, by: 2 }],
  ]);
  const board = avversari({ settings, players, taken });
  const sq1 = board.squadre[1];
  const sq2 = board.squadre[2];
  assert.equal(sq1.spesi, 350);
  assert.equal(sq1.residuo, 150);
  assert.equal(sq1.massimo, 150 - (rosa - 2 - 1));
  assert.ok(sq2.massimo > sq1.massimo, 'chi ha speso poco puo\' offrire di piu\'');
  assert.equal(board.attendibile, true);
});

test('senza attribuzione il tabellone si dichiara inattendibile', () => {
  const { players, settings } = ctx();
  const taken = new Map([[players[0].id, { price: 40, by: null }]]);
  const board = avversari({ settings, players, taken });
  assert.equal(board.attendibile, false);
  assert.equal(board.nonAttribuiti, 1);
});

test('chi ha gia\' riempito il reparto non e\' piu\' un rivale', () => {
  const { players, settings } = ctx();
  const portieri = players.filter((p) => p.role === 'P').slice(0, settings.slots.P);
  const taken = new Map(portieri.map((p) => [p.id, { price: 5, by: 1 }]));
  const prima = concorrenza({ settings, players, role: 'P' });
  const dopo = concorrenza({ settings, players, taken, role: 'P' });
  assert.equal(prima.quanti, settings.participants - 1);
  assert.equal(dopo.quanti, settings.participants - 2);
  assert.ok(dopo.ricchi.every((s) => s.indice !== 1));
});

test('quando nessuno puo\' superarmi il verdetto dice il prezzo esatto', () => {
  const conc = { quanti: 2, massimo: 18, ricchi: [{ nome: 'Squadra 3', massimo: 18 }], attendibile: true };
  const v = verdettoConcorrenza({ mioMassimo: 40, conc });
  assert.equal(v.esito, 'tuo');
  assert.equal(v.prezzo, 19);
});

test('con un solo rivale capace di batterti il verdetto lo nomina', () => {
  const conc = {
    quanti: 3,
    massimo: 90,
    ricchi: [
      { nome: 'Squadra 4', massimo: 90 },
      { nome: 'Squadra 2', massimo: 20 },
    ],
    attendibile: true,
  };
  const v = verdettoConcorrenza({ mioMassimo: 60, conc });
  assert.equal(v.esito, 'conteso');
  assert.match(v.testo, /Squadra 4/);
});

test('il momento della chiamata dipende da quanti avversari sono ancora in gioco', () => {
  const { players, settings } = ctx();
  const target = players.find((p) => p.role === 'A' && p.expectedPrice > 30);
  const pieno = momentoGiusto({ settings, players, owned: new Map(), taken: new Map(), player: target });
  assert.equal(pieno.chiama, false);
});

test('normalizeTaken accetta il vecchio formato con il solo prezzo', () => {
  const m = normalizeTaken({ a: 30, b: { price: 12, by: 2 } });
  assert.deepEqual(m.get('a'), { price: 30, by: null });
  assert.deepEqual(m.get('b'), { price: 12, by: 2 });
});

test('i nomi delle squadre coprono tutta la lega e il primo sono io', () => {
  const nomi = nomiSquadre({ participants: 8, squadre: ['Io', 'Marco'] });
  assert.equal(nomi.length, 8);
  assert.equal(nomi[1], 'Marco');
  assert.equal(nomi[7], 'Squadra 8');
});

test('il piano di reparto apre dai portieri con tetto e ripieghi pronti', () => {
  const { players, settings } = ctx();
  const plan = optimizeRoster({ players, settings });
  const rep = pianoDiReparto({ players, settings, plan });
  assert.equal(rep.fase, 'P');
  assert.ok(rep.obiettivi.length >= 1);
  for (const o of rep.obiettivi) {
    assert.equal(o.player.role, 'P');
    assert.ok(o.massimo >= 0);
    assert.ok(o.ripieghi.every((r) => r.player.role === 'P'));
    // Nessun ripiego puo' essere un altro obiettivo dello stesso reparto.
    const idObiettivi = new Set(rep.obiettivi.map((x) => x.player.id));
    assert.ok(!o.ripieghi.some((r) => idObiettivi.has(r.player.id)));
  }
});

test('se saltano tutti gli obiettivi del reparto il piano dice dove vanno i crediti', () => {
  const { players, settings } = ctx();
  const plan = optimizeRoster({ players, settings });
  const rep = pianoDiReparto({ players, settings, plan, role: 'A' });
  assert.ok(rep.senzaNessuno, 'lo scenario nero deve essere calcolabile');
  assert.ok(rep.senzaNessuno.picks.length >= 1);
  assert.ok(rep.senzaNessuno.costo >= 0, 'perdere gli obiettivi non puo\' migliorare la rosa');
  const spostati = rep.senzaNessuno.destinazione.reduce((a, d) => a + d.delta, 0);
  if (rep.senzaNessuno.liberati > 5) assert.ok(spostati > 0, 'i crediti liberati devono ricomparire altrove');
});

test('il secondo portiere si consiglia nella squadra del titolare', () => {
  const { players, settings } = ctx();
  const plan = optimizeRoster({ players, settings });
  const ab = abbinamentoPortiere({ players, settings, plan });
  assert.ok(ab);
  if (!ab.fatto && ab.coppia) {
    assert.equal(ab.coppia.team, ab.titolare.team);
    assert.equal(ab.coppia.role, 'P');
  }
});

test('un acquisto non attribuito alza il tetto di chi lo ha fatto, mai lo abbassa', () => {
  const { players, settings } = ctx();
  const compra = players.filter((p) => p.role === 'C').slice(0, 3);
  const prezzi = [60, 25, 4];

  // La verita': tutti e tre li ha comprati la squadra 1.
  const vero = avversari({
    settings,
    players,
    taken: new Map(compra.map((p, i) => [p.id, { price: prezzi[i], by: 1 }])),
  });

  // Quello che vedo io se di uno non so l'acquirente.
  for (let salta = 0; salta < 3; salta++) {
    const visto = avversari({
      settings,
      players,
      taken: new Map(compra.map((p, i) => [p.id, { price: prezzi[i], by: i === salta ? null : 1 }])),
    });
    const differenza = visto.squadre[1].massimo - vero.squadre[1].massimo;
    assert.ok(differenza >= 0, `il tetto visto (${visto.squadre[1].massimo}) non puo' stare sotto il vero (${vero.squadre[1].massimo})`);
    // Un credito del prezzo lo stavo gia' contando come casella libera da riempire.
    assert.equal(differenza, prezzi[salta] - 1, 'lo scarto e\' esattamente (prezzo - 1)');
    assert.equal(visto.scarto, prezzi[salta] - 1, 'ed e\' quello che il tabellone dichiara');
    assert.equal(visto.attribuiti, 2);
    assert.equal(visto.venduti, 3);
  }
});

test('con il tabellone mezzo vuoto il verdetto dice comunque il numero, e da dove viene', () => {
  const conc = {
    quanti: 2,
    massimo: 18,
    ricchi: [{ nome: 'Squadra 3', massimo: 18 }],
    attendibile: false,
    attribuiti: 12,
    venduti: 20,
    nonAttribuiti: 8,
    scarto: 47,
  };
  const v = verdettoConcorrenza({ mioMassimo: 40, conc });
  // Il tetto e' un limite superiore: se nessuno arriva a 18 nemmeno nel caso peggiore,
  // non ci arriva a maggior ragione nel caso vero. Il consiglio si puo' dare.
  assert.equal(v.esito, 'tuo');
  assert.equal(v.prezzo, 19);
  assert.match(v.nota, /12 giocatori su 20/);
  assert.match(v.nota, /47/);
});

test('a tabellone completo il verdetto non ha niente da giustificare', () => {
  const conc = { quanti: 2, massimo: 18, ricchi: [{ nome: 'Squadra 3', massimo: 18 }], attendibile: true };
  assert.equal(verdettoConcorrenza({ mioMassimo: 40, conc }).nota, null);
});

test('anche il momento della chiamata smette di aspettare il tabellone perfetto', () => {
  const { players, settings } = ctx();
  const bersaglio = players.filter((p) => p.role === 'A').sort((a, b) => b.expectedPrice - a.expectedPrice)[0];
  // Tutti gli avversari hanno speso quasi tutto, e di un acquisto non so l'acquirente.
  const spesi = players.filter((p) => p.role === 'C').slice(0, 8);
  const taken = new Map();
  for (let i = 1; i < settings.participants; i++) taken.set(spesi[i].id, { price: settings.budget - 30, by: i });
  taken.set(spesi[0].id, { price: 20, by: null });

  const m = momentoGiusto({ settings, players, owned: new Map(), taken, player: bersaglio });
  const conc = concorrenza({ settings, players, taken, role: 'A' });
  assert.equal(conc.attendibile, false, 'il tabellone e\' incompleto per costruzione');
  assert.ok(conc.massimo < Math.round(bersaglio.expectedPrice), 'e nessuno arriva al suo prezzo');
  assert.equal(m.chiama, true, 'quindi il consiglio si puo\' dare lo stesso');
});
