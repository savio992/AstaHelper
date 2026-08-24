import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { readXlsx, columnToIndex } from '../src/domain/xlsx.js';
import { sheetsToTable, gridToTable, autoMap, refineMapping, buildPlayers, mergeSources } from '../src/domain/csv.js';
import { inferTierOrder, annotateTierPct, annotatePmaShare, annotatePriceShare, defaultSettings, ROLES } from '../src/domain/model.js';
import { valuePlayers, expectedShare, clubExposure, concentrationPenalty, rosterScore } from '../src/domain/valuation.js';
import { withExpectedPrices, marketSignal } from '../src/domain/market.js';
import { optimizeRoster } from '../src/domain/optimizer.js';

// --- costruzione di un .xlsx minimo, per non dover allegare listoni veri ai test ---------

function zipFile(entries, { compress }) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = enc.encode(name);
    const raw = enc.encode(text);
    const data = compress ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32 ? zlib.crc32(raw) : crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(compress ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, Buffer.from(nameBytes), Buffer.from(data));

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(compress ? 8 : 0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, Buffer.from(nameBytes));
    offset += local.length + nameBytes.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...chunks, cdBuf, eocd]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const SHARED = ['Fascia', 'Ruolo', 'Team', 'Nome', 'Prezzo', 'Top', 'P', 'ROM', 'Svilar', 'D', 'INT', 'Dimarco', 'Terza', 'MIL', 'Gabbia'];
const si = (s) => SHARED.indexOf(s);

function sheetXml(rows) {
  const cells = (r, i) =>
    r
      .map((v, j) => {
        const ref = String.fromCharCode(65 + j) + (i + 1);
        return typeof v === 'number'
          ? `<c r="${ref}"><v>${v}</v></c>`
          : `<c r="${ref}" t="s"><v>${si(v)}</v></c>`;
      })
      .join('');
  return `<?xml version="1.0"?><worksheet><sheetData>${rows
    .map((r, i) => `<row r="${i + 1}">${cells(r, i)}</row>`)
    .join('')}</sheetData></worksheet>`;
}

function makeXlsx({ compress = true } = {}) {
  return zipFile(
    [
      ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
      [
        'xl/workbook.xml',
        '<?xml version="1.0"?><workbook><sheets><sheet name="P" sheetId="1" r:id="rId1"/><sheet name="D" sheetId="2" r:id="rId2"/></sheets></workbook>',
      ],
      [
        'xl/_rels/workbook.xml.rels',
        '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
      ],
      [
        'xl/sharedStrings.xml',
        `<?xml version="1.0"?><sst>${SHARED.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
      ],
      [
        'xl/worksheets/sheet1.xml',
        sheetXml([
          ['Fascia', 'Ruolo', 'Team', 'Nome', 'Prezzo'],
          ['Top', 'P', 'ROM', 'Svilar', 55],
        ]),
      ],
      [
        'xl/worksheets/sheet2.xml',
        sheetXml([
          ['Fascia', 'Ruolo', 'Team', 'Nome', 'Prezzo'],
          ['Top', 'D', 'INT', 'Dimarco', 75],
          ['Terza', 'D', 'MIL', 'Gabbia', 12],
        ]),
      ],
    ],
    { compress }
  );
}

// --- test ------------------------------------------------------------------------------

test('columnToIndex gestisce anche le colonne oltre la Z', () => {
  assert.equal(columnToIndex('A1'), 0);
  assert.equal(columnToIndex('Z9'), 25);
  assert.equal(columnToIndex('AA1'), 26);
  assert.equal(columnToIndex('AF12'), 31);
});

test('readXlsx legge fogli compressi con deflate', async () => {
  const sheets = await readXlsx(makeXlsx({ compress: true }));
  assert.deepEqual(sheets.map((s) => s.name), ['P', 'D']);
  assert.equal(sheets[1].grid.length, 3);
  assert.equal(sheets[1].grid[1][3], 'Dimarco');
  assert.equal(sheets[1].grid[1][4], '75');
});

test('readXlsx legge anche fogli non compressi', async () => {
  const sheets = await readXlsx(makeXlsx({ compress: false }));
  assert.equal(sheets[0].grid[1][3], 'Svilar');
});

test('readXlsx rifiuta un file che non e' + "'" + ' uno zip', async () => {
  const bad = new TextEncoder().encode('non sono un xlsx').buffer;
  await assert.rejects(() => readXlsx(bad), /non sembra un \.xlsx/);
});

test('i fogli per ruolo diventano un listone unico', async () => {
  const sheets = await readXlsx(makeXlsx());
  const table = sheetsToTable(sheets);
  assert.equal(table.rows.length, 3);
  const { players, warnings } = buildPlayers(table.rows, autoMap(table.headers), { source: 'test' });
  assert.equal(warnings.length, 0);
  assert.deepEqual(players.map((p) => p.role), ['P', 'D', 'D']);
  assert.equal(players[0].price, 55);
  assert.equal(players[0].sources[0], 'test');
});

test('il ruolo si deduce dal nome del foglio quando la colonna manca', () => {
  const table = sheetsToTable([
    { name: 'A', grid: [['Nome', 'Team'], ['Lautaro', 'INT']] },
  ]);
  const { players } = buildPlayers(table.rows, autoMap(table.headers));
  assert.equal(players.length, 1);
  assert.equal(players[0].role, 'A');
});

test('gridToTable ignora le righe completamente vuote', () => {
  const { headers, rows } = gridToTable([['Nome', 'Ruolo'], ['', ''], ['Rossi', 'A'], []]);
  assert.deepEqual(headers, ['Nome', 'Ruolo']);
  assert.equal(rows.length, 1);
});

test("l'ordine delle fasce si deduce dal prezzo, non dal nome", () => {
  const players = [
    { role: 'D', tier: 'SOPRA AI LOW COST', price: 8 },
    { role: 'D', tier: 'SUPER TOP', price: 70 },
    { role: 'D', tier: 'JOLLY 1a FASCIA', price: 25 },
    { role: 'D', tier: 'SUPER TOP', price: 60 },
    { role: 'D', tier: 'SOPRA AI LOW COST', price: 6 },
    { role: 'D', tier: 'JOLLY 1a FASCIA', price: 22 },
  ];
  assert.deepEqual(inferTierOrder(players, 'D'), ['SUPER TOP', 'JOLLY 1a FASCIA', 'SOPRA AI LOW COST']);
});

test('annotateTierPct rende confrontabili vocabolari di fasce diversi', () => {
  const a = annotateTierPct([
    { role: 'A', tier: 'Top', price: 100 },
    { role: 'A', tier: 'Terza', price: 30 },
    { role: 'A', tier: 'Outsider', price: 2 },
  ]);
  const b = annotateTierPct([
    { role: 'A', tier: 'SUPER TOP', price: 120 },
    { role: 'A', tier: 'FASCIA MEDIA', price: 30 },
    { role: 'A', tier: 'DA EVITARE', price: 1 },
  ]);
  assert.equal(a[0].tierPct, 0);
  assert.equal(b[0].tierPct, 0);
  assert.equal(a[2].tierPct, 1);
  assert.equal(b[2].tierPct, 1);
  assert.equal(a[1].tierPct, b[1].tierPct);
});

test('mergeSources fa la media fra creators e misura il disaccordo', () => {
  const uno = [{ id: 'x', name: 'Tizio', team: 'INT', role: 'A', tier: 'Top', tags: ['bonus'], notes: '', sources: ['Uno'], price: 100, fmvExp: 8, tierPct: 0 }];
  const due = [{ id: 'x', name: 'Tizio', team: 'INT', role: 'A', tier: 'SUPER TOP', tags: ['rigorista'], notes: '', sources: ['Due'], price: 150, fmvExp: 7.6, tierPct: 0 }];
  const [p] = mergeSources([uno, due]);
  assert.equal(p.price, 125);
  assert.ok(Math.abs(p.fmvExp - 7.8) < 1e-9);
  assert.deepEqual(p.tags.sort(), ['bonus', 'rigorista']);
  assert.equal(p.priceMin, 100);
  assert.equal(p.priceMax, 150);
  assert.ok(p.priceSpread > 0.39 && p.priceSpread < 0.41);
  assert.deepEqual(Object.keys(p.tiersBySource).sort(), ['Due', 'Uno']);
});

test('mergeSources con una sola fonte non cambia nulla', () => {
  const uno = [{ id: 'x', tags: [], sources: ['Uno'], price: 10, role: 'A' }];
  assert.equal(mergeSources([uno])[0].price, 10);
});

test('expectedShare traduce titolarita e integrita in frazione di stagione', () => {
  assert.ok(expectedShare({ titolarita: 5, integrita: 5 }) > 0.85);
  assert.ok(expectedShare({ titolarita: 1, integrita: 5 }) < 0.2);
  // Un titolare fragile gioca meno di un titolare integro.
  assert.ok(expectedShare({ titolarita: 5, integrita: 1 }) < expectedShare({ titolarita: 5, integrita: 5 }));
  // Senza giudizi si ripiega sulle presenze dell'anno prima.
  assert.ok(expectedShare({ matches: 36 }) > expectedShare({ matches: 8 }));
});

test('il valore misura i punti di stagione, quindi premia chi gioca di piu' + "'", () => {
  const settings = { ...defaultSettings(), participants: 10 };
  const base = { role: 'C', team: 'INT', tier: '', tags: [] };
  const roster = [
    { ...base, id: 'titolare', name: 'Titolare', fmvExp: 6.6, titolarita: 5, integrita: 5 },
    { ...base, id: 'rincalzo', name: 'Rincalzo', fmvExp: 6.7, titolarita: 1, integrita: 5 },
  ];
  // Serve un contorno per calcolare il livello di sostituzione.
  for (let i = 0; i < 120; i++) roster.push({ ...base, id: `f${i}`, name: `F${i}`, fmvExp: 6, titolarita: 2, integrita: 3 });
  const valued = valuePlayers(roster, settings);
  const titolare = valued.find((p) => p.id === 'titolare');
  const rincalzo = valued.find((p) => p.id === 'rincalzo');
  assert.ok(titolare.score > rincalzo.score * 2, 'chi gioca 35 partite vale piu' + "'" + ' di chi ne gioca 6');
});

test("l'esposizione a un club conta i titolari, non i riempitivi", () => {
  const settings = defaultSettings();
  const roster = [
    { id: '1', role: 'D', team: 'ROM', score: 200 },
    { id: '2', role: 'D', team: 'ROM', score: 180 },
    { id: '3', role: 'D', team: 'ROM', score: 170 },
    { id: '4', role: 'D', team: 'ROM', score: 5 },
    { id: '5', role: 'D', team: 'ROM', score: 4 },
    { id: '6', role: 'D', team: 'MIL', score: 150 },
    { id: '7', role: 'D', team: 'MIL', score: 3 },
    { id: '8', role: 'D', team: 'GEN', score: 2 },
  ];
  const exp = clubExposure(roster, settings);
  assert.equal(exp.get('ROM').inRosa, 5);
  // Tre titolari pieni piu' due panchinari che pesano poco.
  assert.ok(exp.get('ROM').effettivi > 2.9 && exp.get('ROM').effettivi < 3.6);
});

test('il tetto per club penalizza solo lo sforamento vero', () => {
  const roster = [
    { id: '1', role: 'D', team: 'ROM', score: 200 },
    { id: '2', role: 'D', team: 'ROM', score: 180 },
    { id: '3', role: 'D', team: 'ROM', score: 170 },
    { id: '4', role: 'D', team: 'ROM', score: 160 },
    { id: '5', role: 'D', team: 'ROM', score: 150 },
  ];
  const senzaTetto = { ...defaultSettings(), maxPerClub: 0 };
  const conTetto = { ...defaultSettings(), maxPerClub: 3 };
  assert.equal(concentrationPenalty(roster, senzaTetto), 0);
  assert.ok(concentrationPenalty(roster, conTetto) > 0);
  assert.ok(rosterScore(roster, conTetto) < rosterScore(roster, senzaTetto));
});

test('il tetto per club viene rispettato anche dalla ricerca locale', async () => {
  const sheets = [];
  const clubs = ['ROM', 'INT', 'MIL', 'NAP', 'ATA', 'LAZ', 'JUV', 'BOL', 'FIO', 'TOR'];
  const roster = [];
  for (const role of ROLES) {
    for (let i = 0; i < 40; i++) {
      // La Roma ha i giocatori migliori a ogni prezzo: senza tetto la rosa sarebbe tutta sua.
      const club = i % 3 === 0 ? 'ROM' : clubs[i % clubs.length];
      roster.push({
        id: `${role}${i}`, name: `${role}${i}`, team: club, role, tier: '', tags: [],
        fmvExp: 6 + (club === 'ROM' ? 1.2 : 0.6) * (1 - i / 40),
        titolarita: 5, integrita: 5, price: Math.max(1, 40 - i),
      });
    }
  }
  const settings = { ...defaultSettings(), maxPerClub: 3 };
  const players = withExpectedPrices(valuePlayers(roster, settings), settings);
  const plan = optimizeRoster({ players, settings });
  const exposure = clubExposure(plan.picks, settings);
  const roma = exposure.get('ROM');
  assert.ok(roma.effettivi <= 3.3, `esposizione alla Roma ${roma?.effettivi}`);
});

// --- prezzo di mercato contro valutazione del creator -----------------------------------

/** Due creators sullo stesso listone: uno prudente, uno generoso, stesso mercato osservato. */
function dueCreators() {
  const base = [
    { id: 'top', name: 'Top', team: 'INT', role: 'A', tier: 'Top', tags: [], notes: '' },
    { id: 'medio', name: 'Medio', team: 'MIL', role: 'A', tier: 'Terza', tags: [], notes: '' },
    { id: 'affare', name: 'Affare', team: 'ROM', role: 'A', tier: 'Terza', tags: [], notes: '' },
  ];
  // Prudente: valuta poco tutti. Generoso: valuta molto tutti. Sullo stesso ordine relativo,
  // tranne che entrambi ritengono "Affare" sottopagato dal mercato.
  const prudente = base.map((p, i) => ({ ...p, sources: ['prudente'], price: [100, 40, 40][i], pma: [20, 8, 4][i] }));
  const generoso = base.map((p, i) => ({ ...p, sources: ['generoso'], price: [300, 120, 120][i], pma: [21, 8, 4][i] }));
  const prep = (l) => annotatePriceShare(annotatePmaShare(l));
  return mergeSources([prep(prudente), prep(generoso)]);
}

test('le valutazioni dei creators si mediano per quota, non per valore grezzo', () => {
  const merged = dueCreators();
  const top = merged.find((p) => p.id === 'top');
  // La media grezza darebbe 200. Quello che conta e' la posizione relativa, identica
  // per i due creators: la quota mediata deve valere quanto quella di ciascuno.
  assert.equal(top.price, 200, 'il valore grezzo resta disponibile');
  assert.ok(Math.abs(top.priceShare - 100 / 180) < 1e-9, `quota ${top.priceShare}`);
});

test('la valutazione riportata sulla scala della lega non dipende dalla generosita' + "'" + ' del creator', () => {
  const settings = { ...defaultSettings(), participants: 2, slots: { P: 0, D: 0, C: 0, A: 3 }, starters: { P: 1, D: 1, C: 1, A: 3 } };
  const valued = withExpectedPrices(
    valuePlayers(dueCreators().map((p) => ({ ...p, fmvExp: 7, titolarita: 5, integrita: 5 })), settings),
    settings
  );
  const top = valued.find((p) => p.id === 'top');
  const affare = valued.find((p) => p.id === 'affare');
  // Il creator prudente dice 100 e il generoso 300: la scala comune deve stare in mezzo
  // in proporzione, non essere la media aritmetica dei due numeri.
  assert.ok(Number.isFinite(top.consigliato));
  assert.deepEqual(Object.keys(top.consigliatoBySource).sort(), ['generoso', 'prudente']);
  assert.equal(top.consigliatoBySource.prudente, top.consigliatoBySource.generoso,
    'stessa posizione relativa deve dare la stessa valutazione');
  // "Affare" e' pagato meno di quanto entrambi lo valutino: deve risultare un'occasione.
  assert.ok(affare.edge > 0, `scarto ${affare.edge}`);
  assert.ok(top.edge < affare.edge);
});

test('marketSignal non mescola quote e crediti', () => {
  // Un giocatore con la sola PMA e uno con il solo prezzo consigliato: le due colonne
  // hanno scale incompatibili e vanno riportate alla stessa unita' prima di confrontarle.
  const players = [];
  for (let i = 0; i < 10; i++) players.push({ id: `a${i}`, pmaShare: 0.05, price: 25 });
  players.push({ id: 'solo-prezzo', pmaShare: null, price: 25 });
  const signal = marketSignal(players);
  assert.ok(Math.abs(signal.get('solo-prezzo') - 0.05) < 1e-9,
    `chi ha solo il prezzo deve finire sulla stessa scala, non a ${signal.get('solo-prezzo')}`);
});

test('il prezzo atteso segue le aste reali, non la valutazione del creator', () => {
  const settings = { ...defaultSettings(), participants: 2, slots: { P: 0, D: 0, C: 0, A: 2 }, starters: { P: 1, D: 1, C: 1, A: 2 } };
  const roster = [
    // Stesso giudizio del creator, ma il primo nelle aste vere e' costato il doppio.
    { id: 'caro', name: 'Caro', team: 'INT', role: 'A', tier: 'Top', tags: [], sources: ['x'], price: 50, pma: 20, fmvExp: 7, titolarita: 5, integrita: 5 },
    { id: 'economico', name: 'Economico', team: 'MIL', role: 'A', tier: 'Top', tags: [], sources: ['x'], price: 50, pma: 10, fmvExp: 7, titolarita: 5, integrita: 5 },
    { id: 'terzo', name: 'Terzo', team: 'ROM', role: 'A', tier: 'Terza', tags: [], sources: ['x'], price: 10, pma: 5, fmvExp: 6, titolarita: 3, integrita: 3 },
  ];
  const players = withExpectedPrices(valuePlayers(annotatePriceShare(annotatePmaShare(roster)), settings), settings);
  const caro = players.find((p) => p.id === 'caro');
  const economico = players.find((p) => p.id === 'economico');
  assert.ok(caro.expectedPrice > economico.expectedPrice * 1.5,
    `atteso ${caro.expectedPrice} contro ${economico.expectedPrice}`);
  assert.ok(caro.edge < economico.edge, 'a parita' + "'" + ' di giudizio, chi costa di piu' + "'" + ' e' + "'" + ' l\'affare peggiore');
});
