# La Notte dei Sospetti

Web app locale per gestire una partita investigativa. Il computer del giudice ospita il server; gli altri partecipanti accedono dal browser sulla stessa rete Wi-Fi. Il database SQLite nella cartella `data/` conserva partita, ruoli, missioni, comunicazioni, voti, punteggi e registro delle decisioni tra i riavvii.

## Requisiti e avvio

- Node.js 22.5 o successivo (usa il modulo SQLite integrato `node:sqlite`).
- Non sono richiesti servizi esterni o pacchetti npm.

Avvia dalla cartella del progetto:

```powershell
npm start
```

Il server stampa l’indirizzo locale e una password iniziale del giudice. Non condividere la password. Per impostarne una stabile prima dell’avvio, usa la variabile d’ambiente `JUDGE_PASSWORD`; per cambiare la cartella dei dati usa `DATA_DIR`, e per cambiare porta `PORT`.

Apri l’indirizzo sul computer del giudice e comunica ai partecipanti uno degli indirizzi Wi-Fi mostrati dal server. Consenti Node.js nel firewall sulla rete privata del luogo. Non inoltrare la porta del router verso Internet: la versione locale non configura TLS o accesso remoto sicuro.

## Preparare e avviare una partita

1. Accedi all’area giudice con la password del server.
2. Aggiungi le persone effettivamente presenti; i nomi devono essere univoci.
3. Nella configurazione ruoli puoi modificare i ruoli iniziali, creare ruoli personalizzati, impostare descrizioni, obiettivi, regole, azioni, gruppi e quantità.
4. Configura quantità e assegna ogni ruolo manualmente. La somma deve coincidere con i partecipanti; il server impedisce di avviare una configurazione incompleta.
5. Scegli numero e durata dei turni, limite dei voti, regole, criterio della classifica e comportamento alla scadenza. Le scadenze non fanno fallire missioni salvo scelta esplicita.
6. Consegna in privato a ogni partecipante il codice personale visibile nell’area del giudice. Ogni codice identifica un solo profilo e non può essere scelto dal giocatore.
7. Verifica il riepilogo segreto e conferma l’avvio.
8. Durante la partita assegna missioni a singoli giocatori o a tutti i membri di un ruolo, invia comunicazioni globali/private/di gruppo, valuta prove, segnalazioni e azioni consentite al ruolo, controlla i turni, gestisci le votazioni e correggi punteggi con motivazione.
9. Concludi la partita e conferma la rivelazione per mostrare ruoli, squadre, classifica, missioni e risultati dei voti ai giocatori.

I partecipanti aprono la scheda «Il mio ruolo», inseriscono il codice e usano la propria area per leggere istruzioni, vedere missioni, inviare prove testuali, comunicazioni private, segnalazioni o azioni abilitate per il proprio ruolo e votare quando la votazione è aperta. La pagina aggiorna i dati dal server periodicamente; un refresh non cancella i dati.

## Sicurezza e persistenza

- I controlli di accesso sono nel server. Le API giocatore restituiscono soltanto il profilo autenticato, le sue missioni e comunicazioni, le istruzioni del suo ruolo, e le informazioni condivise con il suo gruppo.
- Ruoli, prove, messaggi e voti non sono esposti a giocatori non autorizzati. I voti restano privati ai partecipanti fino alla chiusura; i risultati complessivi diventano visibili ai giocatori soltanto dopo la rivelazione finale.
- Ogni modifica importante e azione di gioco viene registrata nel registro del giudice.
- Le sessioni sono in memoria e richiedono un nuovo accesso dopo il riavvio. Il database resta in `data/game.sqlite`; password e chiave privata sono file locali ignorati da Git.
- Usa una rete fidata. L’app locale non offre TLS, rate limiting dell’accesso o un servizio di upload per foto/video.

## Funzionalità non incluse

- Le prove delle missioni sono testo; caricamento e conservazione di immagini/video non sono implementati.
- Le azioni speciali sono invii privati configurabili e approvati dal giudice, non effetti automatici specifici di un gioco o di un ruolo.
- Il criterio di vittoria selezionabile (punti squadra, missioni completate o voti ricevuti) è calcolato automaticamente; eventuali condizioni narrative personalizzate sono istruzioni, non un motore di regole arbitrario.
- Le notifiche si aggiornano con polling periodico, non con WebSocket o push.
- Non ci sono obiettivi collettivi indipendenti dalle missioni personali.

## Test

```powershell
npm test
```

I test automatici coprono preparazione, assegnazione di ruoli personalizzati, protezione dei profili, flusso missione e aggiornamento idempotente del punteggio, messaggi privati, azioni segrete, limiti dei voti, rivelazione finale e persistenza nel database.
