# Voice notes: één gedeelde Chromium-microfoonstream

16 september 2026. Dit is de definitieve architectuurkeuze na het [starttijdonderzoek](voice-note-startup-investigation.md) en de [native proeven](native-voice-note-strategy-results.md). De implementatie en het bewijs voor deze wijziging staan hieronder. Publicatie gebeurt via de CI- en releaseworkflows op de bijbehorende main-commit.

## Besluit

Gesprekken en Voice notes gebruiken één Chromium-microfoonstream met de bestaande echo-onderdrukking, ruisonderdrukking en automatische versterking. Als Remember al geautoriseerd gesprekken opneemt, start een Voice note op dezelfde stream. De app sluit dan geen microfoon af en opent geen tweede input.

Een stream blijft uitsluitend actief zolang een opnameconsument die nodig heeft. Zonder gesprek of Voice note stoppen de tracks en sluit de AudioContext. Het verborgen capturevenster mag voorbereid blijven; voorbereiding opent de microfoon niet. Een eerste opname zonder actieve stream blijft daarom een afzonderlijke, langzamere situatie.

## Waarom de native route is afgevallen

Ruwe HAL-capture was snel, maar legde eigen luidsprekeraudio vast. In een gerichte proef transcribeerde zowel HAL als de geteste VoiceProcessingIO-variant de complete Nederlandse zin die de laptop zelf afspeelde. Dat toont een werkende opnameketen, maar geen behoud van de bestaande onderdrukking van eigen media.

VoiceProcessingIO had daarnaast een ongewenst effect buiten de Voice note. Een gelijktijdige onafhankelijke HAL-referentie zag de testtonen al tijdens **voorbereiding** circa **40–46 dB** zwakker dan vóór initialisatie; na het verwijderen van de unit keerden ze terug tot ongeveer 0,5 dB van de uitgangswaarde. Dit gebeurde ook met de geteste minimale ducking-/bypassconfiguratie. Dit is een gemeten systeembreed akoestisch effect; de proef bepaalt niet precies welke macOS-volume- of audioprocessingsstap het veroorzaakt. Nul callbacks in een gestopte native client bewijst dus niet dat die voorbereiding geen ander audiogedrag verandert.

De voorgenomen native aanpassing is uit de productbron verwijderd. De experimentele bron en resultaten blijven onder `.qa/research-voice-startup/` beschikbaar. In de nieuwe opnameketen is Chromium de enige microfoonclient.

## Wat is geïmplementeerd

- **Toestemming:** `getMediaAccessStatus('microphone')` bepaalt de route. Bij `granted` gaat opname direct verder; uitsluitend bij `not-determined` wordt `askForMediaAccess` aangeroepen. Geweigerde of ingetrokken toegang start geen opname. De eerdere herhaalde aanvraag kostte in de proef 586–2.668 ms terwijl toestemming al verleend was.
- **Gedeeld eigenaarschap:** een gespreksabonnement en een Voice note delen dezelfde capture. Stoppen van het gesprek beëindigt een lopende notitie niet. Afwijkende expliciete apparaatkeuze behoudt de bestaande recorderfallback nadat de gespreksmicrofoon is vrijgegeven.
- **Exacte audioverdeling:** de AudioWorklet past commando's op een samplegrens toe. Hij verstuurt resterende oude samples vóór de grens en nieuwe samples erna. Notitieaudio wordt tijdelijk niet aan de gespreksmicrofoon geleverd. Het laatste voorafgaande gespreksbestand wordt afgerond en de transcriptiestream geflusht voordat hervatte gespreksaudio wordt verwerkt. Systeemaudio blijft een afzonderlijke capture en loopt door.
- **Echte readiness:** de app meldt opname pas nadat de eerste samples aan het juiste bestand zijn toegevoegd. Een geladen venster of een bevestigd startcommando geldt niet als opgenomen audio.
- **Begrensde verwerking:** vaste workletbuffers gaan naar een streaming WAV-schrijver in main. Deze schrijft mono PCM16 op 16 kHz, splitst gesprekschunks en begrenst een notitie op dertig minuten. De volledige opname wordt tijdens capture niet als één groeiende float-array bewaard.
- **Herstel:** sessie- en streamidentiteiten weren verouderde audio. Ontbrekende of herhaalde frames na de eerste samples veroorzaken een fout. Annuleren, rendereruitval, gestopte tracks en commandotimeouts ruimen uitsluitend eigen tijdelijke bestanden en opnameconsumenten op.

De relevante implementatie staat in [de gedeelde service](../apps/desktop/src/main/dailyReview/sharedMicrophoneService.ts), [de Electron-transportlaag](../apps/desktop/src/main/dailyReview/sharedMicrophoneTransport.ts), [de preload](../apps/desktop/src/preload/sharedMicrophone.ts), [de AudioWorklet](../apps/desktop/resources/microphone-worklet.js), [de WAV-schrijver](../apps/desktop/src/main/dailyReview/streamingMicrophoneWriter.ts) en [de toestemmingscontrole](../apps/desktop/src/main/dictation/microphonePermission.ts).

## Gemeten snelheid: prototype versus hele app

| Proef | Startcommando tot eerste buffer | Grens |
| --- | ---: | --- |
| Oude recorderkern met herhaalde toestemming | 1.769 ms mediaan | Minimale reproductie, geen volledige UI |
| Nieuwe Chromium-stream bij bestaande toestemming | 191 ms mediaan; 175–203 ms | Nieuwe acquisitie; fysieke hardware was al door productie-Remember actief |
| Hergebruik bestaande verwerkte Chromium-stream | 29 ms mediaan; 17–40 ms, tien starts | Prototype met echte microfoon; bestaande AEC/NS/AGC actief |
| Geïntegreerde app, gedeelde actieve stream | 42 ms mediaan; 40–197 ms, zes starts | Geïsoleerde echte Electron-app met fysieke microfoon; main-toggle tot ontvangst van `started` |

De circa 191 ms omvat de hele start tot buffer; `getUserMedia` zelf kostte in die reeks circa 143 ms mediaan. De 17–40 ms omvat de statuscheck en IPC, maar geen volledige product-sneltoets/HUD-route. Het gedeelde prototype had geen gecontroleerde eerste-lettergreeptest. **Deze waarden zijn geen volledige-appgarantie, geen Bluetooth-resultaat en geen bewijs voor volledig koude hardware.**

## Verificatie

De gerichte tests controleren toestemming, gedeeld eigenaarschap, annulering vóór en tijdens starten, apparaatselectie, crashherstel, oude events, echte eerste-buffer-readiness, stream- en samplegrenzen, chunklengtes, WAV-formaat en opruimen van eigen bestanden. De service, WAV-schrijver, apparaatselectie, toestemming en AudioWorklet hebben gerichte regressietests. De laatste volledige `pnpm validate` slaagde: formattering en types, 814 geslaagde desktoptests met één bestaande skip, 133 webtests en 45 broker-tests.

Een echte geïsoleerde Electron-run met **synthetische microfooninput** slaagde op `2026-09-16T18-57-02.504Z`: een bekende Nederlandse zin ging door de gedeelde Chromium-stream, AudioWorklet en echte lokale Parakeet. Eerste en laatste woord bleven behouden; het PCM-bestand en de notitie overleefden een volledige Electron-herstart en konden via echte IPC worden verwijderd. Na het stoppen waren tracks `ended`, de AudioContext `closed` en de teller voor verstuurde PCM-pakketten onveranderd tussen twee checks. Die teller is **geen native hardwarecallbackteller**. Deze fixture bewijst verwerking en lifecycle, geen akoestische kwaliteit of hardware-startlatency.

De geïntegreerde hardware-run `2026-09-16T19-01-15.976Z` is daarna **geslaagd**. Zes starts gebruikten dezelfde actieve Chromium-stream en leverden niet-nul PCM: **42,15 / 196,91 / 49,72 / 41,07 / 40,24 / 41,62 ms** van main-toggle tot `started` ontvangen in main. Mediaan: 41,89 ms. De uitschieter van 197 ms blijft in het resultaat staan; zes starts geven geen robuuste p95. Dit meet de opnameketen, niet de fysieke sneltoets of het verschijnen van het HUD.

Die run controleerde ook afzonderlijk crashen van het optionele geluids-/apparaatvenster en van de capture-renderer, herstel van gesprekken en een nieuwe notitie, annuleren tijdens voorbereiding, een gesimuleerde geweigerde toestemming in de eigen QA-app en gespreksintervallen zonder notitieaudio. Systeemaudio liep 76.533 ms door over twee chunks, zonder mislukte chunks, en bestanden/hashes overleefden herstart en afspelen. Na stoppen waren de tracks `ended`, de context `closed` en bleef de teller op 3.218 verstuurde PCM-pakketten. De notitie van 1.344 ms was geldig PCM16/16 kHz met 21.024 niet-nul samples van 21.504; de toonproef gaf terecht `no-speech`. Dit is geen spraakkwaliteitsmeting met een echte spreker. De OS-toestemming zelf is niet ingetrokken of gewijzigd.

De aanvullende fysieke-inputtest `2026-09-16T19-07-29.516Z` slaagde. Zonder eigen actieve gespreksstream waren vijf starts **458,29 / 503,30 / 236,17 / 216,51 / 210,04 ms**: **236,17 ms mediaan, 503,30 ms maximaal** tot de eerste bewaarde buffer; niet-nul signaal kwam circa 63 ms later. Iedere start kreeg een nieuwe stream en eindigde met gestopte tracks, gesloten AudioContext en geen nieuwe PCM-pakketten. De expliciet gekozen ingebouwde microfoon gebruikte eveneens de gedeelde route, in 194,60 ms. Andere apps bleven ongemoeid; dit is nieuwe acquisitie door onze app, geen bewijs van volledig uitgeschakelde hardware. De snelle hergebruikroute lost dus niet iedere start zonder achtergrondopname op.

Dezelfde run simuleerde uitsluitend in de eigen Electron-app `suspend` en `resume`: de actieve notitie werd geannuleerd en gesprekscapture herstelde. De computer ging niet echt in slaap. Een echte spreker, Bluetooth, fysieke slaapstand en apparaatverwijdering vragen eigen bewijs voordat daar prestatiegaranties aan worden verbonden.

De volledige recorderfallback-suite `2026-09-16T19-09-31.128Z` slaagde op zestien controles: eerste woord, annulering tijdens starten, vertraagde audio-dimming, waveform, HUD, instellingen, gedeelde Parakeet, geschiedenis, herstart, retry en verwijdering. Deze run gebruikt expliciete synthetische microfooninput en test geen echte plakactie (`--skip-insertion`).

Een aparte Electron-proef laadde de productie-preload, HTML en AudioWorklet uit een echt minimaal `app.asar`-archief. Synthetische input leverde niet-nul PCM met exclusieve gesprek/notitie-overgangen; de laatste stop sloot de context en alle tracks. De gebruikte preloadbron en resources komen overeen met deze wijziging. Bewijs: `.qa/asar-microphone-smoke/report.json`. Dit controleert archiefpaden, geen ondertekende productie-installatie.

## Fable-review

Claude Fable heeft het concrete protocol en de implementatie beoordeeld en daarna de oplossingen en testresultaten opnieuw gecontroleerd. Het eindadvies is **uitbrengen nadat de expliciete microfoonkeuze is hersteld en getest**. Die regressie is verholpen: dezelfde ingebouwde microfoon met Chromium-achtervoegsel `(Built-in)` gebruikt nu de gedeelde stream. Andere expliciete apparaten behouden hun eigen recorderroute, zodat gelijke USB-microfoonnamen geen verkeerde input kunnen selecteren.

Fables belangrijkste bufferbezwaar is opgelost met 128 vaste pakketten, circa twee seconden ruimte; een test verifieert iedere sample na 752 ms vertraagde bevestiging. De voorkeur voor de ingebouwde gespreksmicrofoon bestond al in de native helper. Een gemiste audioreeks blijft een expliciete fout met herstel, zodat de app geen schijnbaar geslaagde notitie met ontbrekende woorden oplevert. De review en herbeoordeling staan lokaal in `.qa/research-voice-startup/claude-fable-shared-code-review.md` en `claude-fable-shared-final-review.md`.

Fysiek loskoppelen, Bluetooth, echte hardware-slaapstand en akoestische spraakkwaliteit met een menselijke spreker zijn hiermee niet bewezen. De bestaande begrensde native volume- en plakhulpprocessen zijn gecontroleerd in de code; hun vermeende onbeperkte wachttijd bleek geen nieuw defect.

## Lokale bewijslocaties

- `.qa/research-voice-startup/strategy-bench/runs/2026-09-16T16-05-56.162Z/results.json`: toestemming en verse Chromium-acquisitie.
- `.qa/research-voice-startup/shared-chromium-bench/runs/2026-09-16T18-47-28.117Z/results.json`: tien gedeelde starts, echte input en actieve audiobewerking.
- `.qa/research-voice-startup/vpio-production-probe/minimum-true-baseline/analysis.json`: onafhankelijke referentie vóór voorbereiding, tijdens capture en na verwijderen van VPIO.
- `.qa/research-voice-startup/vpio-production-probe/speech-transcripts.json`: opname van eigen luidsprekerspraak door de onderzochte native varianten.
- `.qa/runs/2026-09-16T18-57-02.504Z/report.json`, `shared-fixture.json` en `shared-microphone-idle.json`: gedeelde fixture, echte ASR, persistentie en gestopte input.
- `.qa/runs/2026-09-16T19-01-15.976Z/report.json`, `dictation-shared.json`, `dictation-conversation-exclusion.json` en `shared-microphone-idle.json`: geïntegreerde fysieke input, zes starts, crashherstel, gespreksgrenzen, systeemaudio en idle.
- `.qa/runs/2026-09-16T19-07-29.516Z/report.json`, `shared-cold-starts.json` en `shared-suspend-resume.json`: nieuwe fysieke streams, expliciete ingebouwde microfoon en gesimuleerde lifecycle-events.
- `.qa/runs/2026-09-16T19-09-31.128Z/report.json`: volledige recorderfallback-suite met echte Parakeet en synthetische input.
- `.qa/native-dictation-resampling/proof.json`: achttien geslaagde offline omzettingsproeven van de verworpen native WAV-schrijver. Dit bewijst die converter, niet de uiteindelijke Chromium-implementatie.

Deze artifacts horen bij de lokale onderzoeksomgeving; productgebruik vereist ze niet.
