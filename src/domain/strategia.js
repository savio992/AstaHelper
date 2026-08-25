// Quando salta il piano, non basta sapere chi prendere al posto di uno: serve capire
// che la strada e' cambiata. Se i big di un reparto finiscono tutti, i crediti che avevi
// messo da parte per loro vanno spostati, e conviene saperlo prima che sia troppo tardi.

import { ROLES, ROLE_LABEL } from './model.js';
import { optimizeRoster } from './optimizer.js';

/** Quanti giocatori di prima fascia restano liberi, reparto per reparto. */
export function bigRimasti(players, { owned = new Map(), unavailable = new Set() } = {}) {
  const out = {};
  for (const role of ROLES) {
    const liberi = players.filter((p) => p.role === role && p.isTop && !owned.has(p.id) && !unavailable.has(p.id));
    const miei = [...owned.keys()]
      .map((id) => players.find((p) => p.id === id))
      .filter((p) => p && p.role === role && p.isTop).length;
    out[role] = { liberi: liberi.length, miei, nomi: liberi.sort((a, b) => b.score - a.score).slice(0, 3).map((p) => p.name) };
  }
  return out;
}

/**
 * Il piano che resterebbe se tutti i big ancora liberi finissero agli avversari.
 * Se `role` e' indicato riguarda solo quel reparto, altrimenti tutti.
 */
export function scenarioSenzaBig({ players, settings, owned = new Map(), unavailable = new Set(), role = null }) {
  const persi = new Set(unavailable);
  for (const p of players) {
    if (!p.isTop || owned.has(p.id)) continue;
    if (role && p.role !== role) continue;
    persi.add(p.id);
  }
  return optimizeRoster({ players, settings, owned, unavailable: persi, localSearch: false });
}

/** Chi entra e chi esce fra due piani, e come si spostano i crediti fra i reparti. */
export function confrontaPiani(prima, dopo) {
  const a = new Map((prima?.picks || []).map((p) => [p.id, p]));
  const b = new Map((dopo?.picks || []).map((p) => [p.id, p]));
  const entrati = [...b.values()].filter((p) => !a.has(p.id)).sort((x, y) => y.plannedPrice - x.plannedPrice);
  const usciti = [...a.values()].filter((p) => !b.has(p.id)).sort((x, y) => y.plannedPrice - x.plannedPrice);
  const spostamenti = {};
  for (const role of ROLES) {
    spostamenti[role] = (dopo?.spentByRole?.[role] ?? 0) - (prima?.spentByRole?.[role] ?? 0);
  }
  return { entrati, usciti, spostamenti };
}

/**
 * Traduce il cambio di piano in frasi.
 * Si citano solo i movimenti che contano davvero: un riempitivo da un credito che ne sostituisce
 * un altro non e' una notizia, mentre venti crediti che passano dall'attacco al centrocampo si'.
 */
export function narrazione({ prima, dopo, settings, soglia = null }) {
  if (!prima?.ok || !dopo?.ok) return [];
  const { entrati, usciti, spostamenti } = confrontaPiani(prima, dopo);
  const minimo = soglia ?? Math.max(6, Math.round((settings.budget || 500) * 0.02));
  const frasi = [];

  const mosse = ROLES.map((role) => ({ role, delta: spostamenti[role] }))
    .filter((x) => Math.abs(x.delta) >= minimo)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  if (mosse.length) {
    const su = mosse.filter((m) => m.delta > 0);
    const giu = mosse.filter((m) => m.delta < 0);
    if (su.length && giu.length) {
      frasi.push(
        `I crediti si spostano da ${giu.map((m) => ROLE_LABEL[m.role].toLowerCase()).join(' e ')} ` +
          `verso ${su.map((m) => `${ROLE_LABEL[m.role].toLowerCase()} (+${m.delta})`).join(' e ')}.`
      );
    } else if (su.length) {
      frasi.push(`Ora c'e' piu' budget per ${su.map((m) => `${ROLE_LABEL[m.role].toLowerCase()} (+${m.delta})`).join(' e ')}.`);
    }
  }

  const nuoviObiettivi = entrati.filter((p) => p.plannedPrice >= Math.max(5, minimo / 2)).slice(0, 3);
  if (nuoviObiettivi.length) {
    frasi.push(`Nuovi obiettivi: ${nuoviObiettivi.map((p) => `${p.name} (${p.plannedPrice})`).join(', ')}.`);
  }

  const rinunce = usciti.filter((p) => p.plannedPrice >= Math.max(5, minimo / 2)).slice(0, 2);
  if (rinunce.length && !nuoviObiettivi.length) {
    frasi.push(`Esce dal piano ${rinunce.map((p) => p.name).join(' e ')}.`);
  }

  return frasi;
}

/**
 * Il consiglio strategico complessivo sullo stato attuale dell'asta.
 * Guarda quanti big restano e cosa succederebbe perdendoli tutti: se il piano regge, non c'e'
 * niente da dire; se crolla, conviene muoversi adesso invece di restare senza.
 */
export function consiglioStrategico({ players, settings, owned = new Map(), unavailable = new Set(), piano }) {
  if (!piano?.ok) return null;
  const big = bigRimasti(players, { owned, unavailable });
  const avvisi = [];

  for (const role of ROLES) {
    const richiesti = Math.max(0, Math.round(settings.minTop?.[role] ?? 0));
    if (!richiesti) continue;
    const { liberi, miei, nomi } = big[role];
    if (miei >= richiesti) continue;

    if (liberi === 0) {
      const scenario = scenarioSenzaBig({ players, settings, owned, unavailable, role });
      const frasi = narrazione({ prima: piano, dopo: scenario, settings });
      avvisi.push({
        role,
        gravita: 'finiti',
        titolo: `I big in ${ROLE_LABEL[role].toLowerCase()} sono finiti.`,
        testo: frasi.length ? frasi.join(' ') : 'Il piano si e\' gia\' adattato senza di loro.',
      });
    } else if (liberi <= richiesti - miei) {
      avvisi.push({
        role,
        gravita: 'ultimi',
        titolo: `Restano ${liberi} big in ${ROLE_LABEL[role].toLowerCase()}: ${nomi.join(', ')}.`,
        testo: `Te ne serve ${richiesti - miei}. Se li perdi tutti devi cambiare strada.`,
      });
    }
  }

  return { big, avvisi };
}

/**
 * Che cosa e' appena successo, e cosa ne consegue.
 *
 * Dopo ogni assegnazione il piano si rifa' da capo, ma finora quel ricalcolo restava invisibile:
 * un avviso di due secondi e la lista che cambiava sotto gli occhi senza spiegazione. Qui si
 * racconta la mossa per intero — quanto e' costata rispetto a quanto era previsto, chi entra e
 * chi esce, in che reparto finiscono i crediti — perche' e' proprio nel momento in cui il piano
 * si muove che serve capire perche' si muove.
 *
 * Il caso che mancava del tutto e' lo scarto di prezzo: pagare sedici crediti sopra il piano
 * significa che sedici crediti devono uscire da un altro reparto, e nessuno lo diceva.
 */
export function spiegaMossa({ prima, dopo, players, settings, evento }) {
  if (!evento || !prima?.ok || !dopo?.ok) return null;
  const p = players.find((x) => x.id === evento.id);
  if (!p) return null;

  const mio = evento.kind === 'mine';
  const pianificato = prima.picks.find((x) => x.id === evento.id)?.plannedPrice ?? null;
  const eraObiettivo = pianificato !== null;
  const prezzo = Math.max(0, Math.round(Number(evento.price) || 0));
  const scarto = mio && eraObiettivo ? prezzo - pianificato : null;

  const { entrati, usciti, spostamenti } = confrontaPiani(prima, dopo);
  const minimo = Math.max(4, Math.round((settings.budget || 500) * 0.015));
  const mosse = ROLES.map((role) => ({ role, delta: spostamenti[role] }))
    .filter((x) => Math.abs(x.delta) >= minimo)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const titolo = mio
    ? `${p.name} e' tuo${prezzo ? ` a ${prezzo}` : ''}.`
    : `${p.name} va a un avversario${prezzo ? ` per ${prezzo}` : ''}.`;

  const frasi = [];

  if (mio) {
    if (!eraObiettivo) {
      frasi.push(`Non era fra gli obiettivi: il piano si rifa' attorno a lui.`);
    } else if (scarto > 0) {
      frasi.push(`Hai pagato ${scarto} sopra il piano, e quei crediti devono uscire da qualche altra parte.`);
    } else if (scarto < 0) {
      frasi.push(`Hai speso ${-scarto} meno del previsto: quei crediti tornano disponibili.`);
    } else {
      frasi.push(`Esattamente il prezzo previsto dal piano.`);
    }
  } else if (eraObiettivo) {
    const sostituto = entrati.filter((x) => x.role === p.role).sort((a, b) => b.plannedPrice - a.plannedPrice)[0];
    frasi.push(
      sostituto
        ? `Era un tuo obiettivo da ${pianificato}. Al suo posto entra ${sostituto.name} a ${sostituto.plannedPrice}.`
        : `Era un tuo obiettivo da ${pianificato}. Il reparto si rifa' con quello che resta.`
    );
  } else {
    frasi.push(`Non era fra i tuoi obiettivi.`);
  }

  if (mosse.length) {
    const su = mosse.filter((m) => m.delta > 0);
    const giu = mosse.filter((m) => m.delta < 0);
    if (su.length && giu.length) {
      frasi.push(
        `I crediti si spostano da ${giu.map((m) => ROLE_LABEL[m.role].toLowerCase()).join(' e ')} ` +
          `verso ${su.map((m) => `${ROLE_LABEL[m.role].toLowerCase()} (+${m.delta})`).join(' e ')}.`
      );
    } else if (su.length) {
      frasi.push(`Piu' budget su ${su.map((m) => `${ROLE_LABEL[m.role].toLowerCase()} (+${m.delta})`).join(' e ')}.`);
    } else if (giu.length) {
      frasi.push(`Si taglia su ${giu.map((m) => `${ROLE_LABEL[m.role].toLowerCase()} (${m.delta})`).join(' e ')}.`);
    }
  }

  const nuovi = entrati.filter((x) => x.plannedPrice >= Math.max(4, minimo / 2)).slice(0, 3);
  const persi = usciti.filter((x) => x.id !== evento.id && x.plannedPrice >= Math.max(4, minimo / 2)).slice(0, 3);
  if (nuovi.length) frasi.push(`Entrano nel piano: ${nuovi.map((x) => `${x.name} (${x.plannedPrice})`).join(', ')}.`);
  if (persi.length) frasi.push(`Escono: ${persi.map((x) => x.name).join(', ')}.`);
  if (!mosse.length && !nuovi.length && !persi.length) frasi.push(`Il resto del piano non cambia.`);

  return {
    player: p,
    mio,
    prezzo,
    pianificato,
    scarto,
    eraObiettivo,
    titolo,
    entrati,
    usciti: usciti.filter((x) => x.id !== evento.id),
    mosse,
    frasi,
  };
}

/**
 * Che effetto ha avuto una correzione fatta a mano sul piano.
 *
 * Imporre o scartare un giocatore rifa' il piano per intero, ma senza dirlo sembra che non sia
 * successo niente, o che si sia limitato a sostituire quel nome. Scartare il terzo portiere
 * cambia davvero solo il terzo portiere, ed e' giusto cosi'; scartare il primo puo' spostare
 * settanta crediti in difesa e cambiare sei scelte su quattro reparti. La differenza fra i due
 * casi va vista, altrimenti non si sa mai se il ricalcolo e' avvenuto.
 */
export function spiegaModifica({ prima, dopo, players, settings, id, azione }) {
  if (!prima?.ok || !dopo?.ok) return null;
  const p = players.find((x) => x.id === id);
  if (!p) return null;

  const { entrati, usciti, spostamenti } = confrontaPiani(prima, dopo);
  const minimo = Math.max(4, Math.round((settings.budget || 500) * 0.015));
  const mosse = ROLES.map((role) => ({ role, delta: spostamenti[role] }))
    .filter((x) => Math.abs(x.delta) >= minimo)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const costo = Math.round((prima.score - dopo.score) * 10) / 10;
  const titolo =
    azione === 'blocca'
      ? `${p.name} e' un tuo obbligo: il piano si rifa' attorno a lui.`
      : azione === 'scarta'
        ? `${p.name} scartato.`
        : `${p.name} torna in gioco.`;

  const frasi = [];
  const altri = entrati.filter((x) => x.id !== id);
  const sostituto = azione === 'scarta' ? entrati.filter((x) => x.role === p.role).sort((a, b) => b.plannedPrice - a.plannedPrice)[0] : null;

  if (azione === 'scarta' && sostituto && altri.length <= 1) {
    frasi.push(`Cambia solo lui: al suo posto ${sostituto.name} a ${sostituto.plannedPrice}. Il resto del piano era gia' quello giusto.`);
  } else if (entrati.length >= 3) {
    frasi.push(`Si riorganizzano ${entrati.length} scelte su ${new Set(entrati.map((x) => x.role)).size} reparti.`);
  } else if (sostituto) {
    frasi.push(`Al suo posto entra ${sostituto.name} a ${sostituto.plannedPrice}.`);
  }

  if (mosse.length) {
    const su = mosse.filter((m) => m.delta > 0);
    const giu = mosse.filter((m) => m.delta < 0);
    if (su.length && giu.length) {
      frasi.push(
        `I crediti si spostano da ${giu.map((m) => ROLE_LABEL[m.role].toLowerCase()).join(' e ')} ` +
          `verso ${su.map((m) => `${ROLE_LABEL[m.role].toLowerCase()} (+${m.delta})`).join(' e ')}.`
      );
    } else if (su.length) {
      frasi.push(`Piu' budget su ${su.map((m) => `${ROLE_LABEL[m.role].toLowerCase()} (+${m.delta})`).join(' e ')}.`);
    }
  }

  const notevoli = entrati.filter((x) => x.plannedPrice >= Math.max(4, minimo / 2) && x.id !== id).slice(0, 3);
  if (notevoli.length) frasi.push(`Entrano: ${notevoli.map((x) => `${x.name} (${x.plannedPrice})`).join(', ')}.`);

  frasi.push(
    costo > 0.5
      ? `Ti costa ${costo} punti attesi.`
      : costo < -0.5
        ? `Il piano ci guadagna ${-costo} punti.`
        : `Non cambia il valore della rosa.`
  );

  return { player: p, azione, titolo, frasi, entrati, usciti, mosse, costo, soloLui: entrati.length <= 1 };
}
