# Audit del progetto — 15 ottobre 2026

Analisi statica di server FastAPI/Socket.IO, persistenza SQLite e client Expo; verifica TypeScript e test di regressione sul backend. Le prove usano SQLite temporaneo e non modificano il database del progetto.

## Problemi corretti

| Gravità | Problema | Correzione |
| --- | --- | --- |
| Alta | `/api/profile` includeva l'hash bcrypt, che il client poteva anche salvare nella sessione | Esclusione della password dalla risposta |
| Alta | `/user/{username}` autorizzava tramite il cookie modificabile `logged_in_user` | Verifica del JWT e dell'identità prima di leggere il profilo |
| Alta | Segnalazione Socket.IO verso socket arbitrari, anche senza autenticazione; chiusura di sessioni altrui | Controllo di autenticazione, famiglia del destinatario e partecipazione alla sessione |
| Alta | Inviti già elaborati riutilizzabili e cambi di famiglia tramite creazione/accettazione ripetuta | Verifica dello stato e dell'appartenenza dentro transazioni SQLite serializzate |
| Alta | Percorsi delle immagini derivati da input non affidabili; ritaglio di file di altri utenti | Nomi basati sull'ID utente, controllo della proprietà e del percorso, validazione coordinate ed estensioni |
| Alta | URL dell'album poteva far leggere al server risorse locali o di rete interna | Solo HTTPS sui domini Google Photos previsti, controllo dei redirect, timeout e limite di lettura |
| Media | Abbinamento accettava codici scaduti e poteva scambiare nuovamente i ruoli dei dispositivi | Completamento atomico, controllo scadenza e stato pending |
| Media | JSON non valido e credenziali mancanti o troppo lunghe potevano causare errori 500 | Risposte 400 prima dell'elaborazione |
| Media | Un socket riassociato a un'altra famiglia restava nella vecchia stanza | Uscita dalla precedente stanza |
| Media | Il valore grezzo del sensore `0x8000` diventava positivo | Conversione corretta in `-32768` |

## Verifiche

- `server/.venv/bin/python -m unittest discover -s server/tests -v`: 10 test superati.
- `tsc --noEmit -p mobile/tsconfig.json`: superato usando il Node locale disponibile tramite nvm.
- `git diff --check`: superato.

I test verificano direttamente le funzioni backend, con emissioni Socket.IO simulate: non sono prove HTTP o chiamate WebRTC complete.

## Secondo intervento entro le 10:40

Corrette anche le seguenti condizioni:

- Il server rifiuta chiavi JWT mancanti, troppo corte o di esempio. L'account iniziale riceve una password casuale se non configurata; le password degli account esistenti non vengono cambiate.
- Autoaccettazione video subordinata al consenso locale del destinatario, disattivato per impostazione predefinita; rimossa l'eccezione per username. La vecchia preferenza del chiamante non viene migrata come consenso.
- Candidati ICE accodati per socket fino all'applicazione della remote description; pulizia alla fine della chiamata.
- Logout e smontaggio rilasciano connessioni e tracce multimediali.
- Upload limitati a 10 MiB e 20 milioni di pixel con verifica effettiva JPEG/PNG/WebP; validazione del ritaglio e degli errori di scrittura.
- Inizializzazione e riavvio del sensore fuori dall'event loop; cancellazione del task e chiusura del bus in shutdown.

Verifica ampliata: 13 test backend superati, comprese richieste HTTP reali tramite TestClient, caricamenti e shutdown. TypeScript superato dopo le modifiche funzionali; l'ultima modifica successiva cambia soltanto la chiave della preferenza di consenso.

## Aspetti ancora da affrontare

- Gli scanner hanno rilevato vulnerabilità nelle dipendenze Python e JavaScript. Gli aggiornamenti non sono stati completati entro il tempo disponibile: manifest e lockfile mobile mantengono le versioni originali. Servono aggiornamenti e una verifica completa delle build native; il progetto non va considerato completamente risanato.
- È necessario cambiare manualmente eventuali password predefinite già presenti e configurare una chiave JWT robusta prima di avviare il server. Nessuna credenziale o dato esistente è stato modificato.
- I test automatizzati non validano audio/video su dispositivi reali, i permessi nativi o il rilevamento fisico delle cadute.

Da provare su hardware: chiamata audio/video web↔native, permessi fotocamera/microfono, riconnessione, pairing controller/viewer e rilevamento cadute. Le notifiche di emergenza nel client non costituiscono da sole una chiamata di gruppo implementata.

Compatibilità: le vecchie immagini già salvate restano consultabili, ma un vecchio upload di gruppo va ricaricato per usarlo nel nuovo flusso di ritaglio con verifica della proprietà.
