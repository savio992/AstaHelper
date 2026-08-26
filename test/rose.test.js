import test from 'node:test';
import assert from 'node:assert/strict';

import { makeContext } from './helpers.js';
import { leggiRose, mappaColonne } from '../src/domain/rose.js';

// L'intestazione e la riga vere di un export di Fantalab, copiate carattere per carattere:
// fine riga CRLF, campi fra virgolette, numeri nudi, e nessun a capo finale. E' il formato che
// il lettore deve reggere, non quello che immagino io.
const VERO =
  'Squadra,Nome,Squadra_Appartenenza,Ruolo,Ruoli_Mantra,Prezzo,Quotazione,Quotazione_Mantra,Fantacalcio_Id\r\n' +
  '"Nome del tuo team","Svilar","ROM","P","Por",11,18,18,5841';

const ctx = () => makeContext({ projected: true, participants: 8, budget: 500 }, 11);

test('le colonne dell\'export vero vengono riconosciute, senza confondere le due "squadra"', () => {
  const headers = VERO.split('\r\n')[0].split(',');
  const col = mappaColonne(headers);
  assert.equal(col.squadra, 'Squadra', 'chi ha comprato');
  assert.equal(col.club, 'Squadra_Appartenenza', 'la squadra di serie A');
  assert.equal(col.nome, 'Nome');
  assert.equal(col.ruolo, 'Ruolo', 'e non Ruoli_Mantra');
  assert.equal(col.prezzo, 'Prezzo');
  assert.equal(col.quo, 'Quotazione');
});

test('un file senza le colonne che servono viene rifiutato dicendo cosa ha letto', () => {
  const { players } = ctx();
  const res = leggiRose('Pippo;Pluto\n1;2', players);
  assert.equal(res.ok, false);
  assert.match(res.motivo, /squadra|giocatore/i);
});

test('il file vero si legge: CRLF, virgolette e ultima riga senza a capo', () => {
  const { players } = ctx();
  // Il giocatore del file vero non sta nel listone sintetico: si aggiunge con lo stesso nome,
  // club e ruolo, per verificare che l'abbinamento diretto per id funzioni davvero.
  const conSvilar = [...players, { ...players.find((p) => p.role === 'P'), id: 'svilar|rom|P', name: 'Svilar', team: 'ROM', role: 'P', quo: 18 }];
  const res = leggiRose(VERO, conSvilar);
  assert.equal(res.ok, true);
  assert.deepEqual(res.squadre, ['Nome del tuo team']);
  assert.equal(res.righe.length, 1);
  const r = res.righe[0];
  assert.equal(r.esito, 'trovato');
  assert.equal(r.player.id, 'svilar|rom|P');
  assert.equal(r.prezzo, 11, 'il prezzo pagato, che e\' il dato che al tabellone manca');
  assert.equal(r.squadra, 'Nome del tuo team', 'e chi lo ha comprato, che e\' l\'altro');
});

/** Costruisce un export sintetico da un elenco di [squadra, giocatore, prezzo]. */
function esporta(voci) {
  const righe = voci.map(
    ([sq, p, prezzo]) => `"${sq}","${p.name}","${p.team}","${p.role}","${p.role}",${prezzo},${p.quo ?? 1},1,0`
  );
  return ['Squadra,Nome,Squadra_Appartenenza,Ruolo,Ruoli_Mantra,Prezzo,Quotazione,Quotazione_Mantra,Fantacalcio_Id', ...righe].join('\r\n');
}

test('otto squadre, ognuna con i suoi acquisti e i suoi prezzi', () => {
  const { players } = ctx();
  const nomi = ['Io', 'Marco', 'Luca', 'Giacomo', 'Paolo', 'Andrea', 'Ivan', 'Nico'];
  const scelti = players.slice(0, 24);
  const voci = scelti.map((p, i) => [nomi[i % 8], p, 5 + i]);
  const res = leggiRose(esporta(voci), players);

  assert.equal(res.ok, true);
  assert.equal(res.conta.trovato, 24, 'tutti riconosciuti');
  assert.deepEqual(res.squadre.slice().sort(), nomi.slice().sort(), 'e tutte le squadre trovate');
  for (let i = 0; i < 24; i++) {
    assert.equal(res.righe[i].squadra, nomi[i % 8]);
    assert.equal(res.righe[i].prezzo, 5 + i);
    assert.equal(res.righe[i].player.id, scelti[i].id);
  }
});

test('un nome che nel listone non c\'e\' viene detto, non abbinato a caso', () => {
  const { players } = ctx();
  const res = leggiRose(
    'Squadra,Nome,Squadra_Appartenenza,Ruolo,Prezzo\n"Marco","Sconosciutissimo","XXX","A",30',
    players
  );
  assert.equal(res.ok, true);
  assert.equal(res.righe[0].esito, 'sconosciuto');
  assert.equal(res.righe[0].player, null);
  assert.equal(res.conta.sconosciuto, 1);
});

test('due omonimi dello stesso club li scioglie il ruolo, che l\'incolla non aveva', () => {
  const { players } = ctx();
  // Stesso nome **e stesso club**: la squadra non basta a distinguerli, e senza il ruolo la riga
  // resterebbe ambigua. E' esattamente il segnale in piu' che l'export porta e il testo no.
  const dif = players.find((p) => p.role === 'D');
  const att = players.find((p) => p.role === 'A' && p.team === dif.team);
  assert.ok(att && dif && att.team === dif.team, 'il fixture deve avere due ruoli nello stesso club');
  const gemelli = players.map((p) => (p.id === dif.id || p.id === att.id ? { ...p, name: 'Rossi' } : p));

  const senzaRuolo = leggiRose(
    `Squadra,Nome,Squadra_Appartenenza,Prezzo\n"Marco","Rossi","${att.team}",30`,
    gemelli
  );
  assert.equal(senzaRuolo.righe[0].esito, 'ambiguo', 'senza il ruolo non si puo\' decidere');

  const conRuolo = leggiRose(
    `Squadra,Nome,Squadra_Appartenenza,Ruolo,Prezzo\n"Marco","Rossi","${att.team}","A",30`,
    gemelli
  );
  assert.equal(conRuolo.righe[0].esito, 'trovato');
  assert.equal(conRuolo.righe[0].player.id, att.id);
});

test('lo stesso giocatore due volte nel file si segnala invece di sovrascrivere', () => {
  const { players } = ctx();
  const p = players.find((x) => x.role === 'C');
  const res = leggiRose(esporta([['Marco', p, 20], ['Luca', p, 40]]), players);
  assert.equal(res.righe[0].esito, 'trovato');
  assert.equal(res.righe[1].esito, 'duplicato', 'la seconda attribuzione contraddice la prima');
  assert.equal(res.conta.duplicato, 1);
});
