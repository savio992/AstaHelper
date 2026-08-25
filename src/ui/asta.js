// La schermata che uso durante l'asta: crediti, offerta massima, alternative.

import { state, assign, release, undo, ownedMap, unavailableSet, takenMap, playerById, creditsLeft, rebuildPlan } from '../store.js';
import { ROLES, ROLE_LABEL, ROLE_LABEL_SHORT, totalSlots } from '../domain/model.js';
import { maxBid, alternatives, maxSpendableNow, slotsLeftByRole, budgetDiFase, pianoDiReparto, abbinamentoPortiere } from '../domain/advisor.js';
import { concorrenza, concorrenzaPerRuolo, verdettoConcorrenza, nomiSquadre, disponibilita } from '../domain/mercato.js';
import { esc, roleChip, matches, playerRow, emptyState, toast, edgeBadge, altVerdict } from './common.js';

// I calcoli d'asta costano decine di millisecondi: li teniamo in cache finche' non cambia nulla.
let cache = { key: null, bid: null, alts: null };
let pending = false;

function cacheKey() {
  return `${state.ui.selectedId}|${state.auction.log.length}|${JSON.stringify(state.settings)}`;
}

export function invalidate() {
  cache = { key: null, bid: null, alts: null };
  reparto = null;
}

function ensureAdvice(rerender) {
  const key = cacheKey();
  if (cache.key === key || !state.ui.selectedId || pending) return;
  pending = true;
  // Un frame di respiro cosi' lo spinner viene disegnato prima del calcolo.
  setTimeout(() => {
    try {
      const args = {
        players: state.players,
        settings: state.settings,
        owned: ownedMap(),
        unavailable: unavailableSet(),
        playerId: state.ui.selectedId,
      };
      cache = { key, bid: maxBid(args), alts: alternatives({ ...args, limit: 5 }) };
    } catch (err) {
      console.error(err);
      cache = { key, bid: null, alts: null };
    } finally {
      pending = false;
      rerender();
    }
  }, 16);
}

function hud() {
  const left = creditsLeft();
  const budget = state.settings.budget || 500;
  const owned = ownedMap();
  const slots = slotsLeftByRole(state.settings, state.players, owned);
  const filled = owned.size;
  const pct = Math.max(0, Math.min(100, (left / budget) * 100));
  const fase = budgetDiFase({ settings: state.settings, players: state.players, owned, plan: state.plan });
  const sforato = fase.spesoFase > fase.pianificatoFase && fase.pianificatoFase > 0;
  return `
  <div class="card">
    <div class="hud">
      <div class="credits mono">${left}<small>crediti liberi</small></div>
      <div>
        <div class="bar"><i style="width:${pct}%" class="${left < 0 ? 'over' : ''}"></i></div>
        <div class="row between small muted" style="margin-top:6px">
          <span>${filled}/${totalSlots(state.settings)} slot</span>
          <span>max su un giocatore: <b class="mono">${fase.massimoOra}</b></span>
        </div>
      </div>
    </div>
    <div class="slotbar" style="margin-top:12px">
      ${ROLES.map(
        (r) =>
          `<div style="${r === fase.fase ? 'outline:2px solid var(--accent);outline-offset:-2px' : ''}"><b class="mono">${slots[r]}</b><span>${
            r === 'P' ? 'POR' : r === 'D' ? 'DIF' : r === 'C' ? 'CEN' : 'ATT'
          }</span></div>`
      ).join('')}
    </div>
    <div class="row between small" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
      <span class="muted">si gioca sui <b style="color:var(--text)">${esc(fase.etichetta.toLowerCase())}</b></span>
      <span class="muted"><b class="mono" style="color:var(--${sforato ? 'danger' : 'text'})">${fase.perLaFase}</b> per il reparto ·
        <b class="mono">${fase.riservatoDopo}</b> riservati al resto</span>
    </div>
    ${climaCard(fase)}
  </div>`;
}

/**
 * La riga che dice com'e' l'aria nel reparto in corso.
 *
 * Sono due conteggi che e' facilissimo confondere e che decidono il prezzo: quanti posti
 * restano in palio in tutta la lega, e quanti giocatori restano liberi fra cui scegliere.
 * Possono essere due posti e quaranta nomi: vuol dire che quei posti sono miei e nessuno
 * me li contende, ed e' il momento di prenderli per un credito invece di rilanciare.
 */
function climaCard(fase) {
  if (!state.mercato) return '';
  const owned = ownedMap();
  const c = concorrenza({
    settings: state.settings,
    players: state.players,
    owned,
    taken: takenMap(),
    role: fase.fase,
    tabellone: state.tabellone,
  });
  const d = disponibilita({ settings: state.settings, players: state.players, owned, mercato: state.mercato })[fase.fase];
  if (!d.servono) return '';

  let frase;
  let colore;
  if (!c.quanti) {
    frase =
      d.servono === 1
        ? `Nessuno te lo contende piu': l'ultimo lo prendi a un credito.`
        : `Nessuno te li contende piu': i tuoi ${d.servono} li prendi a un credito l'uno.`;
    colore = 'accent';
  } else if (d.critico) {
    frase = `Restano ${d.liberi} nomi liberi e te ne servono ${d.servono}: non puoi permetterti di perderne.`;
    colore = 'danger';
  } else if (!c.attendibile) {
    frase = `${c.quanti} avversari ne cercano ancora. Segna a chi vanno i giocatori e ti dico fin dove possono spingersi.`;
    colore = 'muted';
  } else {
    frase = `${c.quanti} avversari ne cercano ancora, il piu' ricco puo' arrivare a ${c.massimo}. Nomi liberi: ${d.liberi}.`;
    colore = 'text';
  }
  return `<div class="small" style="margin-top:8px;color:var(--${colore})">${frase}</div>`;
}

/**
 * Riepilogo di cosa e' impostato, prima che l'asta cominci.
 * Atterrare su una schermata con una casella di ricerca vuota non dice cosa fare:
 * qui si vede a colpo d'occhio se manca qualcosa e dove andare a metterlo.
 */
function readyCard() {
  const s = state.settings;
  const plan = state.plan;
  const passi = [
    {
      fatto: state.sources.length > 0,
      titolo: state.sources.length
        ? `Listone: ${state.sources.map((x) => esc(x.name)).join(' + ')}`
        : 'Carica il listone del creator',
      tab: 'listone',
    },
    {
      fatto: true,
      titolo: `${s.participants} squadre · ${s.budget} crediti · ${s.slots.P}-${s.slots.D}-${s.slots.C}-${s.slots.A}`,
      nota: [s.defenseModifier ? 'mod. difesa' : null, s.cleanSheetModifier ? 'imbattibilita' : null]
        .filter(Boolean)
        .join(' + ') || 'nessun modificatore',
      tab: 'setup',
    },
    {
      fatto: !!plan?.ok,
      titolo: plan?.ok ? `Piano pronto: ${plan.cost} crediti impegnati` : 'Piano non ancora calcolato',
      tab: 'piano',
    },
  ];
  return `
  <div class="card">
    <h2>Prima di cominciare</h2>
    ${passi
      .map(
        (x) => `<div class="switch" data-action="goto" data-tab="${x.tab}">
          <div class="grow">
            <div class="lbl">${x.fatto ? '✓' : '○'} ${x.titolo}</div>
            ${x.nota ? `<div class="tiny muted">${esc(x.nota)}</div>` : ''}
          </div>
          <span class="muted">›</span>
        </div>`
      )
      .join('')}
  </div>`;
}

function verdictFor(price, bid) {
  if (!bid) return '';
  if (bid.maxBid <= 0) return `<div class="verdict stop">Lascialo andare: non migliora la rosa.</div>`;
  if (price > bid.maxBid) return `<div class="verdict stop">Fermati. Oltre ${bid.maxBid} conviene il piano B.</div>`;
  if (price >= bid.maxBid - Math.max(1, Math.round(bid.maxBid * 0.08)))
    return `<div class="verdict edge">Sei al limite: puoi arrivare a ${bid.maxBid}, non oltre.</div>`;
  return `<div class="verdict go">Rilancia pure: hai margine fino a ${bid.maxBid}.</div>`;
}

function detail(p) {
  const owned = ownedMap();
  const status = state.auction.owned[p.id] !== undefined ? 'mine' : state.auction.taken[p.id] !== undefined ? 'other' : null;
  const bid = cache.key === cacheKey() ? cache.bid : null;
  const alts = cache.key === cacheKey() ? cache.alts : null;
  const inPlan = state.plan?.picks?.some((x) => x.id === p.id);
  const planned = state.plan?.picks?.find((x) => x.id === p.id)?.plannedPrice;
  const current = state.ui.bidPrice ?? Math.round(p.expectedPrice ?? 1);
  const spendable = maxSpendableNow(state.settings, owned);
  const fase = budgetDiFase({ settings: state.settings, players: state.players, owned, plan: state.plan, role: p.role });

  const paid = status === 'mine' ? state.auction.owned[p.id] : status === 'other' ? state.auction.taken[p.id] : null;

  return `
  <div class="card">
    <div class="row between" style="align-items:flex-start">
      <div class="grow">
        <h3 style="margin-bottom:4px">${esc(p.name)}</h3>
        <div class="row wrap" style="gap:6px">
          ${roleChip(p.role)}
          <span class="chip">${esc(p.team || '—')}</span>
          ${p.tier ? `<span class="chip">${esc(p.tier)}</span>` : ''}
          ${inPlan ? '<span class="chip plan">In piano</span>' : ''}
          ${edgeBadge(p)}
          ${status === 'mine' ? `<span class="chip mine">Mio a ${paid}</span>` : ''}
          ${status === 'other' ? `<span class="chip gone">Preso da altri a ${paid}</span>` : ''}
        </div>
      </div>
      <button class="btn ghost" data-action="close-detail" aria-label="Chiudi">✕</button>
    </div>

    ${creatorInfo(p)}

    ${
      status
        ? `<div style="margin-top:14px"><button class="btn block" data-action="release" data-id="${esc(p.id)}">Annulla assegnazione</button></div>`
        : `
    <div class="maxbid">
      ${
        bid
          ? `<div class="n mono ${bid.maxBid <= 0 ? 'zero' : ''}">${bid.maxBid}</div>
             <div class="lbl">fin qui conviene</div>
             ${ripiego(alts)}
             ${bid.reason ? `<div class="small muted" style="margin-top:6px">${esc(bid.reason)}</div>` : ''}
             ${concorrenzaBox(p, bid)}`
          : `<div class="n mono"><span class="spinner"></span></div><div class="lbl">calcolo in corso</div>`
      }
    </div>

    <div class="row between small muted" style="margin-bottom:10px">
      <span>prezzo atteso <b class="mono">${Math.round(p.expectedPrice ?? 0)}</b></span>
      ${planned ? `<span>a piano <b class="mono">${planned}</b></span>` : ''}
      <span>ti resta per il reparto <b class="mono">${fase.perLaFase}</b></span>
    </div>

    <div class="stepper">
      <button class="btn" data-action="bid-minus">−</button>
      <input type="number" inputmode="numeric" class="mono" id="bidprice" value="${current}" min="0" max="${spendable}" data-action="bid-input">
      <button class="btn" data-action="bid-plus">+</button>
    </div>
    <div style="margin-top:10px">${
      current > fase.massimoOra && fase.slotMancanti > 0
        ? `<div class="verdict stop">A ${current} sfori il reparto: resteresti senza crediti per ${esc(
            (state.settings.auctionOrder || ROLES).slice((state.settings.auctionOrder || ROLES).indexOf(p.role) + 1).map((r) => ROLE_LABEL[r].toLowerCase()).join(' e ')
          ) || 'il resto'}.</div>`
        : verdictFor(current, bid)
    }</div>

    ${
      state.ui.chiediSquadra === p.id
        ? `<div style="margin-top:12px">
             <div class="small muted" style="margin-bottom:8px">A chi e' andato? Serve a sapere fin dove possono spingersi gli altri.</div>
             <div class="row wrap" style="gap:6px">
               ${nomiSquadre(state.settings)
                 .map((nome, i) =>
                   i === 0
                     ? ''
                     : `<button class="btn" style="flex:1 1 30%;min-width:88px" data-action="assign-to" data-id="${esc(p.id)}" data-idx="${i}">${esc(nome)}</button>`
                 )
                 .join('')}
               <button class="btn ghost" style="flex:1 1 100%" data-action="assign-to" data-id="${esc(p.id)}" data-idx="">non lo so</button>
             </div>
           </div>`
        : `<div class="grid2" style="margin-top:12px">
             <button class="btn primary" data-action="take-mine" data-id="${esc(p.id)}">L'ho preso io</button>
             <button class="btn danger" data-action="take-other" data-id="${esc(p.id)}">Preso da altri</button>
           </div>`
    }`
    }
  </div>

  ${status === 'other' || !status ? altsCard(p, alts) : ''}
  `;
}

/**
 * Chi puo' ancora contendermelo, e fino a quanto.
 * Un giocatore non costa quello che vale: costa un credito piu' di quanto puo' pagare il
 * secondo miglior offerente. Se quel numero e' sotto la mia offerta massima, l'asta e' gia'
 * decisa e ogni credito speso oltre quella soglia e' buttato.
 */
function concorrenzaBox(p, bid) {
  if (!bid || bid.maxBid <= 0) return '';
  const conc = concorrenza({
    settings: state.settings,
    players: state.players,
    owned: ownedMap(),
    taken: takenMap(),
    role: p.role,
    tabellone: state.tabellone,
  });
  const v = verdettoConcorrenza({ mioMassimo: bid.maxBid, conc });
  const classe = v.esito === 'tuo' || v.esito === 'nessuno' ? 'go' : v.esito === 'conteso' ? 'edge' : '';
  return `<div class="verdict ${classe}" style="margin-top:10px;text-align:left">
    <div class="small" style="font-weight:600">${esc(v.testo)}</div>
  </div>`;
}

/** Un numero da solo non basta: si dice a chi si ripiega, con nome e prezzo. */
function ripiego(alts) {
  const first = alts?.alternatives?.[0];
  if (!first) return '';
  return `<div class="small muted" style="margin-top:8px">se lo superi, meglio <b>${esc(first.player.name)}</b> a ${first.price}</div>`;
}

/** Quello che i creators dicono di lui: giudizi, etichette, disaccordo sul prezzo. */
function creatorInfo(p) {
  const bits = [];
  if (Number.isFinite(p.titolarita)) bits.push(`titolarita' ${'●'.repeat(Math.round(p.titolarita))}${'○'.repeat(5 - Math.round(p.titolarita))}`);
  if (Number.isFinite(p.integrita)) bits.push(`integrita' ${'●'.repeat(Math.round(p.integrita))}${'○'.repeat(5 - Math.round(p.integrita))}`);
  if (Number.isFinite(p.expShare)) bits.push(`~${Math.round(p.expShare * 38)} presenze attese`);

  // Quanto costa davvero contro quanto dicono che valga, creator per creator.
  const fonti = p.consigliatoBySource ? Object.entries(p.consigliatoBySource) : [];
  const valutazioni = fonti.length
    ? `<div class="small" style="margin-top:10px">
         <div class="muted">pagato in media <b class="mono" style="color:var(--text)">${Math.round(p.expectedPrice)}</b> nelle altre aste</div>
         <div class="muted" style="margin-top:2px">lo valutano: ${fonti
           .map(([src, v]) => `${esc(src)} <b class="mono" style="color:var(--${v > p.expectedPrice ? 'accent' : v < p.expectedPrice ? 'danger' : 'text'})">${v}</b>`)
           .join(' · ')}</div>
       </div>`
    : '';

  const disagreement =
    fonti.length > 1 && Math.max(...fonti.map((f) => f[1])) > Math.min(...fonti.map((f) => f[1])) * 1.35
      ? `<div class="verdict edge" style="margin-top:10px;text-align:left">
           I creators non sono d'accordo su di lui. Se va via vicino alla valutazione piu' bassa, e' un affare.
         </div>`
      : '';

  const tiers = p.tiersBySource
    ? Object.entries(p.tiersBySource).map(([src, tier]) => `<span class="chip">${esc(src)}: ${esc(tier)}</span>`).join(' ')
    : '';

  if (!bits.length && !p.tags?.length && !valutazioni && !p.notes) return '';

  return `
  <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
    ${bits.length ? `<div class="small muted mono">${bits.join(' · ')}</div>` : ''}
    ${p.tags?.length ? `<div class="row wrap" style="gap:5px;margin-top:8px">${p.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
    ${tiers ? `<div class="row wrap" style="gap:5px;margin-top:8px">${tiers}</div>` : ''}
    ${valutazioni}
    ${disagreement}
    ${
      p.notes
        ? `<details style="margin-top:10px" ${p.notes.length < 320 ? 'open' : ''}>
             <summary class="small muted">Cosa dicono i creators di lui</summary>
             <div class="small" style="margin-top:6px;white-space:pre-wrap;line-height:1.55">${esc(p.notes)}</div>
           </details>`
        : ''
    }
  </div>`;
}

function altsCard(p, alts) {
  if (!alts) {
    return `<div class="card"><h2>Se lo perdo</h2><div class="small muted"><span class="spinner"></span> Ricalcolo la rosa senza di lui…</div></div>`;
  }
  if (!alts.alternatives.length) {
    return `<div class="card"><h2>Se lo perdo</h2><div class="small muted">Nessuna alternativa sostenibile con i crediti rimasti.</div></div>`;
  }
  return `
  <div class="card">
    <h2>Se lo perdo</h2>
    <div class="small muted" style="margin-bottom:10px">
      Rosa ricalcolata senza di lui, confrontata con l'averlo preso al suo prezzo atteso.
    </div>
    ${alts.alternatives
      .map((a) => {
        const v = altVerdict(a.deltaVsTarget, p.score);
        return `
      <div class="alt" data-action="select" data-id="${esc(a.player.id)}">
        ${roleChip(a.player.role)}
        <div class="grow">
          <div class="nm">${esc(a.player.name)} ${edgeBadge(a.player)}</div>
          <div class="sub small muted">${esc(a.player.team || '—')}${a.player.tier ? ' · ' + esc(a.player.tier) : ''}</div>
        </div>
        <div style="text-align:right">
          <div class="mono" style="font-weight:800">${a.price}<span class="tiny muted"> cr</span></div>
          <div class="tiny ${v.classe === 'pos' ? '' : v.classe === 'neg' ? '' : ''}" style="color:var(--${v.classe === 'pos' ? 'accent' : v.classe === 'neg' ? 'danger' : 'muted'})">${v.parola}</div>
        </div>
      </div>`;
      })
      .join('')}
  </div>`;
}

// Il piano del reparto costa una decina di ottimizzazioni complete: si prepara su richiesta
// e vale finche' non cambia nulla.
let reparto = null;
let repartoInCorso = false;

function buildReparto(rerender) {
  repartoInCorso = true;
  setTimeout(() => {
    try {
      const args = { players: state.players, settings: state.settings, owned: ownedMap(), unavailable: unavailableSet() };
      const piano = pianoDiReparto({ ...args, plan: state.plan });
      reparto = piano
        ? {
            ...piano,
            chiave: cacheKey(),
            portiere: piano.fase === 'P' ? abbinamentoPortiere({ ...args, plan: state.plan }) : null,
          }
        : null;
    } catch (err) {
      console.error(err);
      reparto = null;
    } finally {
      repartoInCorso = false;
      rerender();
    }
  }, 30);
}

/**
 * Il piano d'azione del reparto in corso.
 *
 * Durante la chiamata non c'e' tempo di ricalcolare niente: il ramo deve essere gia' deciso.
 * Per ogni obiettivo il tetto oltre il quale si lascia perdere e i due ripieghi in ordine, e
 * in fondo lo scenario in cui saltano tutti, con la destinazione dei crediti che si liberano.
 */
function repartoCard() {
  if (!state.plan?.ok) return '';
  if (repartoInCorso) {
    return `<div class="card"><h2>Piano del reparto</h2><div class="small muted"><span class="spinner"></span> Preparo obiettivi, tetti e ripieghi…</div></div>`;
  }
  if (!reparto || reparto.chiave !== cacheKey()) {
    const fase = budgetDiFase({ settings: state.settings, players: state.players, owned: ownedMap(), plan: state.plan });
    return `
    <div class="card">
      <h2>Piano del reparto</h2>
      <p class="small muted" style="margin-top:0">
        Si gioca sui <b>${esc(fase.etichetta.toLowerCase())}</b>. Preparo obiettivi, tetto massimo su ciascuno,
        ripieghi in ordine e cosa fare se saltano tutti.
      </p>
      <button class="btn primary block" data-action="reparto">Prepara il piano dei ${esc(fase.etichetta.toLowerCase())}</button>
    </div>`;
  }

  const r = reparto;
  return `
  <div class="card">
    <div class="row between" style="margin-bottom:4px">
      <h2 style="margin:0">Piano · ${esc(r.etichetta)}</h2>
      <button class="btn ghost small" data-action="reparto">Rifai</button>
    </div>
    <div class="tiny muted" style="margin-bottom:12px">
      ${r.budget.perLaFase} crediti per il reparto · ${r.budget.slotMancanti} slot da riempire ·
      ${r.budget.riservatoDopo} riservati ai reparti dopo
    </div>

    ${r.obiettivi
      .map(
        (o, i) => `
      <div style="padding:10px 0;${i ? 'border-top:1px solid var(--line)' : ''}">
        <div class="row between">
          <div class="grow" data-action="select" data-id="${esc(o.player.id)}">
            <div><b>${i + 1}. ${esc(o.player.name)}</b> ${edgeBadge(o.player)}</div>
            <div class="tiny muted">${esc(o.player.team || '—')}${o.player.tier ? ' · ' + esc(o.player.tier) : ''} · a piano ${o.prezzoPiano}</div>
          </div>
          <div class="mono" style="text-align:right">
            <b style="font-size:19px;color:var(--${o.sostituibile ? 'muted' : 'accent'})">${o.massimo}</b>
            <div class="tiny muted">non oltre</div>
          </div>
        </div>
        ${o.sostituibile ? `<div class="tiny muted" style="margin-top:4px">Sostituibile: sopra ${o.massimo} conviene chiunque altro, non insistere.</div>` : ''}
        ${
          o.ripieghi.length
            ? `<div class="tiny muted" style="margin-top:6px">se salta → ${o.ripieghi
                .map((x) => `<b style="color:var(--text)">${esc(x.player.name)}</b> ${x.price}`)
                .join(' , poi ')}</div>`
            : ''
        }
      </div>`
      )
      .join('')}

    ${
      r.portiere && !r.portiere.fatto && r.portiere.coppia
        ? `<div class="verdict edge" style="margin-top:12px;text-align:left">
             <div>Abbinamento: prendi anche ${esc(r.portiere.coppia.name)}.</div>
             <div class="small" style="font-weight:500;margin-top:4px">
               E' il secondo portiere ${esc(r.portiere.titolare.team || '')}, la stessa porta di ${esc(r.portiere.titolare.name)}.
               In Classic ne schieri uno solo: averli entrambi significa non restare mai senza voto,
               e con l'imbattibilita' il clean sheet arriva comunque da quella difesa.
             </div>
           </div>`
        : r.portiere && r.portiere.fatto
          ? `<div class="tiny muted" style="margin-top:12px">Abbinamento portieri a posto: hai due porte della stessa squadra.</div>`
          : ''
    }

    ${
      r.senzaNessuno
        ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
             <div class="tiny muted" style="margin-bottom:4px">se li perdi tutti</div>
             <div class="small">
               Vai su <b>${r.senzaNessuno.picks.map((x) => esc(x.name) + ' (' + x.plannedPrice + ')').join(', ')}</b>
               ${
                 r.senzaNessuno.liberati > 5
                   ? `e sposti ${r.senzaNessuno.liberati} crediti ${
                       r.senzaNessuno.destinazione.length
                         ? 'su ' + r.senzaNessuno.destinazione.map((d) => `${ROLE_LABEL[d.role].toLowerCase()} (+${d.delta})`).join(' e ')
                         : 'sugli altri reparti'
                     }`
                   : ''
               }.
             </div>
             <div class="tiny muted" style="margin-top:6px">costo del cambio di piano: ${r.senzaNessuno.costo} punti</div>
           </div>`
        : ''
    }
  </div>`;
}

function targetsCard() {
  const plan = state.plan;
  if (!plan?.ok) return '';
  const pending = plan.picks.filter((p) => !state.auction.owned[p.id] && !state.auction.taken[p.id]);
  if (!pending.length) return '';
  const fase = budgetDiFase({ settings: state.settings, players: state.players, owned: ownedMap(), plan });
  const adesso = pending.filter((p) => p.role === fase.fase).sort((a, b) => b.plannedPrice - a.plannedPrice);
  const dopo = ROLES.filter((r) => r !== fase.fase).flatMap((r) =>
    pending.filter((p) => p.role === r).sort((a, b) => b.plannedPrice - a.plannedPrice)
  );

  const riga = (p) => `<li>
    ${roleChip(p.role)}
    <div class="grow" data-action="select" data-id="${esc(p.id)}">
      <div class="nm">${esc(p.name)}</div>
      <div class="sub">${esc(p.team || '—')}${p.tier ? ' · ' + esc(p.tier) : ''}</div>
    </div>
    <div class="pr mono" data-action="select" data-id="${esc(p.id)}">${p.plannedPrice}<small>a piano</small></div>
    <button class="btn danger" style="min-width:46px;padding:10px" data-action="quick-gone" data-id="${esc(p.id)}" aria-label="Preso da un avversario">✕</button>
  </li>`;

  return `
  <div class="card">
    <div class="row between" style="margin-bottom:8px">
      <h2 style="margin:0">Obiettivi · ${esc(fase.etichetta.toLowerCase())}</h2>
      <span class="tiny muted">${adesso.length}</span>
    </div>
    ${
      adesso.length
        ? `<div class="tiny muted" style="margin-bottom:10px">
             Tocca <b>✕</b> quando uno di questi va a un avversario: un solo tocco, senza prezzo.
           </div>
           <div class="listwrap"><ul class="plist">${adesso.map(riga).join('')}</ul></div>`
        : `<div class="small muted" style="padding:6px 0">Nessun obiettivo scoperto in questo reparto.</div>`
    }
    ${
      dopo.length
        ? `<details style="margin-top:12px">
             <summary class="small muted">Gli obiettivi dei reparti dopo (${dopo.length})</summary>
             <div class="listwrap" style="margin-top:8px"><ul class="plist">${dopo.map(riga).join('')}</ul></div>
           </details>`
        : ''
    }
  </div>`;
}

/**
 * Chi sta per essere chiamato.
 *
 * Digitare mentre il banditore urla un nome e' il vero attrito di questa schermata, e quasi
 * sempre e' inutile: in un'asta per reparto si chiamano i piu' cari del ruolo in corso, che
 * l'app conosce gia'. La ricerca resta li' per le sorprese.
 */
function prossimeChiamate() {
  if (!state.plan?.ok) return '';
  const owned = ownedMap();
  const fase = budgetDiFase({ settings: state.settings, players: state.players, owned, plan: state.plan });
  const obiettivi = new Set((state.plan.picks || []).map((p) => p.id));
  // Il filtro in alto vale anche qui: se scelgo un ruolo voglio vedere quello, non la fase.
  const ruolo = state.ui.roleFilter === 'ALL' ? fase.fase : state.ui.roleFilter;
  const lista = state.players
    .filter(
      (p) =>
        p.role === ruolo &&
        state.auction.owned[p.id] === undefined &&
        state.auction.taken[p.id] === undefined
    )
    .sort((a, b) => (b.expectedPrice ?? 0) - (a.expectedPrice ?? 0))
    .slice(0, 6);
  if (!lista.length) return '';
  return `
  <div style="margin-top:12px">
    <div class="tiny muted" style="margin-bottom:6px">${
      state.ui.roleFilter === 'ALL' ? "i piu' probabili adesso — tocca senza cercare" : `i piu' cari ancora liberi — ${esc(ROLE_LABEL[ruolo].toLowerCase())}`
    }</div>
    <div class="listwrap"><ul class="plist">
      ${lista
        .map((p) => playerRow(p, { inPlan: obiettivi.has(p.id), selected: p.id === state.ui.selectedId }))
        .join('')}
    </ul></div>
  </div>`;
}

export function render(rerender) {
  if (!state.players.length) {
    return `<div class="view">${emptyState('📋', 'Nessun listone caricato', 'Vai su <b>Listone</b> e importa il CSV delle fasce dei creators.')}</div>`;
  }
  if (!state.plan) rebuildPlan();

  const selected = state.ui.selectedId ? playerById(state.ui.selectedId) : null;
  if (selected) ensureAdvice(rerender);

  const q = state.ui.query;
  const roleFilter = state.ui.roleFilter;
  let results = [];
  if (q.trim()) {
    results = state.players
      .filter((p) => (roleFilter === 'ALL' || p.role === roleFilter) && matches(p, q))
      .sort((a, b) => (b.expectedPrice ?? 0) - (a.expectedPrice ?? 0))
      .slice(0, 40);
  }

  return `
  <div class="view">
    ${hud()}

    <div class="card">
      <input type="search" id="astaQuery" placeholder="Chi stanno chiamando?" value="${esc(q)}" data-action="query" autocomplete="off" autocorrect="off" spellcheck="false">
      <div class="segment" style="margin-top:10px">
        ${['ALL', ...ROLES]
          .map(
            (r) =>
              `<button data-action="rolefilter" data-role="${r}" aria-pressed="${roleFilter === r}">${r === 'ALL' ? 'Tutti' : r}</button>`
          )
          .join('')}
      </div>
      ${
        results.length
          ? `<div class="listwrap" style="margin-top:12px"><ul class="plist">${results
              .map((p) =>
                playerRow(p, {
                  status: state.auction.owned[p.id] !== undefined ? 'mine' : state.auction.taken[p.id] !== undefined ? 'other' : null,
                  selected: p.id === state.ui.selectedId,
                  inPlan: state.plan?.picks?.some((x) => x.id === p.id),
                })
              )
              .join('')}</ul></div>`
          : q.trim()
            ? `<div class="small muted center" style="padding:14px">Nessun giocatore trovato.</div>`
            : prossimeChiamate()
      }
    </div>

    ${selected ? detail(selected) : ''}
    ${!selected && !state.auction.log.length ? readyCard() : ''}
    ${selected ? '' : repartoCard()}
    ${selected ? '' : targetsCard()}

    <div class="row" style="gap:10px">
      <button class="btn grow" data-action="undo" ${state.auction.log.length ? '' : 'disabled'}>↩︎ Annulla ultima</button>
    </div>
  </div>`;
}

export function onAction(action, target, ev, rerender) {
  const id = target.dataset.id;
  switch (action) {
    case 'select':
      state.ui.selectedId = id;
      state.ui.bidPrice = null;
      state.ui.chiediSquadra = null;
      rerender();
      return true;
    case 'close-detail':
      state.ui.selectedId = null;
      state.ui.bidPrice = null;
      state.ui.chiediSquadra = null;
      rerender();
      return true;
    case 'rolefilter':
      state.ui.roleFilter = target.dataset.role;
      rerender();
      return true;
    case 'bid-minus':
    case 'bid-plus': {
      const input = document.getElementById('bidprice');
      const step = action === 'bid-plus' ? 1 : -1;
      state.ui.bidPrice = Math.max(0, (Number(input?.value) || 0) + step);
      rerender();
      return true;
    }
    case 'take-mine': {
      const price = Number(document.getElementById('bidprice')?.value) || 0;
      const p = playerById(id);
      const spendable = maxSpendableNow(state.settings, ownedMap());
      if (price > spendable) {
        toast(`Non puoi spendere ${price}: il tetto e' ${spendable}.`);
        return true;
      }
      assign(id, 'mine', price);
      invalidate();
      state.ui.selectedId = null;
      state.ui.bidPrice = null;
      state.ui.query = '';
      toast(`${p?.name} tuo a ${price}.`);
      rerender();
      return true;
    }
    case 'take-other': {
      // Il prezzo lo prendo adesso, perche' il campo sparisce quando chiedo la squadra.
      state.ui.prezzoAltri = Number(document.getElementById('bidprice')?.value) || 0;
      state.ui.chiediSquadra = id;
      rerender();
      return true;
    }
    case 'assign-to': {
      const idx = target.dataset.idx === '' ? null : Number(target.dataset.idx);
      const p = playerById(id);
      const prezzo = state.ui.prezzoAltri ?? 0;
      assign(id, 'other', prezzo, idx);
      invalidate();
      state.ui.chiediSquadra = null;
      state.ui.prezzoAltri = null;
      state.ui.selectedId = null;
      state.ui.bidPrice = null;
      state.ui.query = '';
      const nome = idx ? nomiSquadre(state.settings)[idx] : 'un avversario';
      toast(`${p?.name} a ${nome}${prezzo ? ' per ' + prezzo : ''}.`);
      rerender();
      return true;
    }
    case 'reparto':
      reparto = null;
      buildReparto(rerender);
      rerender();
      return true;
    case 'goto':
      state.ui.tab = target.dataset.tab;
      rerender();
      return true;
    case 'quick-gone': {
      const p = playerById(id);
      // La corsia veloce: un tocco, nessuna domanda. Il prezzo resta ignoto e il conto dei
      // crediti lo imputa dalla stima, dichiarando la copertura. Serve a non perdere un
      // rilancio per stare a digitare: gli slot residui restano comunque esatti.
      assign(id, 'other', 0, null);
      invalidate();
      toast(`${p?.name} va via.`);
      rerender();
      return true;
    }
    case 'release':
      release(id);
      invalidate();
      rerender();
      return true;
    case 'undo':
      undo();
      invalidate();
      state.ui.selectedId = null;
      rerender();
      return true;
    default:
      return false;
  }
}

export function onInput(action, target, rerender) {
  if (action === 'query') {
    state.ui.query = target.value;
    rerender({ keepFocus: 'astaQuery' });
    return true;
  }
  if (action === 'bid-input') {
    state.ui.bidPrice = Number(target.value) || 0;
    rerender({ keepFocus: 'bidprice' });
    return true;
  }
  return false;
}
