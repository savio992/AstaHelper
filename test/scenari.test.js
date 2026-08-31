import test from 'node:test';
import assert from 'node:assert/strict';

import { generaScenari, valutaScenario, nucleoScenario, descriviScenario, stelle } from '../src/domain/scenari.js';
import { optimizeRoster, CONFIG_SOLUTORE } from '../src/domain/optimizer.js';
import { makeContext } from './helpers.js';

const ctx = makeContext({ projected: true });

test('genera strade davvero diverse, non la stessa rosa con un riempitivo scambiato', () => {
  const { scenari } = generaScenari({ ...ctx, quante: 4 });
  assert.ok(scenari.length >= 2, 'almeno due strade');
  for (let i = 0; i < scenari.length; i++) {
    for (let j = i + 1; j < scenari.length; j++) {
      const a = new Set(scenari[i].ids);
      const diversi = scenari[j].ids.filter((id) => !a.has(id)).length;
      assert.ok(diversi >= 2, `strade ${i} e ${j} differiscono per un solo giocatore`);
    }
  }
});

test('ogni strada e\' una rosa valida e completa, non un abbozzo', () => {
  const { scenari } = generaScenari({ ...ctx });
  const slot = Object.values(ctx.settings.slots).reduce((a, b) => a + b, 0);
  for (const s of scenari) {
    assert.equal(s.piano.ok, true, s.nome);
    assert.equal(s.ids.length, slot, `${s.nome}: ${s.ids.length} giocatori invece di ${slot}`);
    assert.ok(s.costo <= ctx.settings.budget, `${s.nome} sfora il budget`);
  }
});

test('i nomi delle strade sono distinti: tre "Con Lautaro" non sarebbero informazione', () => {
  const { scenari } = generaScenari({ ...ctx });
  assert.equal(new Set(scenari.map((s) => s.nome)).size, scenari.length);
});

test('le stelle sono relative alla migliore trovata, non al piano di partenza', () => {
  const { scenari, migliorabile } = generaScenari({ ...ctx });
  const migliore = scenari[0];
  assert.equal(migliore.stelle, 5, 'la prima strada vale cinque stelle');
  for (const s of scenari.slice(1)) assert.ok(s.stelle <= 5 && s.stelle >= 1);
  // Il piano corrente non e' per forza il migliore: il DP e' cieco alla sinergia e fa una
  // ripartenza sola, cercare le strade ne fa sei. Quando succede si deve poter dire.
  const attuale = scenari.find((s) => s.attuale);
  assert.ok(attuale, 'il piano attuale e\' sempre fra le strade');
  assert.equal(migliorabile, migliore.score > attuale.score);
});

test('stelle: mezzo punto ogni percento di punteggio perso, dentro 1 e 5', () => {
  assert.equal(stelle(100, 100), 5);
  assert.equal(stelle(98, 100), 4);
  assert.equal(stelle(96, 100), 3);
  assert.equal(stelle(50, 100), 1, 'non scende sotto una stella');
  assert.equal(stelle(120, 100), 5, 'non sale sopra cinque');
  assert.equal(stelle(100, 0), null);
});

test('i lucchetti non sono perni: quello che hai deciso di volere non si prova a toglierlo', () => {
  const piano = optimizeRoster({ ...ctx, ...CONFIG_SOLUTORE });
  const caro = piano.picks.slice().sort((a, b) => b.plannedPrice - a.plannedPrice)[0];
  const obbligati = new Set([caro.id]);
  const { scenari } = generaScenari({ ...ctx, obbligati });
  for (const s of scenari) {
    assert.ok(s.ids.includes(caro.id), `${s.nome} ha perso un giocatore bloccato`);
    assert.notEqual(s.perno?.id, caro.id);
  }
});

test('il nucleo copre la gran parte dei crediti con meno della meta\' dei giocatori', () => {
  const { scenari } = generaScenari({ ...ctx });
  for (const s of scenari) {
    const nucleo = nucleoScenario(s);
    const costo = nucleo.reduce((a, id) => a + s.prezzi[id], 0);
    assert.ok(nucleo.every((id) => s.ids.includes(id)), 'il nucleo e\' un sottoinsieme');
    assert.ok(costo >= s.costo * 0.8, `il nucleo copre solo ${costo} di ${s.costo}`);
    assert.ok(nucleo.length < s.ids.length, 'il nucleo non e\' tutta la rosa');
  }
});

test('una strada intatta e\' viva e sa quanto costa ancora', () => {
  const { scenari } = generaScenari({ ...ctx });
  const s = scenari[0];
  const v = valutaScenario({ scenario: s, ...ctx });
  assert.equal(v.stato, 'viva');
  assert.equal(v.persi.length, 0);
  assert.equal(v.liberi.length, s.ids.length);
  assert.equal(v.daSpendere, s.ids.reduce((a, id) => a + Math.max(1, Math.round(s.prezzi[id])), 0));
});

test('la perdita si misura in crediti, non in teste: il perno non vale come un riempitivo', () => {
  const { scenari } = generaScenari({ ...ctx });
  const s = scenari[0];
  const ordinati = s.ids.slice().sort((a, b) => s.prezzi[b] - s.prezzi[a]);
  const perno = ordinati[0];
  const riempitivo = ordinati[ordinati.length - 1];

  const senzaPerno = valutaScenario({ scenario: s, ...ctx, unavailable: new Set([perno]) });
  const senzaRiempitivo = valutaScenario({ scenario: s, ...ctx, unavailable: new Set([riempitivo]) });

  assert.equal(senzaPerno.stato, 'ferita');
  assert.equal(senzaPerno.persoInCrediti, s.prezzi[perno]);
  assert.ok(
    senzaPerno.quotaPersa > senzaRiempitivo.quotaPersa,
    'perdere il perno deve pesare piu\' che perdere un riempitivo'
  );
  assert.ok(senzaPerno.entrati.length, 'una strada ferita propone il sostituto');
});

test('una strada tutta comprata risulta completata', () => {
  const { scenari } = generaScenari({ ...ctx });
  const s = scenari[0];
  const owned = new Map(s.ids.map((id) => [id, Math.max(1, Math.round(s.prezzi[id]))]));
  const v = valutaScenario({ scenario: s, ...ctx, owned });
  assert.equal(v.stato, 'completata');
  assert.equal(v.persi.length, 0);
  assert.equal(v.liberi.length, 0);
});

test('una strada che non sta piu\' nel budget e\' chiusa, e lo dice', () => {
  const { scenari } = generaScenari({ ...ctx });
  const s = scenari[0];
  // Ho speso quasi tutto altrove: i giocatori della strada non ci stanno piu'.
  const fuoriStrada = ctx.players
    .filter((p) => !s.ids.includes(p.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const owned = new Map(fuoriStrada.map((p) => [p.id, 160]));
  const v = valutaScenario({ scenario: s, ...ctx, owned });
  assert.equal(v.stato, 'morta');
  assert.equal(v.costo, null);
  assert.match(descriviScenario(v), /Chiusa/);
});

test('un id che il listone non ha piu\' si segnala invece di sparire', () => {
  const { scenari } = generaScenari({ ...ctx });
  const s = { ...scenari[0], ids: [...scenari[0].ids, 'giocatore-inventato'] };
  const v = valutaScenario({ scenario: s, ...ctx });
  assert.deepEqual(v.mancanti, ['giocatore-inventato']);
});
