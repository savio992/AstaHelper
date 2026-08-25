// L'assistente d'asta: quanto posso offrire davvero, e chi prendo se questo giocatore me lo soffiano.

import { ROLES, ROLE_LABEL, tierKey, totalSlots, elenco } from './model.js';
import { expectedShare, depthWeights, sortByStrength } from './valuation.js';
import { optimizeRoster, creditShadowPrice, CONFIG_SOLUTORE } from './optimizer.js';

/**
 * Impostazioni per i ricalcoli in tempo reale durante l'asta.
 *
 * Qui c'era una scorciatoia che costava carissimo: saltando la ricerca locale il solutore si
 * fermava a una rosa peggiore del 3,4% e l'offerta massima ne usciva sbagliata fino al 50%, in
 * entrambe le direzioni — su un listone vero diceva di lasciar perdere un giocatore che valeva
 * ottantatre crediti e di arrivare a centottantotto per uno che ne valeva centoventitre'.
 *
 * La ricerca locale e' indispensabile. Il pruning invece non cambia mai il risultato e a
 * conti fatti rallenta, perche' il tempo che risparmia nella programmazione dinamica lo
 * ributta dentro la ricerca locale: senza, si sta fra i 66 e gli 86 millisecondi contro
 * gli 82-153 di prima.
 */
export const CONFIG_ASTA = CONFIG_SOLUTORE;
const FAST = CONFIG_ASTA;

/** Tetto tecnico: devo lasciare almeno 1 credito per ogni slot ancora da riempire. */
export function maxSpendableNow(settings, owned) {
  const spent = [...owned.values()].reduce((a, b) => a + b, 0);
  const slotsLeft = totalSlots(settings) - owned.size;
  return Math.max(0, (settings.budget || 500) - spent - Math.max(0, slotsLeft - 1));
}

export function slotsLeftByRole(settings, players, owned) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const used = { P: 0, D: 0, C: 0, A: 0 };
  for (const id of owned.keys()) {
    const p = byId.get(id);
    if (p) used[p.role]++;
  }
  const out = {};
  for (const role of ROLES) out[role] = Math.max(0, (settings.slots[role] || 0) - used[role]);
  return out;
}

/**
 * In che reparto siamo, in un'asta a chiamata per ruolo.
 * E' il primo reparto dell'ordine che ha ancora slot da riempire.
 */
export function faseCorrente(settings, players, owned) {
  const ordine = settings.auctionOrder?.length ? settings.auctionOrder : ROLES;
  const mancanti = slotsLeftByRole(settings, players, owned);
  return ordine.find((r) => mancanti[r] > 0) ?? null;
}

/**
 * Quanto posso davvero spendere adesso, in un'asta che procede per reparti.
 *
 * Il tetto tecnico (un credito per ogni slot rimasto) non basta quando i reparti si comprano
 * in sequenza: chi spende duecento crediti in porta arriva all'attacco senza niente, e a quel
 * punto non c'e' piano che tenga. Qui si mette da parte quello che il piano ha destinato ai
 * reparti che verranno dopo, e si guarda quanto resta per quello in corso.
 */
export function budgetDiFase({ settings, players, owned, plan, role = null }) {
  const ordine = settings.auctionOrder?.length ? settings.auctionOrder : ROLES;
  const fase = role || faseCorrente(settings, players, owned) || ordine[ordine.length - 1];
  const indice = ordine.indexOf(fase);
  const mancanti = slotsLeftByRole(settings, players, owned);
  const speso = [...owned.values()].reduce((a, b) => a + b, 0);
  const residuo = (settings.budget || 500) - speso;

  // Quanto il piano prevede ancora di spendere nei reparti successivi.
  let riservatoDopo = 0;
  for (let i = indice + 1; i < ordine.length; i++) {
    const r = ordine[i];
    const dalPiano = (plan?.picks || []).filter((p) => p.role === r).reduce((a, p) => a + p.plannedPrice, 0);
    // Anche senza piano si tiene almeno un credito per slot.
    riservatoDopo += Math.max(dalPiano, mancanti[r]);
  }

  const perLaFase = Math.max(0, residuo - riservatoDopo);
  const pianificatoFase = (plan?.picks || []).filter((p) => p.role === fase).reduce((a, p) => a + p.plannedPrice, 0);
  const spesoFase = [...owned.entries()].reduce((a, [id, prezzo]) => {
    const p = players.find((x) => x.id === id);
    return a + (p && p.role === fase ? prezzo : 0);
  }, 0);

  return {
    fase,
    etichetta: ROLE_LABEL[fase],
    slotMancanti: mancanti[fase],
    residuo,
    riservatoDopo,
    perLaFase,
    pianificatoFase,
    spesoFase,
    // Massimo su un singolo giocatore adesso: lascia un credito per gli altri slot del reparto.
    massimoOra: Math.max(0, perLaFase - Math.max(0, mancanti[fase] - 1)),
  };
}

/**
 * Offerta massima di convenienza per un giocatore.
 * E' il prezzo oltre il quale la rosa che ottengo prendendolo vale meno della rosa
 * che ottengo lasciandolo andare e ridistribuendo i crediti. Il vero limite dell'asta.
 */
export function maxBid({ players, settings, owned = new Map(), unavailable = new Set(), obbligati = new Set(), playerId }) {
  const hard = maxSpendableNow(settings, owned);
  if (hard < 1) return { maxBid: 0, planB: null, reason: 'Crediti esauriti per i vincoli di rosa.' };

  const withoutSet = new Set(unavailable);
  withoutSet.add(playerId);
  const senzaVincolo = new Set([...obbligati].filter((id) => id !== playerId));
  const planB = optimizeRoster({ players, settings, owned, unavailable: withoutSet, ...FAST, obbligati: senzaVincolo });
  if (!planB.ok) {
    // Se senza di lui non esiste una rosa valida, e' incedibile: si arriva al tetto tecnico.
    return { maxBid: hard, planB, hard, breakEven: hard, reason: 'Senza di lui non chiudi la rosa.' };
  }

  const scoreAt = (price) => {
    const o = new Map(owned);
    o.set(playerId, price);
    const plan = optimizeRoster({ players, settings, owned: o, unavailable, ...FAST, obbligati });
    return plan.ok ? plan.score : -Infinity;
  };

  if (scoreAt(1) < planB.score) {
    return { maxBid: 0, planB, hard, breakEven: 0, reason: 'Non migliora la rosa nemmeno a 1 credito.' };
  }

  // Ricerca binaria del punto di pareggio: il prezzo piu' alto che conviene ancora.
  //
  // Partire da tutto il budget spendibile costa una decina di risoluzioni complete, e quasi
  // sempre inutilmente: il pareggio sta a ridosso del prezzo di mercato. Si parte da un
  // intervallo stretto attorno a quello e lo si allarga solo se serve davvero, cosi' il caso
  // normale costa la meta' e quello raro non perde niente in precisione.
  const target = players.find((x) => x.id === playerId);
  const mercato = Math.max(1, Math.round(target?.expectedPrice ?? 1));
  let lo = 1;
  let hi = Math.min(hard, Math.max(mercato * 2, mercato + 30));
  while (hi < hard && scoreAt(hi) >= planB.score) {
    lo = hi;
    hi = Math.min(hard, hi * 2);
  }
  if (hi >= hard && scoreAt(hard) >= planB.score) {
    return { maxBid: hard, planB, hard, breakEven: hard, reason: 'Conviene fino al tetto tecnico.' };
  }
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (scoreAt(mid) >= planB.score) lo = mid;
    else hi = mid;
  }
  return { maxBid: lo, planB, hard, breakEven: lo, reason: null };
}

/**
 * Le migliori alternative a un giocatore che sto perdendo.
 * Non cerca "il piu' simile": ricalcola la rosa intera assumendo di averlo perso e
 * misura quanto vale ogni possibile sostituto nel piano che ne risulta.
 */
export function alternatives({
  players,
  settings,
  owned = new Map(),
  unavailable = new Set(),
  obbligati = new Set(),
  playerId,
  limit = 5,
  shortlist = 10,
}) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const target = byId.get(playerId);
  if (!target) return { alternatives: [], planB: null };

  const withoutSet = new Set(unavailable);
  withoutSet.add(playerId);
  const senzaVincolo = new Set([...obbligati].filter((id) => id !== playerId));
  const planB = optimizeRoster({ players, settings, owned, unavailable: withoutSet, ...FAST, obbligati: senzaVincolo });
  const planWith = (() => {
    const o = new Map(owned);
    o.set(playerId, Math.max(1, Math.round(target.expectedPrice ?? 1)));
    return optimizeRoster({ players, settings, owned: o, unavailable, ...FAST, obbligati });
  })();

  const budgetNow = maxSpendableNow(settings, owned);
  const lambda = creditShadowPrice(planB.budgetCurve, planB.budgetLeft ?? budgetNow);

  // Pre-selezione economica: valore netto dei crediti spesi. Poi valutazione esatta dei migliori.
  const pool = players
    .filter(
      (p) =>
        p.role === target.role &&
        p.id !== playerId &&
        !owned.has(p.id) &&
        !unavailable.has(p.id) &&
        Math.round(p.expectedPrice ?? 1) <= budgetNow
    )
    .map((p) => ({ p, net: (p.score || 0) - lambda * Math.max(1, Math.round(p.expectedPrice ?? 1)) }))
    .sort((a, b) => b.net - a.net)
    .slice(0, shortlist);

  const inPlanB = planB.ok ? new Set(planB.picks.map((x) => x.id)) : new Set();

  const results = [];
  for (const { p } of pool) {
    const price = Math.max(1, Math.round(p.expectedPrice ?? 1));
    if (price > budgetNow) continue;
    // Chi e' gia' scelto dal piano B al suo prezzo atteso da' esattamente il piano B: forzarlo
    // dentro non cambia una virgola. Risolvere di nuovo costerebbe un'ottimizzazione intera per
    // riottenere lo stesso identico risultato, ed erano la maggioranza dei candidati.
    const plan = inPlanB.has(p.id)
      ? planB
      : optimizeRoster({ players, settings, owned: new Map([...owned, [p.id, price]]), unavailable: withoutSet, ...FAST, obbligati });
    if (!plan.ok) continue;
    results.push({
      player: p,
      price,
      score: plan.score,
      // Se e' gia' fra gli obiettivi della rosa senza il giocatore perso, non e' un'alternativa:
      // quello lo prendi comunque, e proporlo come sostituto fa credere a uno scambio che non
      // esiste. Perdere un attaccante da centosessanta e sentirsi rispondere "prendi quello da
      // ventiquattro" e' esattamente questo caso: quello da ventiquattro era gia' in rosa.
      giaNelPiano: inPlanB.has(p.id),
      // Quanto perdo (o guadagno) rispetto ad avere il giocatore che sto perdendo al suo prezzo atteso.
      deltaVsTarget: planWith.ok ? Math.round((plan.score - planWith.score) * 10) / 10 : null,
      // Quanto guadagno rispetto a non fare nulla e ridistribuire i crediti.
      deltaVsPlanB: planB.ok ? Math.round((plan.score - planB.score) * 10) / 10 : null,
      inPlanB: planB.ok ? planB.picks.some((x) => x.id === p.id) : false,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return {
    alternatives: results.slice(0, limit),
    planB,
    planWith,
    lambda: Math.round(lambda * 1000) / 1000,
  };
}

/** Differenza fra due piani: chi entra e chi esce. */
export function planDiff(before, after) {
  const a = new Map((before?.picks || []).map((p) => [p.id, p]));
  const b = new Map((after?.picks || []).map((p) => [p.id, p]));
  const removed = [...a.values()].filter((p) => !b.has(p.id));
  const added = [...b.values()].filter((p) => !a.has(p.id));
  return { added, removed };
}

/**
 * Budget pianificato per ruolo e per fascia, piu' quanto ho gia' speso davvero.
 * E' la bussola che mi tiene dentro il piano durante l'asta.
 */
export function tierBudgetReport({ plan, settings, players, owned = new Map() }) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const rows = new Map();

  const touch = (role, tier) => {
    const key = tierKey(role, tier);
    if (!rows.has(key)) rows.set(key, { key, role, tier: tier || '—', planned: 0, plannedCount: 0, spent: 0, spentCount: 0 });
    return rows.get(key);
  };

  for (const p of plan?.picks || []) {
    const row = touch(p.role, p.tier);
    row.planned += p.plannedPrice || 0;
    row.plannedCount += 1;
  }
  for (const [id, price] of owned) {
    const p = byId.get(id);
    if (!p) continue;
    const row = touch(p.role, p.tier);
    row.spent += price;
    row.spentCount += 1;
    // Un giocatore gia' preso fa parte del piano a tutti gli effetti.
    row.planned += price;
    row.plannedCount += 1;
  }

  const list = [...rows.values()];
  const roleOrder = { P: 0, D: 1, C: 2, A: 3 };
  list.sort((a, b) => {
    if (roleOrder[a.role] !== roleOrder[b.role]) return roleOrder[a.role] - roleOrder[b.role];
    const oa = settings.tierOrder?.[a.role]?.indexOf(a.tier) ?? 99;
    const ob = settings.tierOrder?.[b.role]?.indexOf(b.tier) ?? 99;
    return (oa < 0 ? 99 : oa) - (ob < 0 ? 99 : ob);
  });
  return list;
}

/**
 * Il piano d'azione del reparto in corso.
 *
 * Non basta sapere chi voglio: durante la chiamata serve gia' deciso fin dove arrivo e cosa
 * faccio se salta, perche' quei dieci secondi non bastano a ricalcolare niente. Qui il ramo e'
 * pronto prima: obiettivo, tetto, primo ripiego, secondo ripiego. E in fondo lo scenario nero,
 * quello in cui saltano tutti gli obiettivi del reparto, con la destinazione dei crediti.
 */
export function pianoDiReparto({ players, settings, owned = new Map(), unavailable = new Set(), obbligati = new Set(), plan, role = null, rami = 2 }) {
  const fase = role || faseCorrente(settings, players, owned);
  if (!fase) return null;
  const budget = budgetDiFase({ settings, players, owned, plan, role: fase });
  const args = { players, settings, owned, unavailable, obbligati };

  const scelti = (plan?.picks || [])
    .filter((p) => p.role === fase)
    .sort((a, b) => b.plannedPrice - a.plannedPrice)
    .slice(0, 4);
  // Un altro obiettivo dello stesso reparto non e' un ripiego: lo sto gia' cercando comunque.
  const altriObiettivi = new Set(scelti.map((p) => p.id));

  const obiettivi = scelti.map((p) => {
    const { maxBid: tetto } = maxBid({ ...args, playerId: p.id });
    const { alternatives: alt } = alternatives({ ...args, playerId: p.id, limit: rami + altriObiettivi.size });
    return {
      player: p,
      prezzoPiano: p.plannedPrice,
      massimo: tetto,
      // Il piano lo compra al prezzo di mercato, ma il pareggio dice di meno: significa che
      // il primo che capita fa quasi lo stesso, e su di lui non vale la pena rilanciare.
      sostituibile: tetto < p.plannedPrice,
      ripieghi: alt
        .filter((a) => !altriObiettivi.has(a.player.id))
        .slice(0, rami)
        .map((a) => ({ player: a.player, price: a.price, delta: a.deltaVsTarget })),
    };
  });

  // Scenario nero: saltano tutti gli obiettivi del reparto.
  let senzaNessuno = null;
  if (obiettivi.length) {
    const persi = new Set(unavailable);
    for (const o of obiettivi) persi.add(o.player.id);
    const dopo = optimizeRoster({ players, settings, owned, unavailable: persi, ...FAST, obbligati });
    if (dopo.ok) {
      const nuovi = dopo.picks.filter((p) => p.role === fase).sort((a, b) => b.plannedPrice - a.plannedPrice).slice(0, 3);
      const spesaPrima = (plan?.picks || []).filter((p) => p.role === fase).reduce((a, p) => a + p.plannedPrice, 0);
      const spesaDopo = dopo.picks.filter((p) => p.role === fase).reduce((a, p) => a + p.plannedPrice, 0);
      senzaNessuno = {
        picks: nuovi,
        spesaPrima,
        spesaDopo,
        liberati: spesaPrima - spesaDopo,
        costo: plan?.ok ? Math.round((plan.score - dopo.score) * 10) / 10 : null,
        // Dove finiscono i crediti risparmiati.
        destinazione: ROLES.filter((r) => r !== fase)
          .map((r) => ({
            role: r,
            delta:
              dopo.picks.filter((p) => p.role === r).reduce((a, p) => a + p.plannedPrice, 0) -
              (plan?.picks || []).filter((p) => p.role === r).reduce((a, p) => a + p.plannedPrice, 0),
          }))
          .filter((d) => d.delta > 2)
          .sort((a, b) => b.delta - a.delta),
      };
    }
  }

  return { fase, etichetta: ROLE_LABEL[fase], budget, obiettivi, senzaNessuno };
}

/**
 * L'abbinamento dei portieri, il consiglio che i creators ripetono a ogni guida.
 *
 * In Classic se ne schiera uno solo ma se ne possiedono tre: il secondo non serve a giocare,
 * serve a non restare mai senza. Prenderlo nella stessa squadra del titolare significa che
 * qualunque cosa succeda in quella porta il voto arriva, e con l'imbattibilita' arriva anche
 * il clean sheet della stessa difesa su cui si e' investito.
 */
export function abbinamentoPortiere({ players, settings, plan, owned = new Map(), unavailable = new Set() }) {
  if (!plan?.ok) return null;
  const miei = [...plan.owned.filter((p) => p.role === 'P'), ...plan.picks.filter((p) => p.role === 'P')];
  if (!miei.length) return null;
  const titolare = miei.slice().sort((a, b) => (b.scelto ? 1 : 0) - (a.scelto ? 1 : 0) || (b.score || 0) - (a.score || 0))[0];
  if (!titolare.team) return null;
  const gia = miei.some((p) => p.id !== titolare.id && p.team === titolare.team);
  if (gia) return { titolare, coppia: null, fatto: true };

  const candidati = players
    .filter(
      (p) =>
        p.role === 'P' &&
        p.team === titolare.team &&
        p.id !== titolare.id &&
        !owned.has(p.id) &&
        !unavailable.has(p.id)
    )
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  if (!candidati.length) return { titolare, coppia: null, fatto: false };
  return { titolare, coppia: candidati[0], fatto: false };
}


/**
 * Cosa succede davvero quando perdi un giocatore.
 *
 * Elencare dei sostituti non basta e a volte inganna: la risposta giusta quasi mai e' "compra
 * quest'altro al posto suo", e' "la rosa si riorganizza cosi'". Perdere un attaccante da
 * centosessanta crediti non significa comprare un altro attaccante da centosessanta ne' ripiegare
 * su uno da venti: significa che quei crediti si ridistribuiscono, e il piano puo' rifare
 * l'attacco intero e portarsi dietro difesa e centrocampo.
 */
export function spiegaPerdita({ players, settings, owned = new Map(), unavailable = new Set(), obbligati = new Set(), playerId, piano = null, limite = 4, alternative = null }) {
  const perso = players.find((p) => p.id === playerId);
  if (!perso) return null;

  const prima = piano?.ok ? piano : optimizeRoster({ players, settings, owned, unavailable, ...FAST, obbligati });
  const senza = new Set(unavailable);
  senza.add(playerId);
  // Se era un giocatore che avevo imposto, perderlo scioglie il vincolo: altrimenti il piano
  // resterebbe legato a qualcuno che non e' piu' comprabile.
  const vincoli = new Set([...obbligati].filter((id) => id !== playerId));
  const dopo = optimizeRoster({ players, settings, owned, unavailable: senza, ...FAST, obbligati: vincoli });
  if (!dopo.ok) {
    return { perso, dopo, impossibile: true, frasi: ['Senza di lui non si chiude una rosa valida: e\' incedibile.'] };
  }

  const idsPrima = new Set(prima.picks.map((p) => p.id));
  const idsDopo = new Set(dopo.picks.map((p) => p.id));
  const entrati = dopo.picks.filter((p) => !idsPrima.has(p.id));
  const usciti = prima.picks.filter((p) => !idsDopo.has(p.id) && p.id !== playerId);

  const spostamenti = ROLES.map((r) => ({
    role: r,
    delta: (dopo.spentByRole[r] || 0) - (prima.spentByRole[r] || 0),
  })).filter((x) => Math.abs(x.delta) >= 3);

  // Chi prende il suo posto nel reparto: il piu' caro fra chi entra nello stesso ruolo.
  const sostituto = entrati
    .filter((p) => p.role === perso.role)
    .sort((a, b) => b.plannedPrice - a.plannedPrice)[0] || null;

  const prezzoPiano = prima.picks.find((p) => p.id === playerId)?.plannedPrice ?? perso.expectedPrice ?? 0;
  const costo = Math.max(0, Math.round((prima.score - dopo.score) * 10) / 10);
  const { alternatives: tutte } = alternatives({ players, settings, owned, unavailable, playerId, limit: 12 });

  const frasi = [];
  if (sostituto) {
    frasi.push(`Al suo posto entra ${sostituto.name} a ${sostituto.plannedPrice}.`);
  } else {
    frasi.push(`Nessuno lo sostituisce uno a uno: il reparto si rifa' con quello che resta.`);
  }
  const liberati = prezzoPiano - (sostituto?.plannedPrice ?? 0);
  const altrove = spostamenti.filter((x) => x.role !== perso.role && x.delta > 0);
  if (liberati > 5 && altrove.length) {
    frasi.push(
      `I ${liberati} crediti che si liberano vanno su ${elenco(
        altrove.map((x) => `${ROLE_LABEL[x.role].toLowerCase()} (+${x.delta})`)
      )}.`
    );
  }
  if (entrati.length >= 3) {
    frasi.push(`Non e' un cambio secco: si riorganizzano ${entrati.length} scelte su quattro reparti.`);
  }
  frasi.push(costo > 0 ? `Ti costa ${costo} punti attesi.` : `Non ti costa niente: il piano vale quanto prima.`);

  return {
    perso,
    prezzoPiano,
    prima,
    dopo,
    costo,
    entrati,
    usciti,
    spostamenti,
    sostituto,
    riorganizzazione: entrati.length >= 3,
    // Le vere alternative: chi non era gia' destinato a entrare comunque.
    alternative: tutte.filter((a) => !a.giaNelPiano).slice(0, limite),
    giaTuoi: tutte.filter((a) => a.giaNelPiano).slice(0, limite),
    frasi,
  };
}


/**
 * Perche' l'offerta massima e' cosi' lontana dal prezzo di mercato.
 *
 * Un numero senza motivo non si usa: leggere "il mercato lo paga 43, tu fermati a 5" fa pensare
 * a un errore, e a quel punto o si ignora il consiglio o si perde tempo a discuterci. Qui si
 * cerca la ragione vera, e quasi sempre e' una di tre: gioca troppo poco, esiste qualcuno che
 * rende uguale per molto meno, oppure il posto da titolare in quel reparto e' gia' occupato.
 */
export function spiegaOfferta({ players, settings, owned = new Map(), unavailable = new Set(), playerId, offerta, piano = null }) {
  const p = players.find((x) => x.id === playerId);
  if (!p) return null;
  const atteso = Math.max(1, Math.round(p.expectedPrice ?? 1));
  const frasi = [];

  // Chi rende almeno quanto lui e costa meno: e' la ragione piu' convincente di tutte.
  const equivalenti = players
    .filter(
      (x) =>
        x.role === p.role &&
        x.id !== p.id &&
        !owned.has(x.id) &&
        !unavailable.has(x.id) &&
        (x.score || 0) >= (p.score || 0) &&
        Math.round(x.expectedPrice ?? 1) < atteso
    )
    .sort((a, b) => (a.expectedPrice ?? 0) - (b.expectedPrice ?? 0));

  // Quante partite ci si aspetta da lui, contro i titolari veri del suo ruolo.
  const presenze = Math.round(expectedShare(p) * 38);
  const riferimento = players
    .filter((x) => x.role === p.role && !unavailable.has(x.id))
    .map((x) => Math.round(expectedShare(x) * 38))
    .sort((a, b) => b - a);
  const tipico = riferimento.length ? riferimento[Math.min(riferimento.length - 1, (settings.participants || 8) - 1)] : presenze;

  // Il posto da titolare e' gia' occupato da qualcuno di piu' forte?
  const titolari = Math.max(1, settings.starters?.[p.role] ?? 1);
  const miei = piano?.ok
    ? [...piano.owned.filter((x) => x.role === p.role), ...piano.picks.filter((x) => x.role === p.role && x.id !== p.id)]
        .sort((a, b) => (b.score || 0) - (a.score || 0))
    : [];
  const davanti = miei.filter((x) => (x.score || 0) > (p.score || 0));
  const panchina = davanti.length >= titolari;

  if (offerta <= 0) {
    frasi.push(`Il mercato lo paga ${atteso}, ma alla tua rosa non serve: anche a un credito il piano peggiora.`);
  } else if (offerta < atteso * 0.65) {
    frasi.push(`Il mercato lo paga ${atteso}, per la tua rosa ne vale ${offerta}.`);
  } else if (offerta > atteso * 1.15) {
    // La pastiglia in alto confronta la valutazione dei creators col prezzo di mercato; questa
    // riga confronta il prezzo di mercato con quanto serve alla tua rosa. Sono due cose diverse
    // e chiamarle entrambe "occasione" le faceva sembrare in contraddizione.
    frasi.push(`Il mercato lo paga ${atteso}, ma alla tua rosa serve al punto che ne varrebbe ${offerta}.`);
    return { frasi, atteso, offerta, presenze, equivalente: equivalenti[0] || null, panchina };
  } else {
    return { frasi: [], atteso, offerta, presenze, equivalente: equivalenti[0] || null, panchina };
  }

  if (panchina && titolari === 1) {
    frasi.push(`In ${p.role === 'P' ? 'porta' : 'quel ruolo'} ne giochi uno solo, e il tuo titolare e' gia' ${davanti[0].name}: lui andrebbe in panchina.`);
  } else if (panchina) {
    frasi.push(`Sarebbe una riserva: davanti a lui hai gia' ${davanti.slice(0, titolari).map((x) => x.name).join(', ')}.`);
  }

  if (presenze < tipico - 5) {
    frasi.push(`Ci si aspettano ${presenze} partite da lui, contro le ${tipico} di un titolare del ruolo.`);
  }

  const eq = equivalenti[0];
  if (eq) {
    const meglio = (eq.score || 0) > (p.score || 0) * 1.1;
    frasi.push(
      `${eq.name} rende ${meglio ? 'di piu' + "'" : 'quanto lui'} e il mercato lo paga ${Math.round(eq.expectedPrice ?? 1)}.`
    );
  }

  return { frasi, atteso, offerta, presenze, equivalente: eq || null, panchina };
}

/**
 * Il tetto di spesa su una lista scelta a mano.
 *
 * In modalita' automatica l'offerta massima e' un punto di pareggio: il prezzo oltre il quale
 * conviene la rosa alternativa. Su una lista decisa dall'utente quell'alternativa non esiste —
 * la rosa e' quella, l'ha scelta lui — e la domanda cambia: quanto posso pagarlo continuando a
 * permettermi tutti gli altri che ho messo in lista.
 *
 * E' aritmetica, non ottimizzazione: si mette da parte il prezzo di mercato di ogni altro nome
 * ancora da comprare, piu' un credito per ogni casella che la lista lascia vuota.
 */
export function tettoSullaLista({ players, settings, owned = new Map(), lista = new Set(), playerId }) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const budget = settings.budget || 500;
  const speso = [...owned.values()].reduce((a, b) => a + (Number(b) || 0), 0);

  const inLista = [...lista].map((id) => byId.get(id)).filter(Boolean);
  const daComprare = inLista.filter((p) => !owned.has(p.id) && p.id !== playerId);
  const riservatoLista = daComprare.reduce((a, p) => a + Math.max(1, Math.round(p.expectedPrice ?? 1)), 0);

  // Quante caselle restano scoperte dopo la lista: ognuna costa almeno un credito.
  const presiPerRuolo = { P: 0, D: 0, C: 0, A: 0 };
  for (const id of owned.keys()) {
    const p = byId.get(id);
    if (p && p.role in presiPerRuolo) presiPerRuolo[p.role] += 1;
  }
  for (const p of inLista) {
    if (!owned.has(p.id) && p.role in presiPerRuolo) presiPerRuolo[p.role] += 1;
  }
  let scoperte = 0;
  const mancanti = {};
  for (const role of ROLES) {
    mancanti[role] = Math.max(0, (settings.slots?.[role] || 0) - presiPerRuolo[role]);
    scoperte += mancanti[role];
  }
  // La casella del giocatore che sto valutando non va contata due volte.
  const target = byId.get(playerId);
  const suoPosto = target && !lista.has(playerId) && !owned.has(playerId) ? Math.min(1, mancanti[target.role] || 0) : 0;

  const residuo = budget - speso - riservatoLista - Math.max(0, scoperte - suoPosto);
  return {
    massimo: Math.max(0, residuo),
    riservatoLista,
    scoperte,
    mancanti,
    costoLista: riservatoLista + (owned.size ? speso : 0),
  };
}

/** Quanto costa in punti attesi giocare la propria lista invece del piano libero. */
export function costoDellaLista({ players, settings, owned = new Map(), unavailable = new Set(), lista = new Set() }) {
  const libero = optimizeRoster({ players, settings, owned, unavailable, ...FAST });
  const mia = optimizeRoster({ players, settings, owned, unavailable, obbligati: lista, ...FAST });
  if (!libero.ok || !mia.ok) return null;

  // Dove costa, non solo quanto. Un totale di centosettanta punti non dice niente: sapere che
  // centocinquanta arrivano dalla porta si', perche' e' li' che c'e' una scelta da rivedere.
  // Un'ottimizzazione per reparto in cui ci sia qualcosa di scelto, e non di piu'.
  const byId = new Map(players.map((p) => [p.id, p]));
  const perRuolo = [];
  for (const role of ROLES) {
    const suoi = [...lista].filter((id) => byId.get(id)?.role === role);
    if (!suoi.length) continue;
    const senzaQuelReparto = new Set([...lista].filter((id) => !suoi.includes(id)));
    const alt = optimizeRoster({ players, settings, owned, unavailable, obbligati: senzaQuelReparto, ...FAST });
    if (!alt.ok) continue;
    perRuolo.push({
      role,
      scelti: suoi.length,
      differenza: Math.round((alt.score - mia.score) * 10) / 10,
      spesaTua: mia.spentByRole[role] || 0,
      spesaMia: alt.spentByRole[role] || 0,
    });
  }

  return {
    libero,
    mia,
    differenza: Math.round((libero.score - mia.score) * 10) / 10,
    percentuale: libero.score > 0 ? Math.round(((libero.score - mia.score) / libero.score) * 1000) / 10 : 0,
    perRuolo: perRuolo.sort((a, b) => b.differenza - a.differenza),
  };
}

// Sotto i cinque crediti si e' comprato un riempitivo, e un riempitivo in panchina ci sta:
// e' esattamente il suo mestiere. Sopra, si stanno pagando dei crediti per non giocare.
const PREZZO_RIEMPITIVO = 5;

/**
 * I giocatori scelti a mano che nella rosa finita non giocano.
 *
 * E' il caso che ha fatto sembrare rotto il piano: imponendo un portiere da quarantatre'
 * crediti il solutore ne comprava un altro da cinquantadue, perche' era piu' forte e in porta
 * gioca il piu' forte. Novantasette crediti per un posto solo, e il portiere scelto in panchina.
 * Il conto era giusto — dato per speso il primo, il secondo si ripaga — ma la conclusione da
 * trarne non era "compra anche l'altro", era "quella scelta ti costa".
 */
export function sceltiInPanchina({ plan, settings }) {
  if (!plan?.ok) return [];
  const tutti = [...plan.owned.map((p) => ({ ...p, plannedPrice: p.paid })), ...plan.picks];
  const out = [];
  for (const role of ROLES) {
    const pesi = depthWeights(settings, role);
    const gruppo = sortByStrength(tutti.filter((p) => p.role === role));
    gruppo.forEach((p, i) => {
      const peso = pesi[i] ?? pesi[pesi.length - 1] ?? 0;
      if (peso >= 1 || !p.bloccato) return;
      if ((p.plannedPrice || 0) < PREZZO_RIEMPITIVO) return;
      out.push({ player: p, role, peso, prezzo: p.plannedPrice || 0, titolare: gruppo[0] || null });
    });
  }
  return out.sort((a, b) => b.prezzo - a.prezzo);
}
