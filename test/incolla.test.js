import test from 'node:test';
import assert from 'node:assert/strict';
import { leggiRiga, leggiElenco, chiave } from '../src/domain/incolla.js';

// Un listone in miniatura con i tranelli veri: omonimi, nomi abbreviati, accenti.
const LISTONE = [
  { id: 'p1', name: 'Svilar', team: 'Roma', role: 'P' },
  { id: 'p2', name: 'Maignan', team: 'Milan', role: 'P' },
  { id: 'd1', name: 'Dimarco', team: 'Inter', role: 'D' },
  { id: 'd2', name: 'Molina N.', team: 'Roma', role: 'D' },
  { id: 'c1', name: 'Paz N.', team: 'Como', role: 'C' },
  { id: 'c2', name: 'Martinez A.', team: 'Genoa', role: 'C' },
  { id: 'a1', name: 'Martinez L.', team: 'Inter', role: 'A' },
  { id: 'a2', name: 'Laurientè', team: 'Sassuolo', role: 'A' },
];

test('legge nome e prezzo da formati diversi', () => {
  assert.equal(leggiRiga('Svilar (Roma) - 45').nome, 'Svilar');
  assert.equal(leggiRiga('Svilar (Roma) - 45').prezzo, 45);
  assert.equal(leggiRiga('12; Dimarco; INT; 78').prezzo, 78);
  assert.equal(leggiRiga('Maignan\tMilan\t40').nome, 'Maignan');
  assert.equal(leggiRiga('  '), null);
});

test('ignora le sigle di ruolo e i numeri di riga', () => {
  const r = leggiRiga('3. P Svilar Roma 45');
  assert.match(chiave(r.nome), /svilar/);
  assert.equal(r.prezzo, 45);
});

test('una riga senza prezzo resta valida', () => {
  const r = leggiRiga('Dimarco');
  assert.equal(r.prezzo, null);
  assert.equal(r.nome, 'Dimarco');
});

test('abbina i nomi esatti e conta i prezzi', () => {
  const r = leggiElenco('Svilar 45\nDimarco 78\nPaz N. 82', LISTONE);
  assert.equal(r.conta.trovato, 3);
  assert.equal(r.conPrezzo, 3);
  assert.deepEqual(r.perRuolo, { P: 1, D: 1, C: 1, A: 0 });
});

test('la squadra scioglie i due Martinez', () => {
  const r = leggiElenco('Martinez Inter 150\nMartinez Genoa 12', LISTONE);
  assert.equal(r.conta.trovato, 2);
  assert.equal(r.esiti[0].player.id, 'a1');
  assert.equal(r.esiti[1].player.id, 'c2');
});

test('senza squadra un omonimo resta ambiguo invece di essere tirato a caso', () => {
  const r = leggiElenco('Martinez 150', LISTONE);
  assert.equal(r.conta.ambiguo, 1);
  assert.equal(r.esiti[0].candidati.length, 2);
});

test('gli accenti non contano', () => {
  const r = leggiElenco('Lauriente 24', LISTONE);
  assert.equal(r.conta.trovato, 1);
  assert.equal(r.esiti[0].player.id, 'a2');
});

test('un nome fuori listone viene segnalato, non ignorato', () => {
  const r = leggiElenco('Svilar 45\nGiocatore Inesistente 9', LISTONE);
  assert.equal(r.conta.trovato, 1);
  assert.equal(r.conta.sconosciuto, 1);
  assert.equal(r.esiti[1].nome, 'Giocatore Inesistente');
});

test('incollare due volte non riassegna niente', () => {
  const r = leggiElenco('Svilar 45\nSvilar 45', LISTONE);
  assert.equal(r.conta.trovato, 1);
  assert.equal(r.conta.duplicato, 1);
});

test('chi e\' gia\' stato registrato risulta duplicato', () => {
  const r = leggiElenco('Svilar 45', LISTONE, { gia: new Set(['p1']) });
  assert.equal(r.conta.duplicato, 1);
  assert.equal(r.conta.trovato, 0);
});

test('le sigle abbreviate della squadra funzionano', () => {
  const r = leggiElenco('Martinez L. INT 150', LISTONE);
  assert.equal(r.conta.trovato, 1);
  assert.equal(r.esiti[0].player.id, 'a1');
});
