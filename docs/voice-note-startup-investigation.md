# Onderzoek starttijd Voice notes — 16 september 2026

**Status:** historische diagnose op de hieronder genoemde bronversie. De huidige implementatiekeuze en bewijsstatus staan in [gedeelde Chromium-capture](voice-note-shared-capture-implementation.md).

Vervolg: [native strategieën met 100 vergelijkende starts](native-voice-note-strategy-results.md). Dat vervolg reproduceert de secondenlange vertraging in de herhaalde toestemmingsaanroep en vergelijkt concrete native prototypes. De bevindingen hieronder zijn de eerdere onderzoeksfase.

Onderzoek op commit `e0068c81877a91afbd8923d61b69eef45ca5bbf6`. Tijdens deze eerste onderzoeksfase is de productcode niet gewijzigd. Voice notes betekent hier Notes/dictation: de knop in Notes, de widget en de globale sneltoets gebruiken dezelfde recorder. Gesprekken opnemen gebruikt een andere native opnameketen.

## Hoofdbevinding

De huidige implementatie sluit voor iedere Voice note een eventuele gespreksmicrofoon af en opent daarna opnieuw een microfoon via Chromium. De bestaande prewarm houdt alleen de recorderpagina gereed. Dit verklaart het grootste deel van de gemeten halve seconde; kleinere audiobuffers en een sneller transcriptiemodel verwijderen deze stappen niet.

De gemelde uitschieters naar 1,5–2 seconden zijn nog niet gereproduceerd. Er zijn concrete mogelijke oorzaken, maar de timeouts in de code zijn op zichzelf geen bewijs voor de oorzaak van die uitschieters.

## Nieuwe hardwaremeting

`pnpm qa:audio` op de huidige schone checkout is geslaagd. Een eigen Electron-app, een geïsoleerd profiel en de fysieke microfoon zijn gebruikt. De productie-app is niet gewijzigd.

- Rapport: `../.qa/runs/2026-09-16T14-13-50.625Z/report.json`
- Fasen: `../.qa/runs/2026-09-16T14-13-50.625Z/dictation-live-startup.json`
- Aanvraag → eerste ontvangen audiobuffer: **625 ms**.

| Stap | Tijd | Positie in het kritieke pad |
| --- | ---: | --- |
| Aanvraag → startcommand in main | 2 ms | Voorbereiding |
| Startcommand → toestemming gereed | 19 ms | Inclusief initiële state-publicatie |
| Gespreksmicrofoon afsluiten | 224 ms | Blokkeert de recorderstart |
| Controleren of audio speelt | 104 ms | Parallel met bovenstaande; hier geen extra 104 ms |
| Recorder-IPC en apparaten selecteren | 6 ms | Vóór microfoon openen |
| `getUserMedia` | 346 ms | `AudioContext` start parallel in 14 ms |
| Microfoon beschikbaar → eerste callback | 28 ms | Eerste buffer wordt opgeslagen en `recording` gepubliceerd |

**570 van 625 ms** zit in het afsluiten en opnieuw openen van de microfoon. De QA controleert ook dat de gespreksmicrofoon na annuleren terugkeert, systeemaudio doorloopt en opgeslagen systeemaudio een herstart overleeft. Het is geen verificatie van de eerste uitgesproken lettergreep, de fysieke sneltoets of de geïnstalleerde release.

Eerdere native metingen op 16 september waren 498 ms en 593 ms. Bij 498 ms waren microfoonoverdracht en `getUserMedia` samen 443 ms. De bestaande fake-WAV-herstartmetingen van 57/59/74 ms meten Chromium met een audiobestand, niet het openen van echte hardware. Oudere metingen van vóór commit `9d7eb13b` rapporteerden readiness eerder dan de eerste buffer en zijn niet rechtstreeks vergelijkbaar.

## Acht aanvullende starts

Een tweede geïsoleerde proef gebruikte dezelfde actuele desktop-build, fysieke microfoon en vier combinaties, elk tweemaal. De recorder werd na annulering 800 ms voorgeladen; dit meet dus geen onmiddellijke cancel/start-race. Automatisch invoegen en opnamegeluiden stonden in deze proef uit. De test controleerde renderercompilatie, eerste-buffer-readiness en terugkeer van de gespreksmicrofoon.

| Gespreksmicrofoon | Idle-widget | Start 1 | Start 2 |
| --- | --- | ---: | ---: |
| Uit | Zichtbaar | 368 ms | 358 ms |
| Uit | Verborgen | 538 ms | 395 ms |
| Actief | Zichtbaar | 387 ms | 523 ms |
| Actief | Verborgen | 383 ms | 372 ms |

Mediaan **385 ms**, bereik **358–538 ms**. Acht starts zijn onvoldoende voor een betrouwbare p95 of een causaal oordeel over de HUD. De faseverdeling geeft wel concrete aanknopingspunten:

- `getUserMedia`: **199–256 ms**, elke start opnieuw.
- Outputcheck: **66–135 ms**. Zonder actieve gesprek-helper staat dit volledig op het kritieke pad.
- Toestemming via `askForMediaAccess`, apart gemeten: **19–112 ms**, ondanks bestaande toegang.
- Afsluiten actieve gespreksmicrofoon: **74–212 ms**, parallel met de outputcheck.
- `AudioContext.resume`: **1–8 ms**, parallel met `getUserMedia`. Alleen de context warm houden is in deze proef dus geen grote winst.
- Een verborgen widget kostte vóór de permission-aanroep circa **17–26 ms** extra voorbereiding. De volledige zichtbare rendererlatency is niet gemeten.

Bron: `../.qa/research-voice-startup/2026-09-16T14-20-37.457Z/results.json`. Runner: `../.qa/research-voice-startup/run.mjs`. Een voorafgaande proef van 14:18 had een ongeldig meegekopieerd Next.js-cachepad en widget-renderfouten; de daarin gemeten 1.342 ms wordt **niet** gebruikt als geldige widgetvergelijking of reproductie van het productieprobleem. De cache is voor de bovenstaande proef verwijderd en de widgetroute gaf HTTP 200 zonder rendererfouten.

De lokaal uitgelezen opname-instellingen gebruiken de standaardmicrofoon en forceren ingebouwd wanneer audio speelt; de idle-widget staat aan. macOS rapporteerde tijdens het onderzoek alleen de ingebouwde MacBook Pro-microfoon als standaardinput. Bluetooth is daarmee in deze sessie niet getest en niet aangetoond als oorzaak.

## Kritieke pad en resterende oorzaken

1. `apps/desktop/src/main/dictation/index.ts:194`: `toggle()` publiceert `starting`, wacht vorige cleanup af, vraagt toestemming, wacht parallel op het stoppen van de gespreksmicrofoon en de outputcheck, en verstuurt daarna pas het recordercommand.
2. `apps/desktop/src/main/dailyReview/index.ts:1263`: `suspendConversationMicrophone()` wacht op het volledige sluiten van het native helperproces. `apps/desktop/native/microphone-audio-capture.swift:469` heeft een runloop met intervallen tot 250 ms; na HAL-stop volgen nog resampling, WAV-encoding en een atomische bestandsschrijfactie. Niet al dat werk is nodig om de hardware vrij te geven. Het precieze aandeel van runloop versus flush is nog niet gemeten.
3. `apps/desktop/src/main/dictation/native.ts:38`: een nieuw `output-volume-control playing` subprocess wordt afgewacht als de standaardinstelling voor ingebouwde microfoon bij afspelende audio actief is. Timeout: 2 seconden. In de nieuwe meting overlapt dit volledig met microfoonoverdracht.
4. `apps/desktop/src/preload/dictationRecorder.ts:100`: eventueel apparaten inventariseren, dan een nieuwe `AudioContext` en `getUserMedia`, beide parallel. Echo cancellation, noise suppression en auto gain staan aan. Hun aandeel in de circa 300–350 ms hardware-open is nog niet afzonderlijk bepaald.
5. `apps/desktop/src/preload/dictationRecorder.ts:41`: cleanup stopt de tracks en sluit de context. `apps/desktop/src/main/dictation/recorder.ts:88` prewarmt alleen het venster. Annuleren vernietigt bovendien het recorderwindow en maakt daarna een nieuw exemplaar.
6. `apps/desktop/src/main/edgeWidget.ts:229`: als de idle-widget verborgen is, wordt het venster vernietigd. De volgende `starting`-publicatie bouwt synchroon een nieuw BrowserWindow, waarna de renderer nog moet laden. De synchrone constructie ligt vóór microfoonstart; het latere laden beïnvloedt de zichtbare feedback. Het aandeel in de gemelde uitschieters moet apart gemeten worden.

Het transcriptiemodel wordt inmiddels pas na `started` opgewarmd; media dempen gebeurt ook na het startcommand. Deze eerdere verbeteringen zijn terecht, maar raken de twee dominante hardwarestappen niet. De bufferverkleining van 1024 naar 256 samples bij 16 kHz scheelt theoretisch circa 48 ms per buffer, geen halve seconde.

## Richting voor de oplossing

**Prioriteit 1: geen onnodige microfoonoverdracht.** Als Remember al met toestemming audio opneemt, laat Voice notes vanaf de startactie samples uit dezelfde actieve microfoonstream ontvangen. Dit vereist een expliciete eigenaar/abonnementenmodel, consistente apparaatkeuze, duidelijke opnamegrenzen en behoud van de bestaande gespreksaudio. De huidige helper levert 60-seconden-WAVs; direct samples delen vereist een streaminguitgang. Bij afwijkende expliciete microfoonkeuze blijft een aparte route nodig.

**Prioriteit 2: meet een snelle native route wanneer de microfoon uit staat.** Vergelijk direct CoreAudio/HAL met de Chromium-route op hetzelfde apparaat, inclusief eerste buffer, eerste hoorbare stimulus en spraakkwaliteit. Gebruik een warme helper zonder actieve input; open de input pas bij de opnameactie. Een vooraf geladen proces of context garandeert geen snelle hardware-open. Geen nieuwe permanente microfoonopname introduceren als impliciete optimalisatie.

**Tussenstappen:** signaleer hardware-vrij direct na HAL-stop en rond de WAV daarna veilig af; houd de verborgen recorder/HUD beschikbaar waar dat helpt; haal playback/device queries uit iedere start via zorgvuldig bijgewerkte state. Vraag microfoontoestemming alleen wanneer nodig en verwerk ingetrokken toegang correct. De starts zonder actieve gespreksmicrofoon geven voor de herhaalde toestemming plus outputcheck samen 87–247 ms aan vermijdbaar kandidaatwerk; een implementatie moet de werkelijk behaalde winst nog bewijzen. Meet elke stap afzonderlijk. Een warm gehouden outputcontext kan zelf als afspelende audio worden gezien en moet daarom ook op devicekeuze worden gecontroleerd.

Een AudioWorklet kan verwerking onafhankelijk maken van de renderthread, maar verwijdert het openen van de microfoon niet. Dit is een stabiliteitsverbetering, geen onderbouwde oplossing voor de gemeten 570 ms. Zie de [Web Audio-specificatie](https://webaudio.github.io/web-audio-api/) voor de verwerkingsthreads en [Electron systemPreferences](https://www.electronjs.org/docs/latest/api/system-preferences) voor toestemming.

## Acceptatie en bewijsgrenzen

Voorgesteld productdoel voor de ingebouwde microfoon: eerste bewaarde buffer mediaan onder 100 ms, p95 onder 200 ms; zichtbare reactie op de actie binnen 50 ms. Dit zijn doelen, geen gemeten of gegarandeerde resultaten. Apparaten met Bluetooth krijgen een eigen meting.

Meet ten minste 30 starts per relevante combinatie: microfoon al actief/uit, HUD zichtbaar/verborgen, media stil/afspelend, ingebouwd/Bluetooth, eerste start/herstart/annuleren, na idle/sleep en onder belasting. Rapporteer p50/p95/max en faseverdeling; toets de fysieke sneltoets en het behoud van een precies getimede eerste lettergreep apart. Een eerste audiobuffer kan stilte bevatten en bewijst niet op zichzelf dat de eerste uitgesproken klank behouden blijft.

De bestaande QA heeft geen bovengrens voor startlatency. Een geslaagde run bewijst functionaliteit en de daadwerkelijk gecontroleerde persistentie, geen voldoende snelle UX.

## Claude Fable: onafhankelijke analyse

Na expliciete toestemming om de relevante broncode met Anthropic te delen is de consultatie voltooid via de bestaande Claude Code-login, model **`claude-fable-5`**, met alleen Read/Glob/Grep. Geen opnames, profieldata of inloggegevens zijn aan Claude meegegeven. De geretourneerde analyse staat in `../.qa/research-voice-startup/claude-fable-review.md`.

Fable bevestigt de dubbele opnameketen, de volledige helper-teardown, de nieuwe `getUserMedia` per start en het koud opbouwen van een verborgen HUD. Het adviseert eveneens hergebruik van een al geautoriseerde microfoonstream als structurele oplossing. Het wijst aanvullend op de vorige cleanup, die `duck` en `restore` kan afwachten, en het herstarten en meteen weer stoppen van de gesprek-helper bij snel opeenvolgende notities.

Nuancering van Fables conclusies: het noemt helper-teardown de waarschijnlijkste verklaring voor 1,5–2 seconden, maar die specifieke oorzaak is nog niet gemeten. Ook de uitspraak dat native on-demand openen even snel of sneller zal zijn dan Chromium is niet bewezen. De huidige helper resamplet bij het schrijven van chunks; een directe 16-kHz-stream vereist nieuw streaming- en resamplingwerk. Een eerste ScriptProcessor-callback is een ontvangen buffer, niet automatisch bewijs van de eerste fysieke klank. De aanbevelingen hierboven nemen deze grenzen mee.
