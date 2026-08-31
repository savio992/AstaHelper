// Il piano: la miglior rosa possibile con i crediti che restano, e come sono distribuiti.

import { state, rebuildPlan, blocca, scarta, liberaScelta, statoScelta, obbligatiSet, updateSettings } from '../store.js';
import { ROLES, ROLE_LABEL, totalSlots } from '../domain/model.js';
import { tierBudgetReport, maxBid, alternatives, tettoSullaLista, costoDellaLista, sceltiInPanchina } from '../domain/advisor.js';
import { clubExposure, depthWeights, sortByStrength } from '../domain/valuation.js';
import { ownedMap, unavailableSet, onReset } from '../store.js';
import { spiegaModifica } from '../domain/strategia.js';
import { esc, roleChip, emptyState, playerRow, edgeBadge, toast, matches } from './common.js';
import * as strade from './strade.js';

/**
 * L'effetto di una correzione fatta a mano.
 *
 * Il piano si rifa' per intero a ogni blocco o scarto, ma senza dirlo sembra che non sia
 * successo niente. E la differenza fra i due casi va vista: scartare il terzo portiere cambia
 * davvero solo il terzo portiere, scartare il primo puo' spostare settanta crediti in difesa.
 */
function modificaCard() {
  const mod = state.ultimaModifica;
  if (!mod || modificaChiusa === mod.at) return '';
  const p = state.players.find((x) => x.id === mod.id);
  if (!p) return '';

  if (mod.rifiutata) {
    return `
    <div class="card" style="border-left:3px solid var(--danger)">
      <div class="row between" style="align-items:flex-start;margin-bottom:6px">
        <b>Non posso: ${esc(p.name)} resta come prima.</b>
        <button class="btn ghost" style="padding:2px 8px" data-action="chiudi-modifica" aria-label="Chiudi">✕</button>
      </div>
      <div class="small">${esc(mod.motivo)}</div>
    </div>`;
  }

  const sp = spiegaModifica({
    prima: state.prevPlan,
    dopo: state.plan,
    players: state.players,
    settings: state.settings,
    id: mod.id,
    azione: mod.azione,
  });
  if (!sp) return '';

  return `
  <div class="card" style="border-left:3px solid var(--${sp.azione === 'scarta' ? 'danger' : 'accent'})">
    <div class="row between" style="align-items:flex-start;margin-bottom:6px">
      <b>${esc(sp.titolo)}</b>
      <button class="btn ghost" style="padding:2px 8px" data-action="chiudi-modifica" aria-label="Chiudi">✕</button>
    </div>
    <div class="small" style="line-height:1.6">${sp.frasi.map((f) => esc(f)).join(' ')}</div>
    ${
      sp.mosse.length
        ? `<div class="row wrap" style="gap:6px;margin-top:10px">
             ${sp.mosse
               .map(
                 (m) =>
                   `<span class="chip">${esc(ROLE_LABEL[m.role])} <b class="mono" style="color:var(--${
                     m.delta > 0 ? 'accent' : 'danger'
                   })">${m.delta > 0 ? '+' : ''}${m.delta}</b></span>`
               )
               .join('')}
           </div>`
        : ''
    }
  </div>`;
}

let modificaChiusa = null;

/**
 * Il piano non e' un verdetto: e' una proposta.
 *
 * Il lucchetto impone un giocatore e il solutore ricalcola tutto il resto attorno a lui, con i
 * crediti che restano; la crocetta lo toglie di mezzo per sempre. Sono le due cose che
 * un'ottimizzazione non puo' sapere da sola — che quel portiere lo vuoi comunque, o che di
 * quell'attaccante non ti fidi.
 */
function sceltaBottoni(p) {
  const stato = statoScelta(p.id);
  return `<div class="row" style="gap:4px">
    <button class="btn ${stato === 'bloccato' ? 'primary' : 'ghost'}" style="padding:8px 10px;min-width:40px"
      data-action="${stato === 'bloccato' ? 'libera' : 'blocca'}" data-id="${esc(p.id)}"
      aria-label="${stato === 'bloccato' ? 'Lascia decidere al piano' : 'Voglio questo giocatore'}"
      title="${stato === 'bloccato' ? 'Lascia decidere al piano' : 'Voglio questo giocatore'}">${stato === 'bloccato' ? '🔒' : '🔓'}</button>
    <button class="btn ${stato === 'escluso' ? 'danger' : 'ghost'}" style="padding:8px 10px;min-width:40px"
      data-action="${stato === 'escluso' ? 'libera' : 'scarta'}" data-id="${esc(p.id)}"
      aria-label="Non lo voglio" title="Non lo voglio">✕</button>
  </div>`;
}

// Sotto questo peso il giocatore in campo non ci va quasi mai: e' una casella da riempire, non
// un titolare. Vale la pena dirlo solo li' — segnare "panchina" sul quarto difensore, che entra
// una domenica su due, sarebbe rumore.
const PESO_PANCHINA = 0.2;

function roleBlock(role, plan) {
  const owned = plan.owned.filter((p) => p.role === role).map((p) => ({ ...p, plannedPrice: p.paid, mine: true }));
  const picks = plan.picks.filter((p) => p.role === role);
  // L'ordine di profondita' non e' quello del prezzo: dice chi di questi giocherebbe davvero.
  const pesi = depthWeights(state.settings, role);
  const profondita = new Map(
    sortByStrength([...owned, ...picks]).map((p, i) => [p.id, pesi[i] ?? pesi[pesi.length - 1] ?? 0])
  );
  const all = [...owned, ...picks].sort((a, b) => b.plannedPrice - a.plannedPrice);
  const spent = plan.spentByRole[role] || 0;
  const cap = state.settings.roleBudget?.[role];
  const budget = state.settings.budget || 500;
  return `
  <div class="card">
    <div class="row between" style="margin-bottom:10px">
      <h3 style="margin:0">${roleChip(role)} ${ROLE_LABEL[role]}</h3>
      <div class="mono"><b>${spent}</b> <span class="small muted">cr · ${Math.round((spent / budget) * 100)}%${cap ? ` · tetto ${cap}` : ''}</span></div>
    </div>
    <div class="listwrap">
      <ul class="plist">
        ${all
          .map(
            (p) => `<li>
              ${roleChip(p.role)}
              <div class="grow">
                <div class="nm">${esc(p.name)}${p.bloccato ? ' <span class="chip plan">scelto da te</span>' : ''}${
                  (profondita.get(p.id) ?? 1) < PESO_PANCHINA ? ' <span class="chip">panchina</span>' : ''
                }</div>
                <div class="sub">${esc(p.team || '—')}${p.tier ? ' · ' + esc(p.tier) : ''}</div>
              </div>
              <div class="pr mono">${p.plannedPrice}<small>${p.mine ? 'pagato' : 'stima'}</small></div>
              ${p.mine ? '' : sceltaBottoni(p)}
            </li>`
          )
          .join('')}
      </ul>
    </div>
  </div>`;
}

/**
 * Quando una scelta a mano finisce in panchina.
 *
 * Il piano non sta sbagliando: dato per speso il portiere che hai imposto, comprarne uno piu'
 * forte si ripaga davvero. Ma la conclusione utile non e' "compra anche l'altro", e' che quella
 * scelta ti costa dei crediti che in campo non vanno. Va detto, con il numero davanti.
 */
function panchinaCard() {
  const casi = sceltiInPanchina({ plan: state.plan, settings: state.settings });
  if (!casi.length) return '';
  return casi
    .map(
      (c) => `
  <div class="card" style="border-left:3px solid var(--warn)">
    <b>${esc(c.player.name)} a ${c.prezzo} crediti non gioca.</b>
    <div class="small" style="margin-top:6px;line-height:1.6">
      L'hai scelto tu, ma nel piano il posto e' di ${esc(c.titolare?.name || 'un altro')}${
        c.titolare?.plannedPrice ? ` a ${c.titolare.plannedPrice}` : ''
      }, piu' forte di lui${c.role === 'P' ? ', e in porta ne gioca uno solo' : ''}.
      Sono ${c.prezzo} crediti comprati per stare in panchina.
    </div>
    <div class="row wrap" style="gap:6px;margin-top:10px">
      <button class="btn ghost" data-action="libera" data-id="${esc(c.player.id)}">Togli la scelta</button>
      ${
        state.settings.modalita === 'mia'
          ? ''
          : `<button class="btn ghost" data-action="modalita" data-v="mia">Passa a «Scelgo io»: la rosa la fai tu</button>`
      }
    </div>
  </div>`
    )
    .join('');
}

/** Chi ho scartato a mano: deve restare visibile, altrimenti sparisce senza spiegazione. */
function scartatiCard() {
  const ids = Object.keys(state.auction.esclusi || {});
  if (!ids.length) return '';
  const scartati = ids.map((id) => state.players.find((p) => p.id === id)).filter(Boolean);
  if (!scartati.length) return '';
  return `
  <div class="card">
    <h2>Scartati da te</h2>
    <div class="tiny muted" style="margin-bottom:10px">Il piano non li propone piu'. Tocca per rimetterli in gioco.</div>
    <div class="row wrap" style="gap:6px">
      ${scartati
        .map((p) => `<button class="chip" data-action="libera" data-id="${esc(p.id)}">${roleChip(p.role)} ${esc(p.name)} ↩︎</button>`)
        .join('')}
    </div>
  </div>`;
}

function exposureCard(plan) {
  const all = [...plan.owned.map((p) => ({ ...p, plannedPrice: p.paid })), ...plan.picks];
  const rows = [...clubExposure(all, state.settings).entries()]
    .map(([team, v]) => ({ team, ...v }))
    .sort((a, b) => b.effettivi - a.effettivi)
    .slice(0, 6);
  if (!rows.length) return '';
  const cap = Number(state.settings.maxPerClub) || 0;
  return `
  <div class="card">
    <h2>Esposizione per club</h2>
    <div class="tiny muted" style="margin-bottom:10px">
      Quanti giocatori di ogni squadra finiresti per schierare davvero. I riempitivi contano per una frazione.
    </div>
    <table class="tiers">
      <thead><tr><th>Club</th><th class="r">In rosa</th><th class="r">Titolari</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr>
              <td>${esc(r.team || '—')}</td>
              <td class="r">${r.inRosa}</td>
              <td class="r ${cap && r.effettivi > cap ? '' : ''}"><b>${r.effettivi.toFixed(1)}</b></td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table>
    ${cap ? `<div class="tiny muted" style="margin-top:8px">Tetto impostato: ${cap} titolari per club.</div>` : ''}
  </div>`;
}

// La scheda d'asta si calcola su richiesta: sono 25 ottimizzazioni complete.
let scheda = null;
let schedaInCorso = false;

onReset(() => {
  scheda = null;
  schedaInCorso = false;
  modificaChiusa = null;
  confronto = null;
});

function buildScheda(rerender) {
  schedaInCorso = true;
  setTimeout(() => {
    try {
      const args = { players: state.players, settings: state.settings, owned: ownedMap(), unavailable: unavailableSet(), obbligati: obbligatiSet() };
      scheda = (state.plan?.picks || [])
        .slice()
        .sort((a, b) => b.plannedPrice - a.plannedPrice)
        .map((p) => ({
          player: p,
          bid: maxBid({ ...args, playerId: p.id }).maxBid,
          alts: alternatives({ ...args, playerId: p.id, limit: 3 }).alternatives,
        }));
    } catch (err) {
      console.error(err);
      scheda = [];
    } finally {
      schedaInCorso = false;
      rerender();
    }
  }, 30);
}

function schedaCard() {
  if (schedaInCorso) {
    return `<div class="card"><h2>Scheda d'asta</h2><div class="small muted"><span class="spinner"></span> Calcolo offerte massime e alternative…</div></div>`;
  }
  if (!scheda) {
    return `
    <div class="card">
      <h2>Scheda d'asta</h2>
      <p class="small muted" style="margin-top:0">
        Il foglio da tenere sott'occhio: per ogni obiettivo l'offerta massima e le tre alternative
        migliori se te lo soffiano. Preparalo prima di iniziare.
      </p>
      <button class="btn primary block" data-action="scheda">Prepara la scheda</button>
    </div>`;
  }
  return `
  <div class="card">
    <div class="row between" style="margin-bottom:10px">
      <h2 style="margin:0">Scheda d'asta</h2>
      <button class="btn ghost small" data-action="scheda">Ricalcola</button>
    </div>
    ${scheda
      .map(
        (row) => `
      <div style="padding:10px 0;border-bottom:1px solid var(--line)">
        <div class="row between">
          <div class="grow">
            ${roleChip(row.player.role)} <b>${esc(row.player.name)}</b> ${edgeBadge(row.player)}
            <span class="small muted">${esc(row.player.team || '')}</span>
          </div>
          <div class="mono" style="text-align:right">
            <b style="font-size:19px;color:var(--accent)">${row.bid}</b>
            <div class="tiny muted">max</div>
          </div>
        </div>
        ${
          row.alts.length
            ? `<div class="tiny muted" style="margin-top:4px">se lo perdi: ${row.alts
                .map((a) => `${esc(a.player.name)} <b>${a.price}</b>`)
                .join(' · ')}</div>`
            : ''
        }
      </div>`
      )
      .join('')}
  </div>`;
}

function tiersCard(plan) {
  const rows = tierBudgetReport({ plan, settings: state.settings, players: state.players, owned: ownedMap() });
  if (!rows.length) return '';
  return `
  <div class="card">
    <h2>Budget per fascia</h2>
    <table class="tiers">
      <thead><tr><th>Ruolo</th><th>Fascia</th><th class="r">Giocatori</th><th class="r">Crediti</th><th class="r">Speso</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr>
              <td>${roleChip(r.role)}</td>
              <td>${esc(r.tier)}</td>
              <td class="r">${r.plannedCount}</td>
              <td class="r"><b>${r.planned}</b></td>
              <td class="r ${r.spent ? '' : 'muted'}">${r.spent || '—'}</td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table>
  </div>`;
}

/**
 * Le due modalita' di lavoro.
 *
 * Il solutore nasce per rispondere a "la miglior rosa possibile", e l'offerta massima ha senso
 * proprio perche' esiste un'alternativa da ricalcolare. Ma chi all'asta ha gia' in testa la
 * squadra che vuole non sta facendo quella domanda, e imporre venticinque nomi uno alla volta
 * col lucchetto e' scomodo. Qui si sceglie quale delle due domande si sta facendo.
 */
function modalitaCard() {
  const mia = state.settings.modalita === 'mia';
  const lista = obbligatiSet();
  return `
  <div class="card">
    <div class="segment">
      <button data-action="modalita" data-v="auto" aria-pressed="${!mia}">La scegli tu</button>
      <button data-action="modalita" data-v="mia" aria-pressed="${mia}">Scelgo io</button>
    </div>
    <div class="tiny muted" style="margin-top:8px">
      ${
        mia
          ? `La rosa e' la tua lista: ${lista.size} nomi scelti. Chi ci metti gioca — non compro
             nessuno che lo mandi in panchina — e le caselle che lasci vuote le completo io, in porta
             cercando l'abbinamento giusto. Per ogni giocatore ti dico quanto puoi pagarlo continuando
             a permetterti tutti gli altri.`
          : `Costruisco io la miglior rosa possibile coi crediti che restano. Col lucchetto imponi
             un nome e ricalcolo il resto attorno a lui.`
      }
    </div>
  </div>`;
}

/**
 * Il conto della lista scelta a mano.
 *
 * Due numeri che in modalita' automatica non servono: quanto costa la lista ai prezzi di
 * mercato, e quanto costa in punti rispetto alla rosa che avrei costruito io. Il secondo non
 * e' un rimprovero — a volte si sa qualcosa che il listone non sa — ma va detto.
 */
function listaCard(plan) {
  const lista = obbligatiSet();
  const budget = state.settings.budget || 500;
  const speso = plan.owned.reduce((a, p) => a + p.paid, 0);
  const conto = tettoSullaLista({
    players: state.players,
    settings: state.settings,
    owned: new Map(plan.owned.map((p) => [p.id, p.paid])),
    lista,
    playerId: null,
  });
  const scelti = [...lista].map((id) => state.players.find((p) => p.id === id)).filter(Boolean);

  return `
  <div class="card">
    <div class="row between" style="margin-bottom:10px">
      <h2 style="margin:0">La tua lista</h2>
      <span class="tiny muted">${scelti.length} nomi · ${conto.scoperte} caselle libere</span>
    </div>
    ${
      scelti.length
        ? `<div class="row between small">
             <span class="muted">costo ai prezzi di mercato</span>
             <span class="mono"><b>${conto.riservatoLista + speso}</b> <span class="muted">di ${budget}</span></span>
           </div>
           <div class="row between small" style="margin-top:6px">
             <span class="muted">ti resta per le caselle libere</span>
             <span class="mono"><b style="color:var(--${budget - speso - conto.riservatoLista < conto.scoperte ? 'danger' : 'text'})">${
               budget - speso - conto.riservatoLista
             }</b> <span class="muted">per ${conto.scoperte}</span></span>
           </div>
           ${
             budget - speso - conto.riservatoLista < conto.scoperte
               ? `<div class="verdict stop" style="margin-top:10px;text-align:left">
                    <div class="small" style="font-weight:600">La lista non ci sta nel budget.</div>
                    <div class="small" style="font-weight:500;margin-top:4px">Ai prezzi di mercato non riusciresti a riempire le caselle rimaste. Togli qualche nome o accetta di pagarne qualcuno meno del previsto.</div>
                  </div>`
               : ''
           }
           <div class="tiny muted" style="margin-top:10px">
             Caselle libere per ruolo: ${ROLES.map((r) => `${r} ${conto.mancanti[r]}`).join(' · ')}
           </div>`
        : `<div class="small muted">Non hai ancora scelto nessuno. Cerca i giocatori qui sotto o nella scheda Asta e tocca <b>🔓</b> per metterli in lista.</div>`
    }
    ${confrontoCard()}
  </div>
  ${cercaCard()}`;
}

/** La ricerca per costruire la lista: senza, ogni nome andrebbe cercato nella scheda Asta. */
function cercaCard() {
  const q = (state.ui.listaQuery || '').trim();
  const lista = obbligatiSet();
  const risultati = q
    ? state.players
        .filter((p) => matches(p, q) && !state.auction.taken[p.id] && !state.auction.owned[p.id])
        .sort((a, b) => (b.expectedPrice ?? 0) - (a.expectedPrice ?? 0))
        .slice(0, 25)
    : [];
  return `
  <div class="card">
    <h2>Aggiungi alla lista</h2>
    <input type="search" id="listaQuery" placeholder="Cerca un giocatore" value="${esc(q)}" data-action="listaquery" autocomplete="off" autocorrect="off" spellcheck="false">
    ${
      risultati.length
        ? `<div class="listwrap" style="margin-top:12px"><ul class="plist">
             ${risultati
               .map(
                 (p) => `<li>
                   ${roleChip(p.role)}
                   <div class="grow">
                     <div class="nm">${esc(p.name)}</div>
                     <div class="sub">${esc(p.team || '—')}${p.tier ? ' · ' + esc(p.tier) : ''}</div>
                   </div>
                   <div class="pr mono">${Math.round(p.expectedPrice ?? 0)}<small>atteso</small></div>
                   <button class="btn ${lista.has(p.id) ? 'primary' : 'ghost'}" style="min-width:44px;padding:9px"
                     data-action="${lista.has(p.id) ? 'libera' : 'blocca'}" data-id="${esc(p.id)}"
                     aria-label="${lista.has(p.id) ? 'Togli dalla lista' : 'Metti in lista'}">${lista.has(p.id) ? '🔒' : '＋'}</button>
                 </li>`
               )
               .join('')}
           </ul></div>`
        : q
          ? `<div class="small muted center" style="padding:14px">Nessun giocatore trovato.</div>`
          : `<div class="tiny muted" style="margin-top:8px">Bastano tre lettere.</div>`
    }
  </div>`;
}

// Il confronto con la rosa automatica costa due ottimizzazioni: si calcola su richiesta.
let confronto = null;
let confrontoInCorso = false;

function buildConfronto(rerender) {
  confrontoInCorso = true;
  setTimeout(() => {
    try {
      confronto = costoDellaLista({
        players: state.players,
        settings: state.settings,
        owned: ownedMap(),
        unavailable: unavailableSet(),
        lista: obbligatiSet(),
      });
    } catch (err) {
      console.error(err);
      confronto = null;
    } finally {
      confrontoInCorso = false;
      rerender();
    }
  }, 30);
}

function confrontoCard() {
  const lista = obbligatiSet();
  if (!lista.size) return '';
  if (confrontoInCorso) {
    return `<div class="small muted" style="margin-top:12px"><span class="spinner"></span> Confronto con la rosa automatica…</div>`;
  }
  if (!confronto) {
    return `<button class="btn ghost block" style="margin-top:12px" data-action="confronta">Quanto mi costa scegliere io?</button>`;
  }
  const d = confronto.differenza;
  return `
  <div class="verdict ${d > 0 ? 'edge' : 'go'}" style="margin-top:12px;text-align:left">
    <div class="small" style="font-weight:600">
      ${
        d > 0.5
          ? `La tua lista vale ${d} punti in meno della rosa che costruirei io (−${confronto.percentuale}%).`
          : d < -0.5
            ? `La tua lista vale ${-d} punti in piu' della mia.`
            : `La tua lista vale quanto la rosa che costruirei io.`
      }
    </div>
    <div class="small" style="font-weight:500;margin-top:4px">
      Non e' un rimprovero: a volte si sa qualcosa che il listone non sa. Serve solo a sapere quanto sta costando.
    </div>
    ${
      (confronto.perRuolo || []).filter((r) => Math.abs(r.differenza) >= 1).length
        ? `<div class="tiny" style="margin-top:10px;line-height:1.7">
             ${confronto.perRuolo
               .filter((r) => Math.abs(r.differenza) >= 1)
               .map(
                 (r) =>
                   `${esc(ROLE_LABEL[r.role])}: <b>${r.differenza > 0 ? '−' : '+'}${Math.abs(r.differenza)}</b> punti` +
                   (r.spesaTua !== r.spesaMia ? ` <span class="muted">(tu ${r.spesaTua} cr, io ${r.spesaMia})</span>` : '')
               )
               .join(' · ')}
           </div>`
        : ''
    }
  </div>`;
}

export function render(rerender) {
  if (!state.players.length) {
    return `<div class="view">${emptyState('📋', 'Nessun listone caricato', 'Importa prima il CSV delle fasce.')}</div>`;
  }
  if (!state.plan) rebuildPlan();
  const plan = state.plan;

  if (!plan?.ok) {
    return `<div class="view">
      <div class="card">
        <h3>Piano non calcolabile</h3>
        <div class="small" style="margin-top:8px">${esc(plan?.reason || 'Errore sconosciuto.')}</div>
      </div>
    </div>`;
  }

  const budget = state.settings.budget || 500;
  const filled = plan.owned.length;
  // Le valutazioni delle strade salvate partono in ritardo, dopo che questa stringa e'
  // diventata DOM: qui si dice solo che servono.
  if (rerender) strade.dopoIlDisegno(rerender);
  return `
  <div class="view">
    ${modalitaCard()}
    ${state.settings.modalita === 'mia' ? listaCard(plan) : ''}
    ${modificaCard()}
    <div class="card">
      <div class="row between">
        <div>
          <div class="credits mono" style="font-size:26px;font-weight:800">${plan.cost}<small style="font-size:11px;color:var(--muted)">crediti impegnati su ${budget}</small></div>
        </div>
        <button class="btn" data-action="replan">Rigenera</button>
      </div>
      <div class="bar" style="margin-top:12px"><i style="width:${Math.min(100, (plan.cost / budget) * 100)}%"></i></div>
      <div class="row between small muted" style="margin-top:8px">
        <span>${filled} presi · ${plan.picks.length} da prendere</span>
        <span>avanzo ${plan.leftover} cr</span>
      </div>
      <div class="grid4" style="margin-top:12px">
        ${ROLES.map(
          (r) => `<div class="slotbar"><div><b class="mono">${plan.spentByRole[r]}</b><span>${r}</span></div></div>`
        ).join('')}
      </div>
    </div>

    ${strade.render()}
    ${panchinaCard()}
    ${schedaCard()}
    ${ROLES.map((r) => roleBlock(r, plan)).join('')}
    ${tiersCard(plan)}
    ${scartatiCard()}
    ${exposureCard(plan)}

    <div class="card">
      <div class="small muted">
        Il piano tiene conto di chi hai gia' preso, di chi e' stato preso dagli altri e dei crediti che ti restano.
        Si aggiorna da solo dopo ogni assegnazione durante l'asta.
        Con <b>🔓</b> imponi un giocatore e il resto si ricalcola attorno a lui; con <b>✕</b> lo togli di mezzo.
      </div>
    </div>
  </div>`;
}

export function onAction(action, target, ev, rerender) {
  if (strade.onAction(action, target, ev, rerender)) return true;
  if (action === 'blocca' || action === 'scarta' || action === 'libera') {
    const id = target.dataset.id;
    confronto = null;
    const ok = action === 'blocca' ? blocca(id) : action === 'scarta' ? scarta(id) : liberaScelta(id);
    if (ok === false) toast('Con questo scarto la rosa non si chiude piu\'.');
    scheda = null;
    modificaChiusa = null;
    rerender();
    return true;
  }
  if (action === 'chiudi-modifica') {
    modificaChiusa = state.ultimaModifica?.at ?? null;
    rerender();
    return true;
  }
  if (action === 'modalita') {
    updateSettings({ modalita: target.dataset.v });
    confronto = null;
    rerender();
    return true;
  }
  if (action === 'confronta') {
    confronto = null;
    buildConfronto(rerender);
    rerender();
    return true;
  }
  if (action === 'replan') {
    rebuildPlan();
    scheda = null;
    rerender();
    return true;
  }
  if (action === 'scheda') {
    scheda = null;
    buildScheda(rerender);
    rerender();
    return true;
  }
  return false;
}

export function onInput(action, target, rerender) {
  if (strade.onInput(action, target, rerender)) return true;
  if (action === 'listaquery') {
    state.ui.listaQuery = target.value;
    rerender({ keepFocus: 'listaQuery' });
    return true;
  }
  return false;
}
