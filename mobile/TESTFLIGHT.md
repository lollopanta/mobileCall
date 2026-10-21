# iOS / TestFlight interamente da GitHub Actions

La pipeline [Build iOS and TestFlight](https://github.com/lollopanta/mobileCall/actions/workflows/build-ios.yml)
usa un runner macOS, Expo prebuild, CocoaPods e Xcode. Non usa EAS, un account
Expo o un Mac personale per compilare. La distribuzione avviene comunque tramite
Apple: servono un'iscrizione attiva all'Apple Developer Program e App Store Connect.

## Configurazione Apple (una volta)

1. Registra un Bundle ID esplicito nel tuo account Apple Developer e crea l'app
   iOS in App Store Connect con lo stesso ID. Il valore attuale è
   `com.anonymous.mobilecall`; se non è disponibile nel tuo account, scegli un ID
   tuo e imposta la variabile repository **IOS_BUNDLE_IDENTIFIER** in GitHub.
2. Crea un certificato **Apple Distribution** e un profilo di distribuzione
   **App Store Connect** per quel Bundle ID. Esporta certificato **e chiave privata**
   in un `.p12` protetto da password. Un file `.cer` da solo non basta. Puoi
   generare chiave e CSR con OpenSSL; non è necessario usare EAS. Se hai già
   il certificato in un portachiavi Mac, puoi esportarlo da Accesso Portachiavi.
3. In App Store Connect → Utenti e accesso → Integrazioni → API App Store Connect,
   genera una chiave API del team con ruolo **App Manager** (o Admin).
   Scarica il `.p8` e annota Key ID e Issuer ID. La chiave deve poter accedere
   all'app; il workflow non crea automaticamente il record dell'app o i tester.
4. In questo repository → Settings → Secrets and variables → Actions, aggiungi:

| Secret | Valore |
| --- | --- |
| `IOS_CERTIFICATE_BASE64` | Contenuto Base64 del `.p12` con certificato e chiave privata |
| `IOS_CERTIFICATE_PASSWORD` | Password non vuota del `.p12` |
| `IOS_PROFILE_BASE64` | Contenuto Base64 del profilo `.mobileprovision` App Store Connect |
| `ASC_KEY_ID` | Key ID della chiave API del team |
| `ASC_ISSUER_ID` | Issuer ID del team App Store Connect |
| `ASC_PRIVATE_KEY` | Intero contenuto testuale del `.p8`, inclusi BEGIN/END PRIVATE KEY |

Non incollare queste credenziali in chat e non aggiungerle ai commit.
Per impostare i file Base64 direttamente nei secrets dal tuo computer con `gh`:

```sh
base64 < distribution.p12 | gh secret set IOS_CERTIFICATE_BASE64 --repo lollopanta/mobileCall
base64 < app.mobileprovision | gh secret set IOS_PROFILE_BASE64 --repo lollopanta/mobileCall
gh secret set ASC_PRIVATE_KEY --repo lollopanta/mobileCall < AuthKey_KEYID.p8
# Questi comandi chiedono il valore senza inserirlo nella cronologia shell:
gh secret set IOS_CERTIFICATE_PASSWORD --repo lollopanta/mobileCall
gh secret set ASC_KEY_ID --repo lollopanta/mobileCall
gh secret set ASC_ISSUER_ID --repo lollopanta/mobileCall
# Solo se usi un Bundle ID diverso:
gh variable set IOS_BUNDLE_IDENTIFIER --repo lollopanta/mobileCall --body com.tuoteam.mobilecall
```

Il Team ID viene letto dal profilo. Il workflow verifica tipo, scadenza e Bundle ID
prima della compilazione; certificati e chiave API vengono rimossi dal runner al
termine. I materiali di firma non sono inclusi negli artifact.

## Avviare la build

Actions → **Build iOS and TestFlight** → **Run workflow**:

- **unsigned** (predefinito): compila in Release per iPhone ARM64 con firma
  disabilitata e crea `MobileCall-unsigned.ipa` con checksum SHA-256. Non richiede
  secrets Apple. Scarica l’artifact **MobileCall-iOS-unsigned**, estrai l’IPA e
  firmalo/installalo con AltStore Classic e AltServer sul tuo computer. Con un
  Apple ID gratuito la firma va rinnovata ogni 7 giorni. L’IPA senza firma non
  si installa direttamente toccando il file e non si carica su TestFlight.
- **testflight**: controlla i sei secrets, genera un archivio firmato, esporta
  l'IPA e lo invia ad App Store Connect. Numero build: `<numero run>.<tentativo>`,
  distinto anche per i retry. Se esistono build con numeri maggiori caricate da
  altri sistemi, adegua il numero prima della successiva pubblicazione.
- **simulator**: compila in Release senza firma o credenziali Apple e salva
  `MobileCall-simulator.zip`. Questo artifact funziona solo nel simulatore iOS,
  non si può installare su un iPhone né caricare su TestFlight.

Dopo l'upload attendi l'elaborazione Apple. In App Store Connect → TestFlight
assegna la build a un gruppo di tester e invitali; su iPhone installa TestFlight
poi accetta l'invito. I tester esterni possono richiedere Beta App Review.
L'upload riuscito non significa che Apple abbia già completato l'elaborazione o
approvato la beta. Eventuali accordi Apple o domande sulla crittografia vanno
completati nel proprio account.

L'IPA firmato resta negli artifact per 14 giorni. Non è un APK e il download da
GitHub da solo non lo rende installabile sull'iPhone: usa TestFlight.
La build include JavaScript e WebRTC nativo; non serve Metro né Expo Go.

## Collegamento al Raspberry

Al primo accesso consenti **Rete locale**, microfono e fotocamera quando richiesti.
Inserisci l'indirizzo del server raggiungibile dalla rete dell'iPhone, ad esempio
`http://192.168.0.106:3000` sulla rete di casa, oppure `http://172.20.10.4:3000`
sull'hotspot. TestFlight distribuisce l'app, ma non rende raggiungibile un server
privato da Internet. Per uso fuori casa configura un endpoint HTTPS raggiungibile.

## Riferimenti

- [Firma Apple nei runner GitHub](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications)
- [TestFlight: distribuzione e tester](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
