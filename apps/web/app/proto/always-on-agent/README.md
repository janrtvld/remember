# Eén bruikbaar aanbod — geïsoleerde verkenning

Route: `/proto/always-on-agent/`, uitsluitend bij `NODE_ENV=development`. De server retourneert `notFound()` buiten development, vóór corpusinhoud of het clientprototype wordt geladen. De client heeft dezelfde sluitende controle. Er is geen productie-import naar deze route.

Dit is een interactieve **lokale simulatie**, geen model-, capture-, notificatie- of remote-uitvoeringstest. Het scherm vermeldt dit permanent. Er zijn geen `window.remember`-calls, bridge-overrides, fetches of echte systeemmeldingen. Uitkomsten komen expliciet uit het benchmarkcorpus; de interface beweert niet ze zelf gevonden te hebben.

## Richtingen

1. **Chat** — vormbaseline met header, berichtkolom en vaste composer uit het huidige paginaritme. `AssistantView` zelf is ongewijzigd. Rechtstreeks mounten zou echte provider/IPC-opdrachten kunnen starten; deze lokale compositie is daarom niet gelijk aan een test van de productiecomponent. Aanvullende tekst wordt als instructie bij het voorbeeldconcept bewaard; een model interpreteert die niet.
2. **Collega** — het werkdocument blijft centraal. Eén compact aanbod opent een review. Taken en resultaat blijven op verzoek bereikbaar nadat het aanbod is afgewezen of gesloten.
3. **Taken** — de afspraken staan centraal; één prioritair aanbod verwijst naar dezelfde taak. De taakdetailpagina bevat de bron, voorbereiding en het resultaat.

De picker gebruikt de markup, waarden en toetsenbediening uit Emil `PICKER.md`: 1–3 en pijltjes wisselen, R begint opnieuw, selectie staat in `?v=`, één actieve knop en een gemeten highlight. De variant wisselt direct en wordt opnieuw gemount. Er is geen extra replayknop omdat de varianten geen eigen entreeanimatie hebben. De picker respecteert reduced motion.

## Gelijke scenario's

De server leest de vier records rechtstreeks uit `tests/fixtures/always-on-benchmarks/v1.scenarios.jsonl`.

| Scenario | Simulatie-uitkomst |
| --- | --- |
| AO-001 | Eén eigen taak en één bruikbaar conceptaanbod. Alleen een expliciete klik/opdracht start de lokale simulatie. |
| AO-006 | Piets toezegging aan Jan: geen eigen taak en geen aanbod. |
| AO-010 | Eén oude afspraak blijft zichtbaar, met onbevestigde relevantie. Geen nieuw live aanbod. |
| AO-020 | Drie afzonderlijke taken, hoogstens één aanbod voor Noor. `Nu even niet` speelt het user-dismiss-event: alle taken blijven, geen herhaald aanbod en geen uitvoering. |

De proef begint na het beschikbaar worden van de bron en de vooraf gekozen taakuitkomst. De tijdlijn wordt niet op echte snelheid afgespeeld. In AO-020 voert de tester het dismiss-event uit; er is geen verborgen timer die de keuze overneemt. Het voorbeeldconcept wordt na een expliciete opdracht lokaal na 1,5 seconde gemaakt. Dat getal is een simulatieduur, geen productlatentie. Geen verzendtaak wordt automatisch afgerond.

Het bronvenster toont de oorspronkelijke corpuszinnen. De brede/smalle en lange-inhoudcondities veranderen alleen de weergave. Het smalle werkvlak is geen browseremulatie: dialogs en responsive breakpoints volgen nog de echte viewport. Een echte smalle browser blijft nodig voor visuele verificatie. De extra tekst is als lengteproef beschreven en wordt geen nieuw taakbewijs.

## Interacties om te vergelijken

- Open de bron vanuit voorstel of taak en sluit met de knop of Escape; native `<dialog>` verzorgt modal focus en focusherstel.
- Kies `Nu even niet`, open Taken en vind dezelfde afspraak terug. In AO-020 blijven alle drie de taken bereikbaar.
- Start een concept. De lopende toestand heeft een werkende Stop die de lokale timer opruimt. Er is geen echte remote-stopclaim.
- Open een afgerond concept, sluit het en vind het opnieuw bij dezelfde taak. De mail blijft onverzonden en de taak open.
- Zet `Eerste resultaatopvraag mislukt` aan. Het resultaat bestaat, maar de eerste opvraag toont een concrete fout. `Opnieuw ophalen` opent hetzelfde resultaat zonder een tweede uitvoering; het simulatielog maakt dat onderscheid zichtbaar.
- Test leeg, laden, laadfout, lange inhoud en smal venster via de harness. `Laden afronden` en `Opnieuw laden` hebben een lokale uitkomst.
- Gebruik de composer met een instructie en Cmd/Ctrl+Enter. Bij geen aanbod is starten uitgeschakeld met een concrete reden.

## Bewijsgrens

De productie-interface is niet gewijzigd. De browserorigin was eerder geweigerd; deze verkenning omzeilt die grens niet via een andere browser, requesttool of renderer. Type-, lint- en lokale overgangscontroles vervangen geen browserinteractie of visuele QA. Default/hover/focus, modal focusherstel, pickerpositie, narrow overflow en resultaat-terugvinden moeten nog in een toegestane browser worden doorlopen voordat een richting wordt gepromoveerd.

Geen winnaar is op basis van deze implementatie gekozen. Eerste hypothese blijft de stille collega; de huidige chatvorm is het vergelijkingspunt. Noteer bij beoordeling aandachtkosten, resultaatvindtijd en gemiste/ongewenste aanbiedingen. Synthetische states worden niet als benchmark-pass of tevredenheidsscore geboekt.

Statische controle op 22 oktober: web-typecheck, `pnpm lint` en gerichte Biome-check slagen. Een lokale controle van de vier corpusrecords bevestigt taak-/aanbodgrenzen, afwijzen zonder uitvoering, expliciete start, timerstop en geen tweede start na voltooiing. Een directe serverfunctie-aanroep met `NODE_ENV=production` geeft 404 vóór het laden van corpus of client. Dit zijn geen DOM- of browserinteractietests. Er zijn geen screenshots van dit prototype gemaakt.
