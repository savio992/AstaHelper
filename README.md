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

Resta sulla scheda **Asta**. Devi toccare solo due cose:

- quando chiamano un tuo obiettivo, cercalo (bastano tre lettere) e guarda il numerone
  dell'**offerta massima**: e' il prezzo oltre il quale conviene lasciarlo andare;
- quando un tuo obiettivo va a un altro, un solo tocco su **✕** nella lista obiettivi, senza
  inserire il prezzo.

Tutti gli altri giocatori puoi ignorarli: il piano cambia solo quando sparisce qualcuno che ti
interessava. Sono circa cinquanta tocchi in quattro ore.

## Come ragiona

**Il valore di un giocatore** e' quanti punti di fantacalcio porta in tutta la stagione rispetto
al giocatore che resterebbe comunque libero a fine asta. Non e' la fantamedia: le fantamedie
attese dei creators sono quasi identiche per tutti tranne i primissimi, e cio' che separa davvero
un titolare da un rincalzo e' **quante partite gioca**. Titolarita' e integrita' fisica diventano
presenze attese, e le presenze moltiplicano la fantamedia.

**Il prezzo atteso** parte dai prezzi consigliati dai creators, che sono gia' calibrati sul
montepremi di una lega da dieci squadre (la somma dei prezzi di un listone fa esattamente dieci
volte il budget di squadra), e li corregge per il numero reale di partecipanti.

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
  `Team`, `Nome`, `Prezzo`, `PMA`, `FMV Exp.`, `Titolarita'`, `Integrita'`, `Nota 1..5`.
- CSV con qualunque separatore, virgolette e righe di intestazione decorative.
- Ruoli sia Classic (`P/D/C/A`) sia Mantra (`Por`, `Dc`, `W`, `Pc`...), riportati al Classic.
- Le colonne vengono riconosciute da sole; se qualcosa sfugge si corregge a mano nell'anteprima.
- L'ordine delle fasce si deduce dal prezzo mediano, non dal nome: i creators usano vocabolari
  incompatibili fra loro (`Terza` contro `SOPRA AI LOW COST`).

## Sviluppo

```sh
npm test        # 43 test di dominio con il test runner di Node
npm run build   # genera dist/index.html, un unico file autosufficiente
npm run smoke   # avvia l'app in Chromium headless e verifica il flusso completo
npm run check   # tutto
```

Nessuna dipendenza: il progetto usa solo Node e le API standard del browser. Il lettore `.xlsx`
e' scritto a mano sopra `DecompressionStream`, cosi' il listone si carica dal telefono senza
doverlo convertire prima.

Per usarlo su iPhone: apri `dist/index.html` da un indirizzo qualsiasi e usa
**Condividi → Aggiungi alla schermata Home**. Da li' funziona anche senza rete.
