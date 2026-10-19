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

Verifica ampliata: 13 test backend superati, comprese richieste HTTP reali tramite TestClient, caricamenti e shutdown. TypeScript superato anche dopo il ripristino delle dipendenze locali.

## Aspetti ancora da affrontare

- Il successivo intervento del 19 ottobre ha aggiornato le dipendenze: i risultati e le tre segnalazioni upstream residue sono riportati sotto. Restano necessarie prove delle build native sui dispositivi.
- È necessario cambiare manualmente eventuali password predefinite già presenti e configurare una chiave JWT robusta prima di avviare il server. Nessuna credenziale o dato esistente è stato modificato.
- I test automatizzati non validano audio/video su dispositivi reali, i permessi nativi o il rilevamento fisico delle cadute.

Da provare su hardware: chiamata audio/video web↔native, permessi fotocamera/microfono, riconnessione, pairing controller/viewer e rilevamento cadute. Le notifiche di emergenza nel client non costituiscono da sole una chiamata di gruppo implementata.

Compatibilità: le vecchie immagini già salvate restano consultabili, ma un vecchio upload di gruppo va ricaricato per usarlo nel nuovo flusso di ritaglio con verifica della proprietà.


## Aggiornamento dipendenze — 19 ottobre 2026

| Ambito | Prima di questo intervento | Dopo |
| --- | --- | --- |
| Ambiente Python locale, inclusi strumenti installati | 141 segnalazioni su 14 pacchetti | 0 |
| Pacchetti runtime Python presenti nel nuovo lock | 122 segnalazioni sulle versioni precedenti | 0 su 43 pacchetti bloccati |
| Albero mobile JavaScript | 94 (2 critiche, 64 alte, 24 moderate, 4 basse) | 3 (2 alte, 1 moderata), nessuna critica |

Questi numeri contano advisory dello scanner, non bug applicativi distinti. Il vecchio conteggio JavaScript di 130 si riferiva a una precedente installazione; la baseline del 19 ottobre è stata misurata nuovamente prima delle modifiche. Il precedente conteggio Python includeva anche gli strumenti installati nell'ambiente, non soltanto il server.

Aggiornati FastAPI/Starlette, Socket.IO/Engine.IO, JWT, Pillow/OpenCV, crittografia e relative dipendenze. Le versioni runtime testate sono vincolate tramite `server/requirements-lock.txt`, applicato da `requirements.txt`. Anche l'ambiente locale `server/.venv` è stato aggiornato e riesaminato. Il database esistente non è stato modificato.

Il mobile resta su Expo SDK 54: moduli nativi riallineati, eliminati la release canary di System UI e il collegamento del pacchetto a sé stesso. Aggiornati Axios, Socket.IO e dipendenze transitive vulnerabili con override espliciti. Gli override sono in `mobile/pnpm-workspace.yaml`, come richiesto da [pnpm 11 e successivi](https://github.com/pnpm/pnpm.io/blob/main/docs/migration.md). Il lockfile mobile ora è incluso in Git; la versione di pnpm è dichiarata nel manifest.

### Segnalazioni residue, non soppresse

| Pacchetto | Gravità | Advisory | Percorso osservato |
| --- | --- | --- | --- |
| node-forge 1.4.0 | Alta | [Verifica di firme RSA](https://github.com/advisories/GHSA-86w9-cpqp-85rv) | Expo CLI → code-signing-certificates |
| braces 3.0.3 | Alta | [Ricorsione eccessiva su pattern annidati](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | Metro file map → micromatch |
| sprintf-js 1.0.3 | Moderata | [Precisione non limitata nelle stringhe di formato](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) | Babel/Jest → Istanbul → js-yaml → argparse |

Al momento del controllo nessuno dei tre advisory indicava una versione corretta. Sono dipendenze della catena di strumenti di sviluppo/build; non è stata dimostrata la loro sfruttabilità nell'app compilata. Le segnalazioni rimangono visibili in `pnpm audit`, che continua a terminare con codice diverso da zero. Non sono state introdotte patch crittografiche locali né ignorati advisory per ottenere un risultato artificiosamente pulito.

### Verifiche del 19 ottobre

- 15 test Python superati su un ambiente nuovo con i pacchetti bloccati: HTTP, WebSocket Socket.IO reale, isolamento famiglia, cambi stanza, autenticazione, upload, ritaglio OpenCV e arresto sensore.
- `pip check`: nessun requisito incompatibile nell'ambiente aggiornato.
- Audit del lock runtime e dell'ambiente Python locale: zero vulnerabilità note.
- TypeScript, dipendenze attese da Expo e peer dependencies: verifiche superate.
- Installazione mobile con lockfile congelato: superata.
- Esportazione web Expo e introspezione della configurazione nativa: superate.

Evidenza sintetica: [dependency-audit-2026-10-19.json](docs/security/dependency-audit-2026-10-19.json).

Dopo il pull reinstallare il server con `pip install -r requirements.txt`, il mobile con `pnpm install --frozen-lockfile` e ricostruire il development client, perché sono cambiati moduli nativi. Nessuna build nativa o prova fisica di chiamate/sensore è stata eseguita in questo ambiente.
