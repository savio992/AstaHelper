// Quello che si legge fra un giocatore e l'altro: com'e' andata finora, chi ha ancora crediti,
// e se la strada e' cambiata. Sta fuori dalla schermata d'asta apposta: sono cose da leggere
// con calma, non mentre si rilancia.

import { state, ownedMap, unavailableSet, takenMap } from '../store.js';
import { ROLES, ROLE_LABEL, totalSlots } from '../domain/model.js';
import { concorrenzaPerRuolo, disponibilita } from '../domain/mercato.js';
import { consiglioStrategico, scenarioSenzaBig, narrazione } from '../domain/strategia.js';
import { esc, roleChip, emptyState } from './common.js';

let scenario = null;

export function invalidate() {
  scenario = null;
}

/** Come sta andando l'asta: quanto e' stato assegnato e quanti crediti restano in giro. */
function andamentoCard() {
  const m = state.mercato;
  const lambda = state.players[0]?.lambdaMercato ?? 1;
  const inf = m.inflazioneGlobale;
  const perc = Math.round((inf - 1) * 100);
  const salita = lambda > 1.08;
  const discesa = lambda < 0.92;

  const frase = !m.affidabile
    ? "Troppo poco mercato per dire qualcosa: servono un po' di aggiudicazioni."
    : discesa
      ? `Finora si e' pagato il ${perc >= 0 ? '+' : ''}${perc}% sopra le stime, e la stanza si sta svuotando. Da qui in avanti si compra meglio: le stime di chi resta le ho gia' abbassate.`
      : salita
        ? `Finora si e' pagato il ${perc >= 0 ? '+' : ''}${perc}% sopra le stime e ci sono ancora molti crediti in giro. I prezzi di chi resta saliranno: le stime le ho gia' alzate.`
        : `Finora si e' pagato quello che diceva il listone (${perc >= 0 ? '+' : ''}${perc}%). Le stime tengono.`;

  return `
  <div class="card">
    <h2>Come sta andando</h2>
    <div class="small" style="margin-bottom:12px">${esc(frase)}</div>

    <div class="row between small" style="padding-top:12px;border-top:1px solid var(--line)">
      <span class="muted">giocatori assegnati</span>
      <span class="mono"><b>${m.slotAssegnati}</b> <span class="muted">di ${m.slotTotaliLega}</span></span>
    </div>
    <div class="row between small" style="margin-top:6px">
      <span class="muted">crediti ancora in circolazione</span>
      <span class="mono"><b>${m.creditiResidui}</b> <span class="muted">di ${m.creditiTotali}</span></span>
    </div>
    <div class="row between small" style="margin-top:6px">
      <span class="muted">di cui davvero spendibili</span>
      <span class="mono"><b>${m.discrezionali}</b> <span class="muted">· ${m.slotResidui} posti da riempire</span></span>
    </div>
    <div class="tiny muted" style="margin-top:8px">
      Ogni squadra deve tenere un credito per ogni posto ancora vuoto: quelli non sono contendibili.
    </div>

    ${
      m.copertura < 0.999
        ? `<div class="tiny muted" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
             ${m.senzaPrezzo} aggiudicazioni le hai segnate al volo, senza cifra: per quelle uso la stima.
             Il conto dei posti resta esatto comunque.
           </div>`
        : ''
    }
  </div>`;
}

/**
 * Dove c'e' ancora battaglia.
 *
 * E' la distinzione che confonde di piu': i posti ancora in palio dicono quanto mercato resta
 * per tutti, i giocatori liberi dicono fra quanti posso scegliere io. Quando nessun avversario
 * cerca piu' un ruolo, li' i prezzi vanno a zero, e vale la pena saperlo prima.
 */
function concorrenzaCard() {
  const owned = ownedMap();
  const conc = concorrenzaPerRuolo({ settings: state.settings, players: state.players, owned, taken: takenMap(), tabellone: state.tabellone });
  const disp = disponibilita({ settings: state.settings, players: state.players, owned, mercato: state.mercato });

  return `
  <div class="card">
    <h2>Dove c'e' ancora battaglia</h2>
    ${ROLES.map((r) => {
      const c = conc[r];
      const d = disp[r];
      if (!d.servono && !c.quanti) return '';
      const frase = !d.servono
        ? `Reparto chiuso, li hai presi tutti.`
        : !c.quanti
          ? d.servono === 1
            ? `Nessuno te lo contende piu': l'ultimo lo prendi a un credito.`
            : `Nessuno te li contende piu': i tuoi ${d.servono} li prendi a un credito l'uno.`
          : d.critico
            ? `Attenzione: restano ${d.liberi} nomi liberi e te ne servono ${d.servono}.`
            : `${c.quanti} avversari ne cercano ancora, il piu' ricco puo' arrivare a ${c.massimo}.`;
      const colore = !d.servono ? 'muted' : !c.quanti ? 'accent' : d.critico ? 'danger' : 'text';
      return `
      <div style="padding:10px 0;border-top:1px solid var(--line)">
        <div class="row between" style="margin-bottom:4px">
          <div>${roleChip(r)} <b>${esc(ROLE_LABEL[r])}</b></div>
          <div class="tiny muted mono">te ne mancano ${d.servono} · ${d.liberi} liberi</div>
        </div>
        <div class="small" style="color:var(--${colore})">${esc(frase)}</div>
      </div>`;
    }).join('')}
    <div class="tiny muted" style="margin-top:10px">
      ${
        state.tabellone?.attendibile
          ? 'Numeri esatti: ogni acquisto e&#39; attribuito a una squadra.'
          : `${state.tabellone?.nonAttribuiti || 0} acquisti non sono attribuiti a nessuno, quindi questi massimi sono un limite superiore. Segnando anche la squadra che compra diventano esatti.`
      }
    </div>
  </div>`;
}

/** Il tabellone: quanto puo' ancora offrire ogni squadra su un singolo colpo. */
function tabelloneCard() {
  const board = state.tabellone;
  if (!board) return '';
  return `
  <div class="card">
    <h2>Chi ha ancora crediti</h2>
    <div class="tiny muted" style="margin-bottom:10px">
      L'ultima colonna e' quanto puo' ancora offrire su un solo giocatore, tenendo un credito
      per ogni posto che gli resta da riempire. E' il numero che decide i rilanci.
    </div>
    <table class="tiers">
      <thead><tr><th>Squadra</th><th class="r">Rosa</th><th class="r">Crediti</th><th class="r">Max</th></tr></thead>
      <tbody>
        ${board.squadre
          .slice()
          .sort((a, b) => b.massimo - a.massimo)
          .map(
            (s) => `<tr${s.io ? ' style="font-weight:700"' : ''}>
              <td>${esc(s.nome)}</td>
              <td class="r">${s.presi}/${totalSlots(state.settings)}</td>
              <td class="r">${s.residuo}</td>
              <td class="r"><b>${s.massimo}</b></td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table>
  </div>`;
}

/** I big: quanti ne ho, quanti ne restano, e cosa succede se finiscono. */
function strategiaCard() {
  const plan = state.plan;
  if (!plan?.ok) return '';
  const owned = ownedMap();
  const unavailable = unavailableSet();
  const consiglio = consiglioStrategico({ players: state.players, settings: state.settings, owned, unavailable, piano: plan });
  if (!consiglio) return '';

  const cambiamenti = state.prevPlan ? narrazione({ prima: state.prevPlan, dopo: plan, settings: state.settings }) : [];

  return `
  <div class="card">
    <h2>I big</h2>
    ${ROLES.map((r) => {
      const b = consiglio.big[r];
      const richiesti = Math.max(0, Math.round(state.settings.minTop?.[r] ?? 0));
      if (!b.miei && !b.liberi && !richiesti) return '';
      const restano = b.liberi === 1 ? 'ne resta 1 libero' : `ne restano ${b.liberi} liberi`;
      const frase = b.miei
        ? `Ne hai ${b.miei}${b.liberi ? `, e ${restano}` : ', e non ne restano altri'}.`
        : b.liberi
          ? `Non ne hai ancora, ${restano}${b.nomi?.length ? ': ' + b.nomi.slice(0, 3).join(', ') : ''}.`
          : `Finiti, e non ne hai preso nessuno.`;
      const colore = b.miei >= richiesti && richiesti > 0 ? 'accent' : !b.liberi && !b.miei ? 'danger' : 'text';
      return `
      <div style="padding:9px 0;border-top:1px solid var(--line)">
        <div>${roleChip(r)} <b class="small">${esc(ROLE_LABEL[r])}</b></div>
        <div class="small" style="color:var(--${colore});margin-top:3px">${esc(frase)}</div>
      </div>`;
    }).join('')}

    ${consiglio.avvisi
      .map(
        (a) => `<div class="verdict ${a.gravita === 'finiti' ? 'stop' : 'edge'}" style="margin-top:12px;text-align:left">
          <div>${esc(a.titolo)}</div>
          <div class="small" style="font-weight:500;margin-top:4px">${esc(a.testo)}</div>
        </div>`
      )
      .join('')}

    ${
      cambiamenti.length
        ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
             <div class="tiny muted" style="margin-bottom:4px">dopo l'ultima assegnazione</div>
             <div class="small">${cambiamenti.map((f) => esc(f)).join(' ')}</div>
           </div>`
        : ''
    }

    ${
      scenario
        ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
             <div class="row between" style="margin-bottom:6px">
               <b class="small">Se non prendi nessun big in ${esc(ROLE_LABEL[scenario.role].toLowerCase())}</b>
               <button class="btn ghost tiny" data-action="chiudi-scenario">chiudi</button>
             </div>
             <div class="small">${scenario.frasi.map((f) => esc(f)).join(' ') || 'Il piano non cambierebbe granche&#39;.'}</div>
             <div class="tiny muted" style="margin-top:6px">costo del cambio: ${scenario.costo} punti</div>
           </div>`
        : `<div class="segment" style="margin-top:12px">
             ${ROLES.filter((r) => consiglio.big[r].liberi > 0)
               .map((r) => `<button data-action="scenario" data-role="${r}">se perdo i big ${r}</button>`)
               .join('')}
           </div>`
    }
  </div>`;
}

export function render() {
  if (!state.players.length) {
    return `<div class="view">${emptyState('📈', 'Nessun listone caricato', 'Importa prima il listone dalla scheda <b>Listone</b>.')}</div>`;
  }
  if (!state.mercato) {
    return `<div class="view">${emptyState('📈', 'Asta non ancora cominciata', 'Qui compare come sta andando il mercato appena assegni il primo giocatore.')}</div>`;
  }
  return `
  <div class="view">
    ${concorrenzaCard()}
    ${andamentoCard()}
    ${strategiaCard()}
    ${tabelloneCard()}
  </div>`;
}

export function onAction(action, target, ev, rerender) {
  if (action === 'scenario') {
    const role = target.dataset.role;
    const dopo = scenarioSenzaBig({
      players: state.players,
      settings: state.settings,
      owned: ownedMap(),
      unavailable: unavailableSet(),
      role,
    });
    scenario = {
      role,
      frasi: narrazione({ prima: state.plan, dopo, settings: state.settings }),
      costo: Math.max(0, Math.round(state.plan.score - dopo.score)),
    };
    rerender();
    return true;
  }
  if (action === 'chiudi-scenario') {
    scenario = null;
    rerender();
    return true;
  }
  return false;
}
