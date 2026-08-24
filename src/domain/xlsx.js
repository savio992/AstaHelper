// Lettore .xlsx minimale e senza dipendenze: apre lo zip con DecompressionStream
// e legge i fogli con una scansione mirata dell'XML.
// I listoni dei creators arrivano come xlsx con un foglio per ruolo: chiedere all'utente
// di convertirli in CSV sul telefono sarebbe una barriera assurda.

const EOCD_SIG = 0x06054b50;

function findEocd(view) {
  const max = Math.min(view.byteLength, 66000);
  for (let i = 22; i <= max; i++) {
    const off = view.byteLength - i;
    if (off < 0) break;
    if (view.getUint32(off, true) === EOCD_SIG) return off;
  }
  return -1;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error("Questo browser non sa aprire i file .xlsx: esporta il listone in CSV.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Estrae i file di uno zip. Ritorna una mappa nome -> Uint8Array. */
export async function unzip(arrayBuffer, wanted = null) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('File non valido: non sembra un .xlsx.');

  const count = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const out = new Map();
  const decoder = new TextDecoder();

  for (let i = 0; i < count; i++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) break;
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOff = view.getUint32(ptr + 42, true);
    const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;

    if (wanted && !wanted(name)) continue;
    if (view.getUint32(localOff, true) !== 0x04034b50) continue;
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compSize);
    out.set(name, method === 0 ? raw : await inflateRaw(raw));
  }
  return out;
}

const decoder = new TextDecoder();

function unescapeXml(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, g) => {
    switch (g) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default:
        return g[0] === '#'
          ? String.fromCodePoint(g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10))
          : m;
    }
  });
}

/** Testo di tutti i <t> dentro un frammento, concatenato (i testi ricchi sono spezzati in run). */
function textOf(fragment) {
  let out = '';
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(fragment))) out += unescapeXml(m[1]);
  return out;
}

function parseSharedStrings(buf) {
  if (!buf) return [];
  const xml = decoder.decode(buf);
  const out = [];
  const re = /<si[^>]*>([\s\S]*?)<\/si>|<si[^>]*\/>/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1] ? textOf(m[1]) : '');
  return out;
}

export function columnToIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Legge un foglio in una griglia di stringhe. */
function parseSheet(buf, shared) {
  const xml = decoder.decode(buf);
  const grid = [];
  const rowRe = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml))) {
    const cells = [];
    let cellMatch;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowMatch[2]))) {
      const attrs = cellMatch[1] || '';
      const body = cellMatch[2] || '';
      const refMatch = attrs.match(/\br="([A-Z]+)\d+"/);
      if (!refMatch) continue;
      const col = columnToIndex(refMatch[1]);
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1];
      let value = '';
      if (type === 'inlineStr') value = textOf(body);
      else {
        const v = body.match(/<v[^>]*>([\s\S]*?)<\/v>/);
        if (v) {
          const raw = unescapeXml(v[1]);
          value = type === 's' ? shared[Number(raw)] ?? '' : raw;
        }
      }
      cells[col] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    grid.push(cells);
  }
  return grid;
}

function parseWorkbook(buf) {
  if (!buf) return [];
  const xml = decoder.decode(buf);
  const out = [];
  const re = /<sheet\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const name = unescapeXml((attrs.match(/\bname="([^"]*)"/) || [])[1] || '');
    const rid = (attrs.match(/r:id="([^"]+)"/) || [])[1] || '';
    if (name) out.push({ name, rid });
  }
  return out;
}

function parseRels(buf) {
  const map = new Map();
  if (!buf) return map;
  const xml = decoder.decode(buf);
  const re = /<Relationship\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const id = (m[1].match(/Id="([^"]+)"/) || [])[1];
    const target = (m[1].match(/Target="([^"]+)"/) || [])[1];
    if (id && target) map.set(id, target.replace(/^\/?xl\//, '').replace(/^\.\//, ''));
  }
  return map;
}

/**
 * Legge un .xlsx e restituisce i fogli come griglie di stringhe.
 * Ritorna [{ name, grid }] nell'ordine del file.
 */
export async function readXlsx(arrayBuffer) {
  const files = await unzip(arrayBuffer, (n) => n.startsWith('xl/') || n === '[Content_Types].xml');
  const shared = parseSharedStrings(files.get('xl/sharedStrings.xml'));
  const rels = parseRels(files.get('xl/_rels/workbook.xml.rels'));
  const declared = parseWorkbook(files.get('xl/workbook.xml'));

  const sheets = [];
  for (const { name, rid } of declared) {
    const target = rels.get(rid);
    const buf = (target && files.get(`xl/${target}`)) || null;
    if (buf) sheets.push({ name, grid: parseSheet(buf, shared) });
  }
  if (!sheets.length) {
    // Nessuna relazione leggibile: ripieghiamo sull'ordine dei file dei fogli.
    const names = [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
    names.forEach((n, i) => sheets.push({ name: `Foglio ${i + 1}`, grid: parseSheet(files.get(n), shared) }));
  }
  return sheets;
}
