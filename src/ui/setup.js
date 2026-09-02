// Impostazioni della lega: e' qui che si dice all'app che asta si sta giocando.

import { state, updateSettings, resetAll, rebuildPlan, rinominaSquadre, esporta, importa, nomeBackup } from '../store.js';
import { ROLES, ROLE_LABEL, totalSlots } from '../domain/model.js';
import { nomiSquadre } from '../domain/mercato.js';
import { esc, roleChip, toast } from './common.js';
import { onReset } from '../store.js';

// La conferma sta dentro la pagina e non in una finestra del browser: `confirm()` viene
// ignorato in silenzio dentro un iframe con sandbox, che e' esattamente dove gira l'app
// pubblicata, e il tasto non faceva assolutamente niente.
let chiedeConferma = false;
let chiedeImport = false;
let esitoImport = null;

onReset(() => {
  chiedeConferma = false;
  chiedeImport = false;
  esitoImport = null;
});

function tierEditor() {
  const role = state.ui.tierRole || 'D';
  const order = state.settings.tierOrder?.[role] || [];
  if (!state.players.length) return '';
  return `
  <div class="card">
    <h2>Ordine delle fasce</h2>
    <p class="small muted" style="margin-top:0">
      Dalla migliore alla peggiore. L'ordine e' dedotto dalle etichette del tuo listone: correggilo se non
      corrisponde a come le usano i creators.
    </p>
    <div class="segment" style="margin-bottom:10px">
      ${ROLES.map((r) => `<button data-action="tierrole" data-role="${r}" aria-pressed="${role === r}">${r}</button>`).join('')}
    </div>
    ${
      order.length
        ? `<div class="listwrap"><ul class="plist tiersort">
            ${order
              .map(
                (t, i) => `<li>
                  <span class="idx">${i + 1}</span>
                  <span class="grow">${esc(t)}</span>
                  <button class="btn ghost" data-action="tierup" data-role="${role}" data-i="${i}" ${i === 0 ? 'disabled' : ''}>▲</button>
                  <button class="btn ghost" data-action="tierdown" data-role="${role}" data-i="${i}" ${i === order.length - 1 ? 'disabled' : ''}>▼</button>
                </li>`
              )
              .join('')}
          </ul></div>`
        : `<div class="small muted">Il listone importato non ha una colonna fascia per questo ruolo.</div>`
    }
  </div>`;
}

export function render() {
  const s = state.settings;
  return `
  <div class="view">
    <div class="card">
      <h2>La lega</h2>
      <div class="grid2">
        <label class="field"><span>Crediti a squadra</span>
          <input id="cfg-budget" type="number" inputmode="numeric" value="${s.budget}" data-action="set" data-key="budget" min="1"></label>
        <label class="field"><span>Partecipanti</span>
          <input id="cfg-partecipanti" type="number" inputmode="numeric" value="${s.participants}" data-action="set" data-key="participants" min="2" max="30"></label>
      </div>
      <div class="small muted">Con ${s.participants} squadre girano <b>${s.budget * s.participants}</b> crediti in totale: e' da qui che nasce la stima dei prezzi d'asta.</div>
    </div>

    <div class="card">
      <h2>Chi c'e' in lega</h2>
      <p class="small muted" style="margin-top:0">
        I nomi degli avversari. Quando durante l'asta segni a chi e' andato un giocatore,
        l'app sa quanto gli e' rimasto: e chi ha finito i crediti o riempito il reparto
        non puo' piu' contenderti nessuno.
      </p>
      <div class="grid2">
        ${nomiSquadre(s)
          .map(
            (nome, i) => `<label class="field" style="margin:0"><span>${i === 0 ? 'Io' : `Squadra ${i + 1}`}</span>
              <input id="cfg-squadra-${i}" type="text" value="${esc(nome)}" data-action="setsquadra" data-i="${i}" maxlength="18" autocomplete="off" autocorrect="off" spellcheck="false"></label>`
          )
          .join('')}
      </div>
    </div>

    <div class="card">
      <h2>Rosa</h2>
      <div class="grid4">
        ${ROLES.map(
          (r) => `<label class="field" style="margin:0"><span>${r}</span>
            <input id="cfg-slot-${r}" type="number" inputmode="numeric" value="${s.slots[r]}" data-action="setslot" data-key="${r}" min="0" max="15"></label>`
        ).join('')}
      </div>
      <div class="small muted" style="margin-top:4px">${totalSlots(s)} giocatori in rosa.</div>
    </div>

    <div class="card">
      <h2>Modulo di riferimento</h2>
      <p class="small muted" style="margin-top:0">Quanti ne schieri per ruolo. Serve a non farti spendere crediti sui panchinari: in porta ne gioca uno solo.</p>
      <div class="grid4">
        ${ROLES.map(
          (r) => `<label class="field" style="margin:0"><span>${r}</span>
            <input id="cfg-titolari-${r}" type="number" inputmode="numeric" value="${s.starters[r]}" data-action="setstarter" data-key="${r}" min="1" max="${s.slots[r]}"></label>`
        ).join('')}
      </div>
    </div>

    <div class="card">
      <h2>Modificatori</h2>
      <div class="switch">
        <div class="grow"><div class="lbl">Modificatore di difesa</div><div class="tiny muted">Alza il peso della difesa e premia i blocchi di club</div></div>
        <input type="checkbox" data-action="toggle" data-key="defenseModifier" ${s.defenseModifier ? 'checked' : ''}>
      </div>
      <div class="switch">
        <div class="grow"><div class="lbl">Imbattibilita' del portiere</div><div class="tiny muted">Premia il portiere titolare di una squadra solida</div></div>
        <input type="checkbox" data-action="toggle" data-key="cleanSheetModifier" ${s.cleanSheetModifier ? 'checked' : ''}>
      </div>
    </div>

    <div class="card">
      <h2>Come stimare i prezzi</h2>
      <div class="segment">
        ${[
          ['listone', 'Aste reali'],
          ['blend', 'Media'],
          ['model', 'Modello'],
        ]
          .map(([v, l]) => `<button data-action="pricesource" data-v="${v}" aria-pressed="${s.priceSource === v}">${l}</button>`)
          .join('')}
      </div>
      <div class="small muted" style="margin-top:8px">
        <b>Aste reali</b>: usa la colonna PMA, cioe' quanto quel giocatore e' stato pagato in media nelle
        altre aste. E' una rilevazione, non un'opinione, ed e' la scelta consigliata.
        <b>Modello</b>: ridistribuisce i crediti della lega in base ai punteggi, per listoni senza prezzi.
        <b>Media</b>: la via di mezzo.
      </div>
      <label class="field" style="margin-top:14px"><span>Aggressivita' del mercato sui top: ${Number(s.aggressiveness).toFixed(2)}</span>
        <input id="cfg-aggressivita" type="range" min="1" max="2.4" step="0.05" value="${s.aggressiveness}" data-action="aggr" style="width:100%">
      </label>
      <label class="field" style="margin-top:14px"><span>Quanto il mercato rincara i top rispetto ai listini: ${Number(s.ripidita ?? 1.25).toFixed(2)}</span>
        <input id="cfg-ripidita" type="range" min="1" max="1.6" step="0.05" value="${s.ripidita ?? 1.25}" data-action="ripidita" style="width:100%">
        <span class="tiny muted">1 = i prezzi dei creator cosi' come sono. 1,25 = quanto misurato in un'asta vera a otto squadre: i primi otto nomi prendono un terzo dei crediti.</span>
      </label>
      <label class="field" style="margin-top:14px"><span>Tetto per un singolo giocatore: ${Math.round((s.tettoSingolo ?? 0.33) * 100)}% del budget su una rosa da 25 (${Math.round((s.budget || 500) * (s.tettoSingolo ?? 0.33) * (25 / Math.max(1, totalSlots(s))))} crediti con la tua)</span>
        <input id="cfg-tetto" type="range" min="0.2" max="0.5" step="0.01" value="${s.tettoSingolo ?? 0.33}" data-action="tetto-singolo" style="width:100%">
        <span class="tiny muted">Il mercato comprime la cima: nell'asta vera i primi cinque attaccanti sono andati tutti fra 151 e 161, nessuno oltre un terzo del budget, anche quando i listini li distanziavano di molto.</span>
      </label>
      <div class="tiny muted">Piu' e' alta, piu' l'app si aspetta aste furiose sui big.</div>
    </div>

    <div class="card">
      <h2>Tetti di spesa per ruolo</h2>
      <p class="small muted" style="margin-top:0">Facoltativi. Vincolano il piano: lascia vuoto per lasciar decidere all'ottimizzatore.</p>
      <div class="grid4">
        ${ROLES.map(
          (r) => `<label class="field" style="margin:0"><span>${r}</span>
            <input id="cfg-tetto-${r}" type="number" inputmode="numeric" placeholder="—" value="${s.roleBudget?.[r] ?? ''}" data-action="setcap" data-key="${r}" min="0"></label>`
        ).join('')}
      </div>
    </div>

    <div class="card">
      <h2>Big in rosa</h2>
      <p class="small muted" style="margin-top:0">
        Quanti giocatori di prima fascia vuoi per reparto. Senza vincolo l'ottimizzatore compra
        valore e schiva i campioni, perche' costano piu' di quanto rendono: e' corretto sui numeri,
        ma una rosa senza big non vince le giornate. Qui decidi tu quanto pagare quel premio.
      </p>
      <div class="grid4">
        ${ROLES.map(
          (r) => `<label class="field" style="margin:0"><span>${r}</span>
            <input id="cfg-big-${r}" type="number" inputmode="numeric" value="${s.minTop?.[r] ?? 0}" data-action="setmintop" data-key="${r}" min="0" max="${s.slots[r]}"></label>`
        ).join('')}
      </div>
      <label class="field" style="margin-top:4px"><span>Chi conta come big: prime fasce fino al ${Math.round((s.topThreshold ?? 0.06) * 100)}%</span>
        <input id="cfg-soglia-big" type="range" min="0.02" max="0.25" step="0.01" value="${s.topThreshold ?? 0.06}" data-action="topthreshold" style="width:100%">
      </label>
      <div class="tiny muted">Piu' stringi, piu' "big" vuol dire solo i primissimi del reparto.</div>
    </div>

    <div class="card">
      <h2>Concentrazione per club</h2>
      <p class="small muted" style="margin-top:0">
        Con il modificatore di difesa conviene avere piu' difensori della stessa squadra: prendono voto
        alto nella stessa giornata e la soglia scatta. Ma legare mezza rosa a un solo club significa
        crollare tutti insieme se quella squadra va male. Il conteggio e' sui <b>titolari</b>: i
        riempitivi da un credito non pesano.
      </p>
      <label class="field" style="margin-bottom:0"><span>Massimo titolari dallo stesso club${s.maxPerClub ? '' : ' — nessun limite'}</span>
        <input id="cfg-maxclub" type="number" inputmode="numeric" value="${s.maxPerClub || ''}" placeholder="nessun limite" data-action="setmaxclub" min="0" max="11">
      </label>
      <div class="tiny muted" style="margin-top:6px">4 lascia passare il blocco portiere + tre difensori e ferma tutto il resto.</div>
    </div>

    ${tierEditor()}

    ${backupCard()}

    <div class="card">
      ${
        chiedeConferma
          ? `<div class="verdict stop" style="text-align:left">
               <div>Cancello listone, impostazioni e asta in corso.</div>
               <div class="small" style="font-weight:500;margin-top:4px">Non si torna indietro.</div>
             </div>
             <div class="grid2" style="margin-top:12px">
               <button class="btn danger" data-action="reset-conferma">Si', cancella</button>
               <button class="btn" data-action="reset-annulla">Annulla</button>
             </div>`
          : `<button class="btn danger block" data-action="reset">Cancella tutto e ricomincia</button>`
      }
      <div class="tiny muted center" style="margin-top:8px">Listone, impostazioni e asta in corso restano solo su questo dispositivo.</div>
    </div>
  </div>`;
}

/**
 * Il backup dell'asta.
 *
 * Tutto vive nella memoria del browser, che non e' un posto sicuro dove tenere una serata:
 * basta una finestra in incognito o un "cancella dati dei siti". E non c'era modo di passare
 * l'asta dal telefono al computer. Il file contiene tutto, listone compreso.
 */
function backupCard() {
  return `
  <div class="card">
    <h2>Backup dell'asta</h2>
    <p class="small muted" style="margin-top:0">
      Un file con tutto: listone, impostazioni e asta in corso. Serve per non perdere niente se il
      browser dimentica, e per riprendere l'asta su un altro dispositivo.
    </p>
    ${
      esitoImport
        ? `<div class="verdict ${esitoImport.ok ? 'go' : 'stop'}" style="text-align:left;margin-bottom:12px">
             <div class="small" style="font-weight:600">${esc(esitoImport.testo)}</div>
           </div>`
        : ''
    }
    ${
      chiedeImport
        ? `<div class="verdict stop" style="text-align:left">
             <div>Ripristinare sostituisce l'asta che hai adesso.</div>
             <div class="small" style="font-weight:500;margin-top:4px">
               ${
                 state.players.length
                   ? `Hai ${state.players.length} giocatori caricati e ${Object.keys(state.auction.owned || {}).length} presi. Se non l'hai gia' fatto, salva prima un file di questa.`
                   : 'Adesso non c\'e\' niente da perdere.'
               }
             </div>
           </div>
           <label class="btn block" style="margin-top:12px;text-align:center;cursor:pointer">
             Scegli il file
             <input type="file" accept="application/json,.json" data-action="importa" style="display:none">
           </label>
           <button class="btn ghost block" style="margin-top:8px" data-action="importa-annulla">Annulla</button>`
        : `<div class="grid2">
             <button class="btn primary" data-action="esporta"${state.players.length ? '' : ' disabled'}>Salva su file</button>
             <button class="btn" data-action="importa-chiedi">Ripristina</button>
           </div>
           ${state.players.length ? '' : '<div class="tiny muted center" style="margin-top:8px">Non c\'e\' ancora niente da salvare.</div>'}`
    }
  </div>`;
}

export function onAction(action, target, ev, rerender) {
  const s = state.settings;
  switch (action) {
    case 'pricesource':
      updateSettings({ priceSource: target.dataset.v });
      rerender();
      return true;
    case 'tierrole':
      state.ui.tierRole = target.dataset.role;
      rerender();
      return true;
    case 'tierup':
    case 'tierdown': {
      const role = target.dataset.role;
      const i = Number(target.dataset.i);
      const order = [...(s.tierOrder[role] || [])];
      const j = action === 'tierup' ? i - 1 : i + 1;
      if (j < 0 || j >= order.length) return true;
      [order[i], order[j]] = [order[j], order[i]];
      updateSettings({ tierOrder: { ...s.tierOrder, [role]: order } });
      rerender();
      return true;
    }
    case 'esporta': {
      const testo = esporta();
      // Dentro un iframe il download non parte e non solleva niente: il tasto sembrerebbe
      // funzionare e non farebbe assolutamente nulla, come il vecchio confirm(). Si guarda
      // dove si sta girando invece di aspettare un errore che non arriva mai.
      if (window.self !== window.top) {
        navigator.clipboard
          ?.writeText(testo)
          .then(() => toast('Qui il download e\' bloccato: l\'asta e\' negli appunti, incollala in un file.'))
          .catch(() => toast('Da questa finestra non posso salvare: apri l\'app dal suo indirizzo.'));
        return true;
      }
      const nome = nomeBackup();
      const url = URL.createObjectURL(new Blob([testo], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = nome;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revocare subito interrompe il download su alcuni browser: si lascia un attimo.
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(`Salvato ${nome}.`);
      return true;
    }
    case 'importa-chiedi':
      chiedeImport = true;
      esitoImport = null;
      rerender();
      return true;
    case 'importa-annulla':
      chiedeImport = false;
      rerender();
      return true;
    case 'reset':
      chiedeConferma = true;
      rerender();
      return true;
    case 'reset-annulla':
      chiedeConferma = false;
      rerender();
      return true;
    case 'reset-conferma':
      chiedeConferma = false;
      resetAll();
      toast('Tutto azzerato.');
      rerender();
      return true;
    default:
      return false;
  }
}

/**
 * `kind` distingue il tasto premuto dall'uscita dal campo.
 *
 * Serve per i campi di testo: ridisegnare a ogni carattere costava un ricalcolo del piano e
 * una riscrittura dell'intero listone in memoria, e — non avendo i campi un id — il fuoco
 * finiva nel nulla dopo la prima lettera. Rinominare una squadra era di fatto impossibile.
 */
export function onInput(action, target, rerender, kind = 'input') {
  const s = state.settings;
  switch (action) {
    case 'importa': {
      const file = target.files && target.files[0];
      if (!file) return true;
      file
        .text()
        .then((testo) => {
          const esito = importa(testo);
          chiedeImport = false;
          esitoImport = esito.ok
            ? {
                ok: true,
                testo: `Asta ripristinata: ${esito.giocatori} giocatori, ${esito.presi} gia' presi${
                  esito.salvatoIl ? ` (backup del ${new Date(esito.salvatoIl).toLocaleString('it-IT')})` : ''
                }.`,
              }
            : { ok: false, testo: esito.motivo };
          rerender();
        })
        .catch(() => {
          esitoImport = { ok: false, testo: 'Non riesco a leggere il file.' };
          rerender();
        });
      return true;
    }
    case 'set': {
      const v = Math.max(1, Number(target.value) || 0);
      updateSettings({ [target.dataset.key]: v });
      rerender({ keepFocus: target.id });
      return true;
    }
    case 'setslot': {
      const slots = { ...s.slots, [target.dataset.key]: Math.max(0, Number(target.value) || 0) };
      const starters = { ...s.starters };
      // I titolari non possono superare gli slot disponibili.
      for (const r of ROLES) starters[r] = Math.min(starters[r], Math.max(1, slots[r]));
      updateSettings({ slots, starters });
      rerender({ keepFocus: target.id });
      return true;
    }
    case 'setstarter': {
      const r = target.dataset.key;
      const v = Math.min(Math.max(1, Number(target.value) || 1), s.slots[r] || 1);
      updateSettings({ starters: { ...s.starters, [r]: v } });
      rerender({ keepFocus: target.id });
      return true;
    }
    case 'setcap': {
      const raw = target.value.trim();
      updateSettings({ roleBudget: { ...s.roleBudget, [target.dataset.key]: raw === '' ? null : Math.max(0, Number(raw) || 0) } });
      rerender({ keepFocus: target.id });
      return true;
    }
    case 'setmintop': {
      const r = target.dataset.key;
      const v = Math.min(Math.max(0, Number(target.value) || 0), s.slots[r] || 0);
      updateSettings({ minTop: { ...s.minTop, [r]: v } });
      rerender({ keepFocus: target.id });
      return true;
    }
    case 'topthreshold':
      updateSettings({ topThreshold: Number(target.value) });
      rerender({ keepFocus: target.id });
      return true;
    case 'setsquadra': {
      // Un nome di squadra non entra in nessun calcolo: si annota e si salva, senza rivalutare
      // il listone ne' rifare il piano. E mentre si scrive non si ridisegna niente — il
      // carattere e' gia' a schermo, e ridisegnare vuol dire perdere il cursore.
      const i = Number(target.dataset.i);
      const uscito = kind !== 'input';
      const squadre = nomiSquadre(s);
      squadre[i] = uscito ? target.value.trim() || (i === 0 ? 'Io' : `Squadra ${i + 1}`) : target.value;
      rinominaSquadre(squadre);
      if (uscito) rerender({ keepFocus: target.id });
      return true;
    }
    case 'setmaxclub': {
      const raw = target.value.trim();
      updateSettings({ maxPerClub: raw === '' ? 0 : Math.max(0, Number(raw) || 0) });
      rerender({ keepFocus: target.id });
      return true;
    }
    case 'toggle':
      updateSettings({ [target.dataset.key]: target.checked });
      rerender();
      return true;
    case 'aggr':
      updateSettings({ aggressiveness: Number(target.value) });
      rerender({ keepFocus: target.id });
      return true;
    case 'ripidita':
      updateSettings({ ripidita: Number(target.value) });
      rerender({ keepFocus: target.id });
      return true;
    case 'tetto-singolo':
      updateSettings({ tettoSingolo: Number(target.value) });
      rerender({ keepFocus: target.id });
      return true;
    default:
      return false;
  }
}
