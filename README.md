# AstaHelper

Assistente per l'asta del fantacalcio **Classic**: legge i listoni dei creators, costruisce la
miglior rosa possibile con i crediti a disposizione, e durante l'asta dice fino a quanto conviene
rilanciare e chi prendere se un obiettivo va a un avversario.

Gira su iPhone e iPad come pagina web installabile: nessuna dipendenza, nessun server, nessun
account. Tutti i dati restano sul dispositivo.

## Come si usa

**Prima dell'asta**

1. Apri l'app e carica il file del creator dalla scheda **Listone**. Il `.xlsx` va bene com'e',
   con i suoi fogli separati per ruolo. Puoi caricare **piu' creators**: i giudizi vengono mediati
   e l'app segnala dove non sono d'accordo.
2. Nella scheda **Lega** imposta crediti, partecipanti, slot per ruolo e soprattutto i
   **modificatori** (difesa, imbattibilita' del portiere): cambiano radicalmente il piano.
3. Nella scheda **Piano** trovi la rosa consigliata e la **scheda d'asta**: per ogni obiettivo
   l'offerta massima e le tre migliori alternative.

**Durante l'asta**

Resta sulla scheda **Asta**. All'inizio di ogni reparto tocca **Prepara il piano**: ottieni
obiettivi in ordine, tetto massimo su ciascuno, ripieghi gia' decisi e cosa fare se saltano tutti.
Poi, mentre si chiama:

- quando chiamano un tuo obiettivo, cercalo (bastano tre lettere) e guarda il numerone
  dell'**offerta massima**: e' il prezzo oltre il quale conviene lasciarlo andare;
- quando un giocatore va a un avversario, registralo. Ci sono due velocita', e **entrambe vanno
  bene**: un solo tocco su **✕** nella lista obiettivi (nessuna domanda, nessun prezzo), oppure
  la scheda del giocatore con prezzo e nome di chi se l'e' preso.

La differenza fra le due velocita' e' quanto l'app puo' dirti dopo, ed e' spiegata qui sotto.
Gli altri giocatori puoi ignorarli: il piano cambia solo quando sparisce qualcuno che ti
interessava.

## Come ragiona

**Il valore di un giocatore** e' quanti punti di fantacalcio porta in tutta la stagione rispetto
al giocatore che resterebbe comunque libero a fine asta. Non e' la fantamedia: le fantamedie
attese dei creators sono quasi identiche per tutti tranne i primissimi, e cio' che separa davvero
un titolare da un rincalzo e' **quante partite gioca**. Titolarita' e integrita' fisica diventano
presenze attese, e le presenze moltiplicano la fantamedia.

**Il prezzo atteso** viene dalla colonna PMA, il prezzo medio effettivamente pagato per quel
giocatore nelle altre aste: e' una rilevazione, non un'opinione, ed e' il dato piu' affidabile
per sapere quanto costera' davvero. Le percentuali vengono normalizzate per fonte prima di essere
mediate, perche' ogni creator le calcola sul proprio campione di aste e i totali non coincidono.
La colonna Prezzo, che e' invece la valutazione del creator, serve a un'altra cosa: il divario fra
quanto dice che vale e quanto il mercato lo paga segnala le **occasioni** (lo paghi meno di quanto
vale) e i giocatori **cari** (il mercato lo sopravvaluta).

Anche le valutazioni vanno normalizzate per fonte prima di essere mediate, ma per un motivo
diverso dalla PMA. La PMA misura lo stesso mercato e i creators concordano: nei due listoni di
prova Lautaro risulta pagato 164 e 156. Il prezzo consigliato e' invece un giudizio personale e
le scale divergono: lo stesso Lautaro e' consigliato a 150 da uno e a 195 dall'altro. Mediare i
valori grezzi mescolerebbe un creator prudente con uno generoso; mediando le quote si confronta
quanto ciascuno lo valuta rispetto agli altri giocatori del proprio listone. Sulla scheda del
giocatore le due valutazioni restano visibili separatamente, riportate sulla scala della lega.

**La rosa migliore** e' un problema di zaino multi-vincolo — budget totale piu' slot esatti per
ruolo — risolto esattamente in programmazione dinamica, non per approssimazione. I giocatori
vengono pesati per profondita': il primo portiere vale uno, il secondo quasi zero, perche' in
porta ne gioca uno solo. Cosi' l'ottimizzatore non spende crediti sui panchinari.

**L'offerta massima** e' il punto di pareggio vero: il prezzo oltre il quale la rosa che ottieni
prendendolo vale meno della rosa che ottieni lasciandolo andare e spendendo quei crediti altrove.
Si trova per ricerca binaria, ricalcolando il piano a ogni tentativo.

**Le alternative** non sono i giocatori piu' simili: l'app ricalcola la rosa intera assumendo di
aver perso l'obiettivo e misura quanto vale ogni possibile sostituto dentro il piano che ne
risulta. A volte la risposta migliore non e' un altro attaccante, e' spostare i crediti in difesa.

**I big in rosa.** Lasciato libero, l'ottimizzatore schiva i campioni: costano piu' di quanto
rendano, e comprare valore e' matematicamente superiore. Ma una rosa senza big non vince le
giornate, e il premio che il mercato chiede per un campione compra anche qualcosa che il modello
non misura. Il vincolo **minimo big per reparto** decide quanto pagare quel premio, e il costo e'
sempre visibile: sui listoni di prova forzare un big in attacco fa entrare Malen a 163 crediti e
costa il 3,7% dei punti attesi.

**L'asta a chiamata per ruolo** cambia la disciplina di spesa. Si parte dai portieri e si scende
fino agli attaccanti, quindi i crediti vanno impegnati prima di sapere cosa costera' il resto:
un tetto che lascia soltanto un credito per ogni slot rimasto e' inutile, perche' permette di
spendere duecento crediti in porta e arrivare all'attacco senza niente. L'app mette da parte
quello che il piano ha destinato ai reparti successivi e mostra quanto resta davvero per quello
in corso.

**Quanti giocatori restano** non e' una stima: e' un conteggio. In una lega da otto squadre con
tre portieri a testa verranno assegnati esattamente ventiquattro portieri, ne' uno di piu'. Ogni
assegnazione registrata scala il contatore, e questo funziona anche con la corsia veloce, perche'
per contare gli slot il prezzo non serve.

**Quanti crediti restano** e' la stessa contabilita' applicata ai soldi, e da li' viene la cosa
piu' utile di tutte. Nella stanza ci sono quattromila crediti; quelli spesi non tornano; e quelli
che restano finiranno per forza sui giocatori ancora in vendita, su nessun altro. Quindi la somma
dei prezzi di chi resta deve fare i crediti ancora in circolazione, meno il credito incomprimibile
che ogni squadra deve tenere per ciascuno slot da riempire. Se la stanza strapaga i primi, per i
successivi resta meno e i prezzi scendono: e' il meccanismo che a fine asta manda via tutti a un
credito, e l'app lo prevede invece di subirlo. Sui listoni di prova, dopo una fase portieri pagata
l'ottanta per cento sopra le stime, Lautaro passa da 145 a 132 crediti attesi; in uno scenario in
cui la stanza brucia tutto su portieri e attaccanti, Dimarco crolla da 74 a 16.

Per le aggiudicazioni registrate con la corsia veloce il prezzo viene imputato dalla stima, e
l'app dichiara la propria copertura invece di far credere a una precisione che non ha.

**Fin dove puo' spingersi un avversario** e' il numero che decide davvero l'asta, perche' un
giocatore non costa quello che vale: costa un credito piu' di quanto puo' pagare il secondo
miglior offerente. Se registri anche a chi e' andato ogni giocatore, l'app tiene il tabellone di
tutti: crediti residui, slot mancanti per ruolo e massimo su un singolo colpo. Chi ha riempito il
reparto smette di essere un rivale per quanti crediti abbia. Nella simulazione l'offerta massima
di convenienza su Dimarco e' 395, ma nessun avversario puo' superare 85: il verdetto e'
*"e' tuo a 86, non offrire di piu'"*, e sono trecento crediti risparmiati. Senza attribuzione i
numeri diventano un limite superiore, ed e' dichiarato.

**L'abbinamento dei portieri** e' il consiglio che i creators ripetono a ogni guida, e qui e' un
vincolo del piano. In Classic se ne schiera uno solo ma se ne possiedono tre: il secondo non serve
a giocare, serve a non restare mai senza voto. Preso nella stessa squadra del titolare, qualunque
cosa succeda in quella porta il voto arriva, e con l'imbattibilita' il clean sheet arriva comunque
dalla stessa difesa su cui si e' investito.

**Quando salta il piano** non basta sapere chi prendere al posto di un giocatore: serve capire
che la strada e' cambiata. Se i big di un reparto finiscono tutti, l'app ricalcola la rosa senza
di loro e lo dice a parole: dove si spostano i crediti e quali sono i nuovi obiettivi. Lo stesso
scenario si puo' chiedere in anticipo, prima che accada.

**Le giornate gia' giocate** correggono le proiezioni, che sono fatte prima che il campionato
inizi. Il peso dei dati nuovi cresce con le partite: dopo una giornata su trentotto un fantavoto
alto e' quasi solo rumore, mentre sapere che un giocatore e' sceso in campo dal primo minuto
toglie incertezza sulla titolarita', che nel modello e' il fattore piu' pesante. Senza questo
accorgimento chi segna una doppietta alla prima diventerebbe il miglior giocatore del listone.

**I modificatori** cambiano la funzione obiettivo. Con il modificatore di difesa i difensori
valgono di piu' e i blocchi di club vengono premiati: il modificatore scatta a soglie sulla somma
dei voti, e i voti che arrivano dalla stessa partita salgono e scendono insieme, quindi una difesa
sparsa resta sempre a meta' classifica e il bonus non arriva mai. Con l'imbattibilita' il portiere
di una squadra solida vale molto piu' del suo prezzo, e il piano tende a mettergli davanti la sua
stessa difesa. Il rovescio della medaglia e' la concentrazione: il tetto **titolari per club**
serve a non legare mezza rosa alla stagione di una sola squadra. Il conteggio e' sui titolari
effettivi, non sui giocatori in rosa: quattro riempitivi da un credito non sono un rischio.

## Formati riconosciuti

- `.xlsx` dei creators (template Fantalab): un foglio per ruolo, colonne `Fascia`, `Ruolo`,
  `Team`, `Nome`, `Prezzo`, `PMA`, `FMV Exp.`, `Titolarita'`, `Integrita'`, `Nota 1..5`,
  `Commento`. Le note brevi (`rigorista`, `modificatore`, `imbattibilita'`, `rischio infortuni`)
  entrano nel punteggio; il commento lungo resta leggibile sulla scheda del giocatore.
- CSV con qualunque separatore, virgolette e righe di intestazione decorative.
- Ruoli sia Classic (`P/D/C/A`) sia Mantra (`Por`, `Dc`, `W`, `Pc`...), riportati al Classic.
- Le colonne vengono riconosciute da sole; se qualcosa sfugge si corregge a mano nell'anteprima.
- L'ordine delle fasce si deduce dal prezzo mediano, non dal nome: i creators usano vocabolari
  incompatibili fra loro (`Terza` contro `SOPRA AI LOW COST`).

## Sviluppo

```sh
npm test        # 85 test di dominio con il test runner di Node
npm run build   # genera dist/index.html, un unico file autosufficiente
npm run smoke   # avvia l'app in Chromium headless e verifica il flusso completo
npm run check   # tutto
```

Nessuna dipendenza: il progetto usa solo Node e le API standard del browser. Il lettore `.xlsx`
e' scritto a mano sopra `DecompressionStream`, cosi' il listone si carica dal telefono senza
doverlo convertire prima.

## Come metterlo sul telefono

L'app e' un unico file, `dist/index.html`, e funziona in tre modi.

**Da un indirizzo web.** Apri l'indirizzo in Safari e usa **Condividi → Aggiungi alla schermata
Home**: da li' parte a tutto schermo e funziona anche senza rete.

**Da GitHub Pages.** Il workflow in `.github/workflows/pages.yml` pubblica l'app a ogni push, ma
richiede che il repository sia **pubblico** (Pages sui repository privati e' riservato ai piani a
pagamento) e che in *Settings → Pages → Build and deployment* la sorgente sia impostata su
**GitHub Actions**. Fatto questo, l'app vive su `https://<utente>.github.io/AstaHelper/`.

**Da file, senza rete.** Scarica `dist/index.html`, salvalo nell'app File e aprilo da li':
essendo autosufficiente funziona anche a doppio clic, senza alcun server.

I dati (listoni, impostazioni, asta in corso) restano nel browser del dispositivo dove li carichi:
se usi anche l'iPad, li' vanno ricaricati.
