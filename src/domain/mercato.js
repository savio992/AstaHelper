// Il conto del mercato: quanti giocatori restano davvero, e quanti crediti restano in giro.
//
// "Come fa l'algoritmo a sapere quanti giocatori sono rimasti?" Non lo stima: lo conta.
// In una lega da N squadre con S slot per ruolo verranno assegnati esattamente N*S giocatori
// di quel ruolo, ne' uno di piu'. Ogni assegnazione registrata scala il contatore, e quello
// che resta e' un numero esatto, non una previsione.
//
// Lo stesso vale per i soldi: nella stanza ci sono N*budget crediti e quelli spesi non
// tornano. Da queste due quantita' esatte discende tutto il resto, perche' il mercato deve
// chiudere: i crediti ancora in circolazione finiranno sui giocatori ancora in vendita, e su
// nessun altro. Se la stanza strapaga i primi, per i successivi restano meno soldi e i prezzi
// crollano; e' il meccanismo che a fine asta fa andare via tutti a un credito, e qui viene
// previsto invece che subito.

import { ROLES, ROLE_LABEL, totalSlots } from './model.js';

// Quanti crediti di mercato osservare prima di credere all'inflazione misurata.
// Con poche aggiudicazioni il rapporto pagato/atteso e' rumore puro.
const PRIOR_INFLAZIONE = 40;

// Limiti di sicurezza sul riscalamento: l'identita' contabile e' vera, ma con pochissimi slot
// residui e molti crediti darebbe cifre che nessuno pagherebbe davvero.
const LAMBDA_MIN = 0.2;
const LAMBDA_MAX = 4;

/** Accetta sia il vecchio formato (id -> prezzo) sia il nuovo (id -> {prezzo, di}). */
export function normalizeTaken(taken) {
  const out = new Map();
  const entries = taken instanceof Map ? [...taken.entries()] : Object.entries(taken || {});
  for (const [id, v] of entries) {
    if (v && typeof v === 'object') out.set(id, { price: Number(v.price) || 0, by: v.by ?? null });
    else out.set(id, { price: Number(v) || 0, by: null });
  }
  return out;
}

/** I nomi delle squadre della lega. La prima sono sempre io. */
export function nomiSquadre(settings) {
  const n = Math.max(1, settings.participants || 8);
  const dati = settings.squadre || [];
  const out = [];
  for (let i = 0; i < n; i++) out.push(dati[i] || (i === 0 ? 'Io' : `Squadra ${i + 1}`));
  return out;
}

/**
 * Lo stato del mercato: cosa e' gia' uscito, cosa resta, quanti crediti sono ancora in giro.
 *
 * Il conteggio degli slot e' esatto e non richiede di conoscere i prezzi: basta sapere chi e'
 * stato assegnato. Il conteggio dei crediti richiede i prezzi; per le assegnazioni registrate
 * senza prezzo si imputa il prezzo atteso e si segnala la copertura, cosi' l'assistente sa
 * quanto fidarsi dei propri numeri.
 */
export function statoMercato({ settings, players = [], owned = new Map(), taken = new Map() }) {
  const squadre = Math.max(1, settings.participants || 8);
  const budget = Math.max(1, settings.budget || 500);
  const rosa = totalSlots(settings);
  const byId = new Map(players.map((p) => [p.id, p]));
  const presi = normalizeTaken(taken);

  const slotTotali = {};
  const assegnati = {};
  const residui = {};
  const pagatiPerRuolo = {};
  const attesiPerRuolo = {};
  for (const role of ROLES) {
    slotTotali[role] = (settings.slots?.[role] || 0) * squadre;
    assegnati[role] = 0;
    pagatiPerRuolo[role] = 0;
    attesiPerRuolo[role] = 0;
  }

  const assegnatiIds = new Set();
  let spesaNota = 0;
  let spesaImputata = 0;
  let conPrezzo = 0;
  let senzaPrezzo = 0;

  const registra = (id, prezzo) => {
    assegnatiIds.add(id);
    const p = byId.get(id);
    const role = p?.role;
    if (role && role in assegnati) assegnati[role] += 1;
    const atteso = Math.max(1, Math.round(p?.expectedPrice ?? 1));
    if (prezzo > 0) {
      spesaNota += prezzo;
      conPrezzo += 1;
      if (role && role in pagatiPerRuolo) {
        pagatiPerRuolo[role] += prezzo;
        attesiPerRuolo[role] += atteso;
      }
    } else {
      // Assegnazione registrata al volo senza prezzo: si imputa la stima per non perdere
      // il conto dei crediti, ma la copertura scende e l'inflazione non ne tiene conto.
      spesaImputata += atteso;
      senzaPrezzo += 1;
    }
  };

  for (const [id, prezzo] of owned) registra(id, Number(prezzo) || 0);
  for (const [id, v] of presi) registra(id, v.price);

  let slotAssegnati = 0;
  let slotResidui = 0;
  for (const role of ROLES) {
    residui[role] = Math.max(0, slotTotali[role] - assegnati[role]);
    slotAssegnati += assegnati[role];
    slotResidui += residui[role];
  }

  const creditiTotali = squadre * budget;
  const spesi = spesaNota + spesaImputata;
  // Non si puo' scendere sotto un credito per slot ancora da riempire: e' incomprimibile.
  const creditiResidui = Math.max(slotResidui, creditiTotali - spesi);
  const discrezionali = Math.max(0, creditiResidui - slotResidui);

  const inflazione = {};
  for (const role of ROLES) {
    inflazione[role] = (pagatiPerRuolo[role] + PRIOR_INFLAZIONE) / (attesiPerRuolo[role] + PRIOR_INFLAZIONE);
  }
  let totPagati = 0;
  let totAttesi = 0;
  for (const role of ROLES) {
    totPagati += pagatiPerRuolo[role];
    totAttesi += attesiPerRuolo[role];
  }
  const inflazioneGlobale = (totPagati + PRIOR_INFLAZIONE) / (totAttesi + PRIOR_INFLAZIONE);
  // Il dato grezzo, senza prudenza: si mostra solo quando c'e' abbastanza mercato alle spalle.
  const osservata = totAttesi > 0 ? totPagati / totAttesi : null;

  const mieiCrediti = budget - [...owned.values()].reduce((a, b) => a + (Number(b) || 0), 0);
  const mieiSlot = rosa - owned.size;

  return {
    squadre,
    budget,
    rosa,
    slotTotali,
    assegnati,
    residui,
    slotAssegnati,
    slotResidui,
    slotTotaliLega: squadre * rosa,
    assegnatiIds,
    creditiTotali,
    creditiSpesi: spesi,
    creditiResidui,
    discrezionali,
    inflazione,
    inflazioneGlobale,
    osservata,
    aggiudicazioni: conPrezzo + senzaPrezzo,
    conPrezzo,
    senzaPrezzo,
    copertura: conPrezzo + senzaPrezzo > 0 ? conPrezzo / (conPrezzo + senzaPrezzo) : 1,
    // Abbastanza mercato osservato perche' l'inflazione misurata voglia dire qualcosa.
    affidabile: totAttesi >= PRIOR_INFLAZIONE,
    mieiCrediti,
    mieiSlot,
    // Il massimo che una singola squadra puo' ancora offrire su un giocatore, nel caso
    // peggiore in cui non abbia ancora speso nulla.
    tettoOfferta: Math.max(1, budget - (rosa - 1)),
  };
}

/**
 * I prezzi attesi aggiornati con quello che l'asta ha gia' detto.
 *
 * Due correzioni, in quest'ordine. La prima ridistribuisce fra i reparti: se in porta si sta
 * pagando il 30% sopra le stime, quel reparto vale di piu' di quanto diceva il listone. La
 * seconda rimette a posto il livello assoluto imponendo che la somma di quello che resta da
 * vendere faccia esattamente i crediti ancora disponibili: e' il vincolo che il mercato deve
 * rispettare per forza, ed e' quello che fa emergere da solo il momento delle occasioni.
 */
export function prezziLive(players, settings, mercato) {
  const base = (p) => Math.max(1, Math.round(p.expectedPrice ?? 1));
  const disponibili = players.filter((p) => !mercato.assegnatiIds.has(p.id));
  const aggiustato = (p) => 1 + (base(p) - 1) * (mercato.inflazione[p.role] ?? 1);

  // Chi verra' davvero venduto: per ogni ruolo i migliori tanti quanti sono gli slot residui.
  // Il criterio e' il punteggio, lo stesso con cui il modello statico decide chi finisce in
  // una rosa: usarne un altro qui farebbe muovere i prezzi gia' prima che l'asta cominci.
  const vendita = [];
  for (const role of ROLES) {
    const n = mercato.residui[role] || 0;
    if (n <= 0) continue;
    const pool = disponibili
      .filter((p) => p.role === role)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, n)
      .map((p) => aggiustato(p));
    vendita.push(...pool);
  }

  const somma = vendita.reduce((a, v) => a + Math.max(0, v - 1), 0);
  const grezzo = somma > 0 ? mercato.discrezionali / somma : 1;
  const lambda = Math.max(LAMBDA_MIN, Math.min(LAMBDA_MAX, grezzo));

  const prezzi = new Map();
  for (const p of players) {
    const live = 1 + Math.max(0, aggiustato(p) - 1) * lambda;
    prezzi.set(p.id, Math.max(1, Math.min(mercato.tettoOfferta, Math.round(live))));
  }
  return { prezzi, lambda: Math.round(lambda * 1000) / 1000, saturo: grezzo !== lambda };
}

/** Applica i prezzi live al listone, conservando la stima statica in `expectedPriceBase`. */
export function applyPrezziLive(players, settings, mercato) {
  const { prezzi, lambda } = prezziLive(players, settings, mercato);
  return players.map((p) => {
    const live = prezzi.get(p.id) ?? p.expectedPrice ?? 1;
    return {
      ...p,
      expectedPriceBase: p.expectedPriceBase ?? p.expectedPrice,
      expectedPrice: live,
      lambdaMercato: lambda,
      edge: p.consigliato === null || p.consigliato === undefined ? null : p.consigliato - live,
    };
  });
}

/**
 * Il tabellone degli avversari: quanto ha speso ciascuno, quanti slot gli restano per ruolo,
 * e soprattutto quanto puo' ancora offrire su un singolo giocatore.
 *
 * E' l'informazione piu' decisiva di tutta l'asta. Se il piu' ricco fra quelli che hanno
 * ancora bisogno di un attaccante puo' arrivare a 40, l'attaccante da 80 e' gia' mio a 41.
 */
export function avversari({ settings, players = [], owned = new Map(), taken = new Map() }) {
  const nomi = nomiSquadre(settings);
  const budget = Math.max(1, settings.budget || 500);
  const rosa = totalSlots(settings);
  const byId = new Map(players.map((p) => [p.id, p]));

  const squadre = nomi.map((nome, indice) => ({
    nome,
    indice,
    io: indice === 0,
    spesi: 0,
    presi: 0,
    perRuolo: { P: 0, D: 0, C: 0, A: 0 },
    rosaPresa: [],
  }));

  let nonAttribuiti = 0;
  let creditiNonAttribuiti = 0;

  const aggiungi = (indice, id, prezzo) => {
    const s = squadre[indice];
    if (!s) return;
    const p = byId.get(id);
    s.spesi += prezzo;
    s.presi += 1;
    if (p && p.role in s.perRuolo) s.perRuolo[p.role] += 1;
    if (p) s.rosaPresa.push({ ...p, pagato: prezzo });
  };

  for (const [id, prezzo] of owned) aggiungi(0, id, Number(prezzo) || 0);
  for (const [id, v] of normalizeTaken(taken)) {
    const p = byId.get(id);
    const prezzo = v.price > 0 ? v.price : Math.max(1, Math.round(p?.expectedPrice ?? 1));
    if (Number.isInteger(v.by) && v.by > 0 && v.by < squadre.length) aggiungi(v.by, id, prezzo);
    else {
      nonAttribuiti += 1;
      creditiNonAttribuiti += prezzo;
    }
  }

  for (const s of squadre) {
    s.residuo = budget - s.spesi;
    s.slotMancanti = Math.max(0, rosa - s.presi);
    // Deve lasciare un credito per ogni altro slot ancora da riempire.
    s.massimo = Math.max(0, s.residuo - Math.max(0, s.slotMancanti - 1));
    s.mancantiPerRuolo = {};
    for (const role of ROLES) s.mancantiPerRuolo[role] = Math.max(0, (settings.slots?.[role] || 0) - s.perRuolo[role]);
  }

  const venduti = normalizeTaken(taken).size;
  return {
    squadre,
    nonAttribuiti,
    creditiNonAttribuiti,
    venduti,
    attribuiti: venduti - nonAttribuiti,
    // Di quanto i tetti possono essere sovrastimati, in tutto.
    //
    // Un acquisto che non so a chi attribuire toglie dei crediti a un avversario senza che io
    // lo veda: il suo residuo calcolato e' piu' alto del vero. Ma non di quanto si crederebbe,
    // perche' non vedendolo conto anche una casella libera di troppo, e ogni casella libera
    // costa un credito. Il saldo per ogni acquisto non attribuito e' (prezzo - 1), mai negativo.
    //
    // Da qui la proprieta' che tiene in piedi tutto il resto: il tetto calcolato e' sempre
    // >= del tetto vero. Dire "nessuno puo' superare X" resta lecito anche con il tabellone
    // mezzo vuoto — X e' solo piu' alto del vero, mai piu' basso.
    scarto: Math.max(0, creditiNonAttribuiti - nonAttribuiti),
    attendibile: nonAttribuiti === 0,
  };
}

/**
 * Chi puo' ancora contendermi un giocatore di questo ruolo, e fino a quanto.
 * Un avversario che ha gia' riempito il reparto non e' un rivale, per quanti crediti abbia.
 */
export function concorrenza({ settings, players = [], owned = new Map(), taken = new Map(), role, tabellone = null }) {
  const board = tabellone || avversari({ settings, players, owned, taken });
  const rivali = board.squadre
    .filter((s) => !s.io && s.mancantiPerRuolo[role] > 0 && s.massimo >= 1)
    .sort((a, b) => b.massimo - a.massimo);
  return {
    ruolo: role,
    etichetta: ROLE_LABEL[role],
    quanti: rivali.length,
    massimo: rivali.length ? rivali[0].massimo : 0,
    ricchi: rivali.slice(0, 3),
    attendibile: board.attendibile,
    nonAttribuiti: board.nonAttribuiti,
    attribuiti: board.attribuiti,
    venduti: board.venduti,
    scarto: board.scarto,
    slotRivali: rivali.reduce((a, s) => a + s.mancantiPerRuolo[role], 0),
  };
}

/**
 * Il verdetto che conta quando parte il rilancio: posso vincerlo, e a quanto.
 * `mioMassimo` e' l'offerta di convenienza calcolata dall'ottimizzatore.
 */
export function verdettoConcorrenza({ mioMassimo, conc }) {
  if (!conc.quanti) {
    return { esito: 'nessuno', prezzo: 1, nota: null, testo: 'Nessun avversario ha ancora bisogno di questo ruolo: te lo prendi a 1.' };
  }

  // Il tabellone incompleto non fa tacere il verdetto.
  //
  // Per un anno intero questa funzione, davanti anche a un solo acquisto non attribuito, si
  // rifiutava di dare il numero. In un'asta vera capita entro il primo minuto: il consiglio
  // che nelle simulazioni valeva trecento crediti restava spento dall'inizio alla fine.
  //
  // Non serviva: i tetti calcolati sono limiti superiori (vedi `scarto` in avversari), quindi
  // "nessuno puo' superare X" e' vero comunque. Si dice il numero e si dice da dove viene.
  const nota = conc.attendibile
    ? null
    : `So a chi sono andati ${conc.attribuiti} giocatori su ${conc.venduti}: i tetti veri sono piu' bassi di questi, fino a ${conc.scarto} crediti in meno.`;

  if (conc.massimo < mioMassimo) {
    return {
      esito: 'tuo',
      prezzo: conc.massimo + 1,
      nota,
      testo: `Nessuno puo' superare ${conc.massimo}: e' tuo a ${conc.massimo + 1}, non offrire di piu'.`,
    };
  }
  const top = conc.ricchi[0];
  const secondo = conc.ricchi[1];
  const soli = conc.ricchi.filter((s) => s.massimo >= mioMassimo);
  return {
    esito: 'conteso',
    prezzo: null,
    nota,
    testo:
      soli.length === 1
        ? `Solo ${top.nome} puo' battere la tua offerta (fino a ${top.massimo}). Gli altri si fermano a ${secondo ? secondo.massimo : 0}.`
        : `${soli.length} avversari possono superarti, il piu' ricco fino a ${top.massimo}.`,
  };
}

/**
 * Quando chiamarlo, in un'asta in cui si puo' scegliere chi mettere all'incanto.
 * Un giocatore che voglio si chiama quando la stanza e' povera o sazia; quelli che non voglio
 * si chiamano finche' gli altri hanno crediti da bruciare.
 */
export function momentoGiusto({ settings, players, owned, taken, player, tabellone = null }) {
  const conc = concorrenza({ settings, players, owned, taken, role: player.role, tabellone });
  const atteso = Math.max(1, Math.round(player.expectedPrice ?? 1));
  if (!conc.quanti) return { chiama: true, testo: "Chiamalo: nessuno puo' contenderlo." };
  // Anche qui il tetto e' un limite superiore: se nemmeno il massimo arriva al prezzo di
  // mercato, a maggior ragione non ci arriva il residuo vero. Il consiglio regge lo stesso.
  if (conc.massimo < atteso) {
    return { chiama: true, testo: `Chiamalo ora: nessun avversario arriva al suo prezzo di mercato (${atteso}).` };
  }
  if (conc.quanti >= Math.max(2, Math.round((settings.participants || 8) / 2))) {
    return { chiama: false, testo: `Aspetta: ${conc.quanti} avversari hanno ancora crediti e slot per questo ruolo.` };
  }
  return { chiama: null, testo: null };
}

/**
 * La concorrenza su tutti e quattro i reparti in un colpo solo.
 * Serve al quadro d'insieme: prima di guardare il singolo giocatore conviene sapere
 * dove c'e' ancora battaglia e dove il campo si e' liberato.
 */
export function concorrenzaPerRuolo({ settings, players = [], owned = new Map(), taken = new Map(), tabellone = null }) {
  const board = tabellone || avversari({ settings, players, owned, taken });
  const out = {};
  for (const role of ROLES) out[role] = concorrenza({ settings, players, owned, taken, role, tabellone: board });
  return out;
}

/**
 * Quanti giocatori di ogni ruolo restano davvero comprabili, e quanti me ne mancano.
 *
 * Sono due conteggi diversi che e' facile confondere, ed e' il tipo di confusione che fa
 * sbagliare un'asta: gli slot ancora in palio dicono quanto mercato resta per tutti, i
 * giocatori liberi nel listone dicono fra quanti posso ancora scegliere io. In porta possono
 * restare due soli posti in palio e quaranta portieri disponibili: significa che quei due
 * posti sono miei e nessuno me li contende.
 */
export function disponibilita({ settings, players = [], owned = new Map(), mercato }) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const miei = { P: 0, D: 0, C: 0, A: 0 };
  for (const id of owned.keys()) {
    const p = byId.get(id);
    if (p && p.role in miei) miei[p.role] += 1;
  }
  const out = {};
  for (const role of ROLES) {
    const liberi = players.filter((p) => p.role === role && !mercato.assegnatiIds.has(p.id)).length;
    const servono = Math.max(0, (settings.slots?.[role] || 0) - miei[role]);
    out[role] = {
      role,
      liberi,
      inPalio: mercato.residui[role] || 0,
      servono,
      presi: miei[role],
      // Con meno giocatori liberi che slot da riempire non si chiude la rosa: e' l'unico
      // caso in cui la scarsita' e' un problema vero, e non capita quasi mai.
      critico: liberi <= servono,
    };
  }
  return out;
}
