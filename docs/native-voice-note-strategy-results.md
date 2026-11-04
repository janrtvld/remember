# Native Voice notes: historische proeven (advies vervangen)

**Status:** het native implementatieadvies hieronder is vervangen door [één gedeelde Chromium-stream](voice-note-shared-capture-implementation.md). Vervolgproeven vonden opname van eigen luidsprekeraudio en een groot systeembreed akoestisch effect bij een voorbereide VoiceProcessingIO-unit. De snelheidsmetingen blijven geldig binnen hun beschreven grenzen; ze rechtvaardigen niet langer de keuze voor native capture.

16 september 2026. Historisch vervolg op [het eerste onderzoek](voice-note-startup-investigation.md). Productbron: `e0068c81877a91afbd8923d61b69eef45ca5bbf6`. Alle prototypes en opnames uit deze meetfase staan in de geïsoleerde `.qa/research-voice-startup/`-omgeving. Deze meetfase installeerde of publiceerde geen productiewijzigingen.

## Historisch advies — vervangen

Het voorlopige advies na uitsluitend deze proeven was:

1. **Verwijder de herhaalde toestemmingsaanvraag uit de normale start.** Vraag alleen toestemming als die nog niet bekend is, handel geweigerde/ingetrokken toegang expliciet af, en gebruik bij bestaande toegang de snelle route. Houd apparaatkeuze actueel buiten iedere opnameactie. Dit pakt een daadwerkelijk gereproduceerde vertraging van meerdere seconden aan.
2. **Laat Voice notes aansluiten op dezelfde native microfoonengine als achtergrondopnames.** Bij de huidige always-on-instelling hoeft de hardware dan niet te stoppen en via Chromium opnieuw te openen. Het prototype leverde nieuwe, na het startcommando opgenomen samples binnen circa 4 ms mediaan. De app, IPC, UI en omzetting naar 16 kHz moeten nog geïntegreerd en opnieuw gemeten worden.

Een voorbereide maar gestopte native AudioUnit is een kansrijke tweede route als er geen opnameconsument actief is. Die leverde hier circa 29 ms mediaan, maar de fysieke microfoon was door de bestaande productie-app al actief. Dit is **geen bewijs van 29 ms bij volledig uitgeschakelde hardware**. Voor die situatie voorlopig een werkende fallback behouden en later apart meten.

## Meetopzet en belangrijke grens

Een minimale echte Electron 43.4.0/Chromium 150 QA-app gebruikte een eigen profiel, de ingebouwde MacBook Pro-microfoon en echte CoreAudio/Chromium-input. Geen fake devices, geen browserbridge. Elke opname werd als PCM-WAV bewaard. Een zachte akoestische testtoon van 997 en 1831 Hz begon vóór de startcommando's; de WAVs zijn daarna lokaal spectraal gecontroleerd. De luidspreker stond aanvankelijk gedempt en is voor de test tijdelijk hoorbaar gemaakt; mute is na elke run hersteld.

Er zijn 100 herhaalde starts gemeten: vier Chromium-strategieën × 10, twee overdrachtstrategieën × 10 en vier native strategieën × 10. Native had daarnaast een extra opname na vijf seconden gestopte idle, met dezelfde voorbereide AudioUnit. Chromium-volgorde roteerde per herhaling. De native gedeelde stream liep in een apart laatste blok en werd daarna gesloten.

Een onafhankelijke CoreAudio-query vóór initialisatie bevestigde dat de **geïnstalleerde Remember-app de fysieke microfoon al openhield**. Die opname is ongemoeid gelaten. De vergelijking geldt dus voor hardware die al actief is, wat aansluit op de huidige always-on-instelling. Een nieuw helperproces of nieuwe AudioUnit is niet hetzelfde als koude hardware. De read-only query en native snapshots leggen die grens vast.

De primaire tabel meet startcommando in de Electron-main tot ontvangst van de eerste bewaarde buffer, inclusief IPC. Dit is geen totale fysieke sneltoets-naar-HUD-meting. Chromium leverde aanvankelijk stille buffers; native had in deze proef geen stille buffers van betekenis. Daarom staat dat verschil apart vermeld. p90 is de empirische negende waarde van tien; dit zijn kleine experimenten, geen universele garanties.

## Resultaten

| Strategie | Eerste buffer mediaan | p90 | Maximum | Audio aan het begin |
| --- | ---: | ---: | ---: | --- |
| Huidige Chromium-kern incl. permission-aanvraag/outputcheck | 1.769 ms | 2.872 ms | 2.928 ms | Circa 34–55 ms stille prefix |
| Chromium met bestaande toestemming en bekende microfoon | 191 ms | 197 ms | 203 ms | Circa 37–53 ms stille prefix |
| Zelfde, audiobewerking uit | 193 ms | 205 ms | 207 ms | Circa 24–48 ms stille prefix |
| Zelfde, AudioContext hergebruiken | 194 ms | 206 ms | 212 ms | Circa 34–58 ms stille prefix |
| Native: nieuw helperproces en nieuwe AudioUnit | 156 ms | 165 ms | 188 ms | Geen stille buffers van betekenis |
| Native: helper blijft draaien, nieuwe AudioUnit per keer | 76 ms | 87 ms | 143 ms | Geen stille buffers van betekenis |
| Native: voorbereide, gestopte AudioUnit hergebruiken | 29 ms | 39 ms | 40 ms | Geen stille buffers van betekenis |
| Native: aansluiten op reeds actieve stream | 4,1 ms | 4,9 ms | 11,6 ms | Geen stille buffers van betekenis; audio vóór commando verwijderd |

De eerste nieuwe AudioUnit in een resident helper kostte 143 ms, tegenover 66–87 ms bij de volgende negen. Processtart, initialisatie en echte hardware-koudstart mogen daarom niet op één hoop worden gegooid.

De huidige Chromium-variant verschilt van de hele productapp: hij bevat de echte permission-aanroep, output-helper en recorderkern, maar geen widgets, modelwerk of actieve gespreksoverdracht. De lange vertraging is in deze kleinere opzet aantoonbaar aanwezig.

### De lange uitschieters zitten daadwerkelijk in de toestemmingsaanroep

`systemPreferences.askForMediaAccess('microphone')` kostte **586–2.668 ms**, mediaan **1.490 ms**, terwijl de QA-app vooraf al `granted` rapporteerde. De lokale outputcheck duurde in dezelfde reeks circa 72–105 ms. De lean-variant hield de huidige echo-onderdrukking, ruisonderdrukking en automatische versterking, maar verving de herhaalde aanvraag door een statuscheck en gebruikte de bekende ingebouwde microfoon.

Die variant had binnen 175–203 ms de eerste buffer en binnen 213–251 ms een callback met niet-nul audio. Spectrale controle vond de gecontroleerde toon in alle 40 Chromium-WAVs. De oorzaak binnen macOS/TCC zelf is niet bepaald; de tijd **binnen de API-aanroep** is wel gemeten. Hiermee is de eerdere hypothese dat alleen helper-teardown de secondenlange uitschieters verklaart achterhaald.

Audiobewerking uitschakelen en alleen de AudioContext warm houden leverden geen overtuigende extra startwinst. De wijzigingen hebben bovendien gevolgen voor opnamekwaliteit en apparaatgedrag. Daarom zijn dit geen aanbevolen eerste stappen.

### Afsluiten laten overlappen helpt hier beperkt

Met de huidige native gesprekshelper werd eerst een korte opname gestart en vervolgens vergeleken:

- Eerst volledig afsluiten, daarna lean Chromium: **212 ms mediaan**, maximaal 298 ms.
- Afsluiten parallel aan lean Chromium starten: **204 ms mediaan**, maximaal 243 ms.

Het afsluiten kostte hier 15–28 ms: iedere helper had pas 500 ms opgenomen. Dit experiment meet dus geen flush van bijna 60 seconden opgebouwde audio en geen fysieke device-stop, want productie-Remember hield de input actief. De gemeten winst van circa 8 ms mediaan is geen overtuigende reden om dit als hoofdoplossing te kiezen. Een langlopende helper kan meer voordeel laten zien; dat is niet uitgesloten.

### Native samples en idle zijn gecontroleerd

Alle 40 native opnames en de extra opname na idle bevatten precies 650 ms PCM op de huidige hardwarefrequentie van 96 kHz. Ze hadden geen renderfouten en geen stille buffers. De testtoon is in alle bestanden teruggevonden. In 38 van de 41 werd hij in het eerste 20-ms-venster gedetecteerd; in drie bestanden werd het detectiecriterium pas later gehaald. De precieze oorzaak is niet bepaald. Die drie worden niet als precieze akoestische onsetmeting gebruikt.

De voorbereide helper ontving **nul nieuwe callbacks** tijdens idle-intervallen van 2, 2 en 5 seconden; de eigen AudioUnit bleef gestopt. Na vijf seconden idle kwam de eerste nieuwe buffer binnen 33,3 ms. Dit bewijst het stoppen en hervatten van deze inputclient, niet dat geen enkele andere app de hardware gebruikte.

Bij de gedeelde route worden CoreAudio-hosttimestamps gebruikt om samples vóór het startcommando uit te sluiten. De gerapporteerde eerste sample ligt soms enkele microseconden na het commando door die uitsnede. Dat is geen beschikbare-audiolatency; de tabel gebruikt de eerlijke ontvangsttijd van de volledige eerste buffer in Electron.

### Spraakcontrole: gedeelde native route werkt, kwaliteitsvergelijking nog beperkt

Een lokale Nederlandse synthetische stem sprak: “Morgen bespreken we de planning voor het nieuwe project. Stuur het verslag daarna naar het team.” De bron-WAV werd door dezelfde lokale Parakeet-configuratie foutloos herkend. Vervolgens is die zin via de fysieke luidspreker opnieuw opgenomen, één keer per strategie, met het afspelen gepland vanaf 100 ms na het startcommando. De gemeten `afplay`-start is processtart, geen precies gemeten akoestische onset.

De eerste zachte luidsprekerproef gaf bij veel varianten lege of onjuiste transcripties; die is geen geslaagde spraakkwaliteitsvergelijking. Een gerichte herhaling met duidelijker afspeelniveau gaf:

- Gedeelde native stream: **de volledige zin exact herkend**, inclusief “Morgen” en “team”, nul woordfouten.
- Voorbereide native unit: zin grotendeels herkend maar 31% woordfouten.
- Lean Chromium: lege transcriptie ondanks aanwezige PCM en duidelijk signaal.

Dit bevestigt één volledige opname-/WAV-/Parakeet-route voor native streamhergebruik. Het bewijst niet dat native in het algemeen beter transcribeert. Eigen luidsprekerweergave, echo-/ruisverwerking en omgevingsgeluid maken dit een ongeschikte brede kwaliteitstest. Een echte spreker op normale afstand, rumoer, afspelende media en een gecontroleerd eerste woord blijven acceptatiecriteria voor de productimplementatie. De 100-ms-planning is evenmin bewijs dat iedere eerste lettergreep op exact dat moment wordt behouden.

## Historische productierichting — niet uitgevoerd

De destijds voorgestelde richting was één native engine met afzonderlijke opnameconsumenten. Een Voice note zet een duidelijke opnamegrens op de bestaande stream. Het huidige gedrag rond het tijdelijk onderbreken van de conversatiemicrofoon moet op consumentniveau behouden blijven, zodat notities niet onbedoeld dubbel als gesprek worden verwerkt. Systeemaudio moet blijven doorlopen. WAV-afronding en transcriptie mogen de start van een nieuwe opname niet blokkeren.

De productimplementatie heeft nog nodig: omzetting naar een continue 16-kHz-stream, begrensde buffers, expliciete microfoonkeuze en devicewissels, annuleren tijdens starten, foutafhandeling, herstel na helpercrash/slaapstand, ingetrokken toestemming en langdurige-opnamecontrole. De native proef gebruikt ruwe audio zonder de Chromium-audiobewerking. Acceptatie omvat daarom ook behoud van spraak- en transcriptiekwaliteit bij dichtbij en verder weg spreken, eerste lettergrepen, achtergrondgeluid en afspelende media, inclusief correcte filtering bij omzetting naar 16 kHz. Het prototype gebruikt een mutex in de callback en is meetcode, geen productieklare audiolaag.

Streef voor de geïntegreerde already-on-route naar minder dan 100 ms tot bruikbare audio en zichtbare feedback. De 4-ms-prototypewaarde laat ruimte voor integratie, maar is geen toezegging voor de volledige app of Bluetooth. Test de echt uitgeschakelde microfoon afzonderlijk wanneer productie-Remember niet al opneemt.

## Bewijs en reproduceerbaarheid

Onder `.qa/research-voice-startup/strategy-bench/runs/`:

- `2026-09-16T16-05-56.162Z`: Chromium, 40 starts, `results.json`, WAVs en `pcm-analysis.json`.
- `2026-09-16T16-09-07.769Z`: korte gesprekshelper-overdracht, 20 starts, dezelfde artifacts.
- `2026-09-16T16-10-14.056Z`: native, 40 starts + extra opname na idle, gestopte-clientcontroles en globale devicesnapshots.
- `2026-09-16T16-11-47.072Z`: eerste zachte spraakproef, acht WAVs en onbetrouwbare transcripties.
- `2026-09-16T16-15-32.770Z`: gerichte spraakherhaling, drie WAVs, `transcripts.json` en `pcm-analysis.json`.

Runner en uitleg: `.qa/research-voice-startup/strategy-bench/README.md`. Native Swift-bron en protocol: `.qa/research-voice-startup/native-strategies/README.md`. Offline audioanalyse: `.qa/research-voice-startup/analyze_pcm.py`.

Een eerste Chromium-smoke met gedempte luidspreker wordt niet gebruikt als akoestisch bewijs. Een eerste handoff-run stopte vóór de metingen wegens het door Chromium toegevoegde labelachtervoegsel `(Built-in)`; de herhaling normaliseert alleen dat achtervoegsel. Beide mislukkingen blijven in hun eigen artifacts zichtbaar.

Claude Fable heeft de meetopzet onafhankelijk beoordeeld. Zijn relevante opmerkingen over actieve hardware, stille eerste buffers, gedeelde klokgrenzen en de alternatieve parallelle overdracht zijn in de proeven verwerkt. De API-principes zijn gecontroleerd in Apples [AUHAL-technische notitie](https://developer.apple.com/library/archive/technotes/tn2091/_index.html) en [AudioUnitInitialize-documentatie](https://developer.apple.com/documentation/audiotoolbox/audiounitinitialize(_:)). Deze bronnen verklaren het API-gedrag; de snelheden hierboven komen uit de lokale metingen.
