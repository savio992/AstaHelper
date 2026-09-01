// Stima del prezzo a cui ogni giocatore verra' realmente pagato all'asta.
//
// Quando il listone porta i prezzi consigliati dai creators quelli sono il punto di
// partenza migliore: sono gia' calibrati sull'intero montepremi di una lega da dieci
// (la somma dei prezzi consigliati fa esattamente dieci volte il budget di squadra).
// Il compito del modello e' adattarli alla lega vera: piu' partecipanti significa piu'
// concorrenza sui top, e quindi prezzi piu' alti dove il giocatore e' unico.

import { ROLES, totalSlots } from './model.js';

/** Insieme dei giocatori che verranno davvero acquistati: gli altri restano sul mercato. */
function boughtSet(players, settings) {
  const n = Math.max(1, settings.participants || 10);
  const bought = new Set();
  for (const role of ROLES) {
    const need = (settings.slots[role] || 0) * n;
    players
      .filter((p) => p.role === role)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, need)
      .forEach((p) => bought.add(p.id));
  }
  return bought;
}

/**
 * Sceglie il segnale di mercato e lo restituisce in un'unica unita' di misura.
 *
 * Le fonti disponibili non sono confrontabili fra loro: PMA e' una quota (0,03), il prezzo
 * consigliato e' in crediti (155). Mescolarle nella stessa mappa fa esplodere le quote di chi
 * ha solo il prezzo. Si sceglie quindi una scala sola e si convertono gli altri valori in
 * quella, usando il rapporto osservato sui giocatori che hanno entrambi i dati.
 *
 * Ordine di attendibilita': PMA, il prezzo medio effettivamente pagato nelle altre aste, e'
 * una rilevazione; il prezzo consigliato dal creator e' una valutazione; la quotazione
 * ufficiale e' solo un ordine di grandezza.
 */
export function marketSignal(players) {
  const out = new Map();
  const hasPma = players.filter((p) => Number.isFinite(p.pmaShare) && p.pmaShare > 0);

  if (hasPma.length > players.length / 3) {
    // Rapporto mediano fra quota di mercato e prezzo consigliato, per convertire
    // i giocatori che hanno solo il secondo senza cambiare scala.
    const ratios = hasPma
      .filter((p) => Number.isFinite(p.price) && p.price > 0)
      .map((p) => p.pmaShare / p.price)
      .sort((a, b) => a - b);
    const ratio = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
    for (const p of players) {
      if (Number.isFinite(p.pmaShare) && p.pmaShare > 0) out.set(p.id, p.pmaShare);
      else if (ratio && Number.isFinite(p.price) && p.price > 0) out.set(p.id, p.price * ratio);
    }
    return out;
  }

  for (const p of players) {
    const v = p.price ?? p.fvm ?? p.quo ?? null;
    if (Number.isFinite(v) && v > 0) out.set(p.id, v);
  }
  return out;
}

function normalizeShares(raw, bought) {
  let sum = 0;
  for (const [id, v] of raw) if (bought.has(id)) sum += v;
  const out = new Map();
  if (sum <= 0) return out;
  for (const [id, v] of raw) out.set(id, v / sum);
  return out;
}

/**
 * Prezzo atteso per ogni giocatore.
 * Due forme possibili della distribuzione: quella dei creators (prezzi o PMA del listone)
 * e quella dedotta dai punteggi. L'impostazione `priceSource` sceglie quale usare.
 */
export function expectedPrices(players, settings) {
  const n = Math.max(1, settings.participants || 10);
  const budget = Math.max(1, settings.budget || 500);
  const slotsTotal = totalSlots(settings);
  const bought = boughtSet(players, settings);

  // Ogni squadra deve comunque riempire tutti gli slot: un credito a testa e' incomprimibile.
  const discretionary = Math.max(0, (budget - slotsTotal) * n);
  const maxPrice = Math.max(1, budget - (slotsTotal - 1));

  const listoneRaw = marketSignal(players);
  const hasListone = listoneRaw.size > players.length / 3;

  // I listini dei creator sono piu' piatti del mercato vero. Su un'asta reale a otto squadre
  // i primi otto giocatori hanno assorbito il 31% dei crediti; i tre creator a disposizione
  // ne prevedevano fra il 22% e il 29%, e i giocatori sopra i cento crediti sono andati in
  // media 25 crediti sopra la stima. Alzare tutte le quote a una potenza sopra uno sposta
  // crediti dalla coda alla testa lasciando invariato l'ordine.
  //
  // Da sola pero' non basta, anzi peggiora la cima: allarga la forbice fra i primi dove il
  // mercato la chiude, e Malen finiva a 234. Lavora insieme al tetto per singolo giocatore
  // qui sotto: con 1,25 e un terzo del budget l'errore medio sull'asta reale scende da 8,0 a
  // 7,1 crediti, quello sui primi otto attaccanti da 28 a 20, e la fascia sopra i cento passa
  // da −25 a −2. E' tarato su un'asta sola, e per questo e' un'impostazione e non una costante.
  const ripidita = Math.max(1, Math.min(2, Number(settings.ripidita) || 1.25));
  const listoneRipido = new Map();
  for (const [id, v] of listoneRaw) listoneRipido.set(id, Math.pow(Math.max(0, v), ripidita));

  // Forma "modello": i crediti si distribuiscono in proporzione al punteggio, con un
  // esponente che rappresenta quanto il mercato impenna sui migliori.
  const gamma = Math.max(0.5, Math.min(3, settings.aggressiveness ?? 1.55));
  const modelRaw = new Map();
  for (const p of players) modelRaw.set(p.id, Math.pow(Math.max(p.score || 0, 0.01), gamma));

  const listoneShare = normalizeShares(listoneRipido, bought);
  const modelShare = normalizeShares(modelRaw, bought);

  const source = settings.priceSource || 'blend';
  const useListone = hasListone && source !== 'model';
  const useModel = !hasListone || source !== 'listone';

  // Nessuna correzione arbitraria per la dimensione della lega: l'effetto vero e' gia' nel
  // modello, perche' con meno squadre si comprano meno giocatori e le quote si ridistribuiscono
  // su un insieme piu' ristretto e migliore. Un esponente in piu' conterebbe due volte lo stesso
  // fenomeno, e i dati a disposizione non permettono di calibrarlo: il confronto fra i campioni
  // di due creators e' confuso dalla diversa copertura del listone.
  const combined = new Map();
  for (const p of players) {
    const parts = [];
    if (useListone && listoneShare.has(p.id)) parts.push(listoneShare.get(p.id));
    if (useModel && modelShare.has(p.id)) parts.push(modelShare.get(p.id));
    if (!parts.length) {
      combined.set(p.id, 0);
      continue;
    }
    combined.set(p.id, parts.reduce((a, b) => a + b, 0) / parts.length);
  }

  // Il tetto per singolo giocatore.
  //
  // Il mercato comprime la cima. Nell'asta reale i primi cinque attaccanti sono andati tutti
  // fra 151 e 161 crediti — nessuno oltre un terzo del budget — mentre i listini li
  // distanziavano di molto (Malen 185, Kolo Muani 120) e la curva irripidita ancora di piu'
  // (234 contro 149). Con quei numeri Malen, che ha il punteggio piu' alto del listone,
  // sembrava fuori portata e il piano lo evitava; con i prezzi veri lo sceglie. Chi sfora il
  // tetto si ferma li', e i crediti che non spende vanno agli altri in proporzione.
  const tetto = Math.max(0.1, Math.min(1, Number(settings.tettoSingolo) || 0.33));
  const cap = Math.min(maxPrice, Math.max(1, Math.round(budget * tetto)));
  const fissi = new Set();
  const out = new Map();
  for (let giro = 0; giro < 30; giro++) {
    let total = 0;
    for (const [id, v] of combined) if (bought.has(id) && !fissi.has(id)) total += v;
    const residuo = discretionary - fissi.size * (cap - 1);
    let sforato = false;
    for (const p of players) {
      if (fissi.has(p.id)) {
        out.set(p.id, cap);
        continue;
      }
      const share = total > 0 && bought.has(p.id) ? combined.get(p.id) / total : 0;
      const price = 1 + Math.max(0, residuo) * share;
      if (price > cap) {
        fissi.add(p.id);
        sforato = true;
      }
      out.set(p.id, Math.min(cap, Math.max(1, Math.round(price))));
    }
    if (!sforato) break;
  }
  return out;
}

/**
 * Applica i prezzi attesi ai giocatori.
 *
 * Aggiunge anche `edge`: la differenza fra quanto il creator dice che il giocatore vale
 * (colonna Prezzo) e quanto il mercato lo paga davvero (PMA). Positivo significa che il
 * creator lo valuta piu' di quanto costa, ed e' li' che si fanno gli affari all'asta.
 */
export function withExpectedPrices(players, settings) {
  const prices = expectedPrices(players, settings);
  // La valutazione del creator va riportata sulla stessa scala del prezzo atteso prima di
  // poterli confrontare. Si usa la quota normalizzata per fonte, non il valore grezzo: un
  // creator generoso e uno prudente danno cifre diverse per lo stesso giocatore, ma la
  // posizione relativa dentro il proprio listone e' confrontabile.
  const signal = (p) => (Number.isFinite(p.priceShare) ? p.priceShare : null);
  let sumSignal = 0;
  let sumExpected = 0;
  for (const p of players) {
    if (signal(p) === null) continue;
    sumSignal += signal(p);
    sumExpected += prices.get(p.id) ?? 0;
  }
  const scale = sumSignal > 0 ? sumExpected / sumSignal : 0;

  return players.map((p) => {
    const expectedPrice = prices.get(p.id) ?? 1;
    const quota = signal(p);
    const consigliato = quota === null ? null : Math.max(1, Math.round(quota * scale));

    // La valutazione di ciascun creator, riportata sulla scala della lega: serve a vedere
    // se il consenso nasconde un disaccordo forte fra le due firme.
    let consigliatoBySource = null;
    if (p.bySource && scale > 0) {
      consigliatoBySource = {};
      for (const [src, v] of Object.entries(p.bySource)) {
        if (Number.isFinite(v.priceShare)) consigliatoBySource[src] = Math.max(1, Math.round(v.priceShare * scale));
      }
      if (!Object.keys(consigliatoBySource).length) consigliatoBySource = null;
    }

    return {
      ...p,
      expectedPrice,
      consigliato,
      consigliatoBySource,
      edge: consigliato === null ? null : consigliato - expectedPrice,
    };
  });
}
