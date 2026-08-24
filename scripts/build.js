// Compone l'app in un unico file HTML autosufficiente, senza bundler esterni.
//
// Concatenare i moduli in un ambito solo non funziona: quattro viste esportano tutte una
// funzione `render` e si sovrascriverebbero a vicenda. Ogni modulo diventa quindi una
// funzione immediata che restituisce i propri export, e gli import si trasformano in
// destrutturazioni dell'oggetto del modulo corrispondente.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = 'src/app.js';

const IMPORT_RE = /^[ \t]*import\s+([\s\S]*?)\s+from\s*['"](\.[^'"]+)['"];?[ \t]*$/gm;
const BARE_IMPORT_RE = /^[ \t]*import\s*['"](\.[^'"]+)['"];?[ \t]*$/gm;

function resolveSpec(fromFile, spec) {
  return path.normalize(path.join(path.dirname(fromFile), spec));
}

function moduleVar(file) {
  return '__m_' + file.replace(/[^a-zA-Z0-9]/g, '_');
}

function readModule(file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const deps = [];
  for (const m of source.matchAll(IMPORT_RE)) deps.push(resolveSpec(file, m[2]));
  for (const m of source.matchAll(BARE_IMPORT_RE)) deps.push(resolveSpec(file, m[1]));
  return { file, source, deps };
}

// Ordinamento topologico: un modulo si scrive dopo tutto cio' da cui dipende.
const modules = new Map();
const order = [];
const visiting = new Set();

function visit(file) {
  if (modules.has(file)) return;
  if (visiting.has(file)) throw new Error(`Dipendenza circolare su ${file}`);
  visiting.add(file);
  const mod = readModule(file);
  for (const dep of mod.deps) visit(dep);
  visiting.delete(file);
  modules.set(file, mod);
  order.push(file);
}

visit(ENTRY);

/** Nomi esportati da un modulo, in tutte le forme che il progetto usa. */
function exportedNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/^[ \t]*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of source.matchAll(/^[ \t]*export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of source.matchAll(/^[ \t]*export\s*\{([^}]*)\};?[ \t]*$/gm)) {
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(/\s+as\s+/);
      if (bits[0]) names.add((bits[1] || bits[0]).trim());
    }
  }
  return [...names];
}

/** Traduce gli import di un modulo in destrutturazioni degli oggetti gia' costruiti. */
function rewriteImports(file, source) {
  let out = source.replace(IMPORT_RE, (full, clause, spec) => {
    const target = moduleVar(resolveSpec(file, spec));
    const trimmed = clause.trim();
    const namespace = trimmed.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (namespace) return `const ${namespace[1]} = ${target};`;
    const named = trimmed.match(/^\{([\s\S]*)\}$/);
    if (named) {
      const parts = named[1]
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
          const as = p.split(/\s+as\s+/);
          return as.length === 2 ? `${as[0].trim()}: ${as[1].trim()}` : as[0].trim();
        });
      return parts.length ? `const { ${parts.join(', ')} } = ${target};` : '';
    }
    throw new Error(`Forma di import non gestita in ${file}: ${full.trim()}`);
  });
  out = out.replace(BARE_IMPORT_RE, (full, spec) => `void ${moduleVar(resolveSpec(file, spec))};`);
  return out;
}

/** Toglie la parola chiave export lasciando le dichiarazioni. */
function stripExportKeyword(source) {
  return source
    .replace(/^([ \t]*)export\s+(?=(?:async\s+)?function\s|const\s|let\s|var\s|class\s)/gm, '$1')
    .replace(/^[ \t]*export\s*\{[^}]*\};?[ \t]*$/gm, '');
}

const chunks = order.map((file) => {
  const { source } = modules.get(file);
  const names = exportedNames(source);
  const body = stripExportKeyword(rewriteImports(file, source));
  return `// ===== ${file} =====
const ${moduleVar(file)} = (() => {
${body}
return { ${names.join(', ')} };
})();`;
});

const js = `'use strict';\n${chunks.join('\n\n')}\n`;
const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
const html = fs
  .readFileSync(path.join(root, 'index.html'), 'utf8')
  .replace('<link rel="stylesheet" href="src/styles.css">', `<style>\n${css}\n</style>`)
  .replace('<script type="module" src="src/app.js"></script>', `<script type="module">\n${js}\n</script>`);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/index.html'), html);
console.log(`dist/index.html — ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, ${order.length} moduli`);

// Variante per la pubblicazione come pagina ospitata: solo il contenuto, senza
// doctype ne' tag html/head/body, che vengono aggiunti da chi la ospita.
const artifact = `<title>AstaHelper</title>
<style>
${css}
</style>
<main id="app"></main>
<nav class="tabbar" id="tabbar"></nav>
<script type="module">
${js}
<\/script>
`;
fs.writeFileSync(path.join(root, 'dist/artifact.html'), artifact);
console.log(`dist/artifact.html — ${(Buffer.byteLength(artifact) / 1024).toFixed(0)} KB`);
