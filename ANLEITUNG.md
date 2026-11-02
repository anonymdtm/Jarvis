# Jarvis-Proxy – kostenlos aufsetzen (ca. 15 Minuten)

**Was er tut:** Die App schickt ihre Frage an **deinen** Server. Nur der Server kennt den Schlüssel, die App nie. Er sucht das
beste gerade kostenlose Modell (NVIDIA Nemotron, Google Gemma, beim Programmieren Cohere North Mini Code …), wechselt bei
„ausgelastet“ von selbst zum nächsten und schickt die Antwort **Wort für Wort** zurück. Nutzer müssen nichts eintragen.

## 1. Schlüssel holen (kostenlos, ohne Kreditkarte)
**OpenRouter**: openrouter.ai → anmelden (Google-Konto geht) → „Keys“ → neuen Schlüssel erstellen.
Die kostenlosen Modelle sucht der Server selbst aus der aktuellen Gratis-Liste von OpenRouter – die ändert sich oft.

## 2. Kostenlos hosten (Render) – mit einem Klick
Der Code liegt schon im Zweig `proxy` deines GitHub-Repos `jarvis`, zusammen mit `render.yaml` (der Bauplan für Render).
1. Link öffnen: https://render.com/deploy?repo=https://github.com/anonymdtm/jarvis/tree/proxy
2. Bei Render anmelden (mit GitHub, kostenlos, ohne Kreditkarte).
3. Render fragt nach zwei Werten:
   - `OPENROUTER_API_KEY` = dein OpenRouter-Schlüssel
   - `APP_TOKEN` = das lange Zufallswort von Claude. Ohne dieses Wort nimmt der Server **keine** Anfrage an.
4. „Deploy Blueprint“ / „Apply“ → nach 2–3 Minuten steht oben die Adresse, z. B. `https://jarvis-warpline.onrender.com`.
5. Test im Browser: `https://…onrender.com/healthz` → `{"ok":true}`.
6. Schick Claude **nur die Adresse** (nie den OpenRouter-Schlüssel) – dann wird sie fest in die App eingebaut.

## 3. Ohne den Ein-Klick-Link (falls Render etwas ändert)
render.com → New → Web Service → Repo `jarvis`, Zweig `proxy` → Runtime Node, Build `npm install --omit=dev`,
Start `node server.js`, Plan Free, Region Frankfurt → unter Environment die zwei Werte aus Schritt 2.3 eintragen.

## 4. Was kostet das? – Nichts, solange du nichts kaufst
- Die Modelle mit „:free“ kosten **0 €** pro Anfrage. Es wird nie automatisch Geld abgebucht – OpenRouter nimmt nur Geld,
  wenn du selbst Guthaben kaufst.
- Die Grenze ist die **Menge**: Ohne gekauftes Guthaben erlaubt OpenRouter **50 Gratis-Anfragen am Tag** – für deinen
  Schlüssel, also für **alle Nutzer zusammen**. Der Server hört deshalb bei 45 am Tag auf und sagt den Nutzern freundlich,
  dass es morgen weitergeht.
- **Einmal 10 $ Guthaben** kaufen (freiwillig) hebt die Grenze auf **1000 Anfragen am Tag**. Die 10 $ werden bei
  Gratis-Modellen nicht verbraucht und es gibt kein Abo. Danach in Render `LIMIT_ALL_PER_DAY=950` setzen (und `LIMIT_PER_DAY`,
  `LIMIT_IP_PER_DAY` passend höher).
- Render Free kostet 0 €. Render lässt einen Gratis-Server nach 15 Minuten ohne Anfrage einschlafen (die erste Antwort
  danach dauert fast eine Minute). Der Server ruft sich deshalb alle 10 Minuten selbst über seine Adresse auf und bleibt
  wach – das passt in die 750 Gratis-Stunden im Monat. Abschalten: `KEEP_AWAKE=0`.
- Nutzer können in der App weiterhin ihren **eigenen** Gratis-Schlüssel (Gemini oder OpenRouter) eintragen. Dann zählen ihre
  Fragen nicht auf dein Kontingent.

## 5. Warum kein Gemini auf dem Server?
Google erlaubt den **kostenlosen** Gemini-Zugang nicht in Apps, die Nutzern in der EU, der Schweiz oder Großbritannien
angeboten werden. Dort ist nur der bezahlte Zugang erlaubt (Gemini API Additional Terms: „You may use only Paid Services when
making API Clients available to users in the European Economic Area, Switzerland, or the United Kingdom.“).
Mit einem Google-Abrechnungskonto kannst du Gemini dazunehmen: `GEMINI_API_KEY` eintragen und z. B.
`MODELS_CHAT=gemini:gemini-flash-lite-latest,or:@chat,or:openrouter/free` setzen. Dann kostet jede Gemini-Anfrage etwas Geld,
pro Frage allerdings nur einen Bruchteil eines Cents.

## 6. Schutz (eingebaut)
- **Limits**: pro Gerät 12 Anfragen pro Minute und 15 am Tag, pro IP-Adresse 30 pro Minute und 30 am Tag, alle zusammen 45 am
  Tag. Alle sind änderbar mit `LIMIT_PER_MINUTE`, `LIMIT_PER_DAY`, `LIMIT_IP_PER_MINUTE`, `LIMIT_IP_PER_DAY` und
  `LIMIT_ALL_PER_DAY`. Eine gefälschte Geräte-ID hilft nicht, weil auch die IP zählt.
- **Eingabeprüfung**: nur Nachrichten von „user“ und „assistant“, jede höchstens 8000 Zeichen, zusammen höchstens 60 000.
  Alles andere wird abgewiesen, bevor ein Modell gefragt wird.
- **Überlastet:** Ein Modell, das „überlastet“ meldet oder zu langsam ist, wird 5 Minuten lang zuletzt gefragt. Ist das
  Tageskontingent von OpenRouter weg, hört der Server sofort auf und sagt „ab 1 Uhr geht es wieder“.
- **Schlüssel** nur in den Umgebungsvariablen. Sie stehen nie in Antworten oder im Protokoll, und Fehlertexte der Anbieter
  gehen nicht an die App.
- Der `APP_TOKEN` steckt später in der App und lässt sich auslesen. Er hält Zufallsbesucher fern, die echte Absicherung sind
  die Limits.

## 7. Vor der Veröffentlichung
- In die Datenschutzerklärung der Webseite gehört dann: Fragen gehen über deinen Server (Render) an OpenRouter, und die
  Gratis-Modelle dürfen Anfragen auswerten. Claude ergänzt das, sobald der Server läuft.
- Die Modell-Reihenfolge lässt sich mit `MODELS_CHAT` und `MODELS_CODE` ändern. Dabei steht `or:` für OpenRouter und
  `gemini:` für Google (nur bezahlt). `or:@chat`, `or:@chat2` und `or:@code` wählen das beste gerade kostenlose Modell.

## 8. Test auf dem eigenen Rechner
`node test.js` startet falsche Google- und OpenRouter-Server und prüft Streaming, Modellwechsel, Token-Schutz, alle Limits,
die Eingabeprüfung, Bilder, überlastete Modelle, das Tageskontingent und die Standard-Einstellung (28 Prüfungen).

## 9. So spricht die App mit dem Server
`POST /v1/chat`, Kopfzeilen `x-jarvis-token` und `x-device` (zufällige ID des Geräts), Body:
`{"messages":[{"role":"user","content":"…"}],"system":"…","task":"chat|code|vision","stream":true}`
Bei `vision` („Was ist das?“ mit Foto, Screenshot oder Bild) zusätzlich `"image":{"mime":"image/jpeg","data":"<base64>"}`
(höchstens gut 1 MB – die App verkleinert vorher). Es antworten nur Gratis-Modelle, die Bilder ansehen können
(`MODELS_VISION`, Standard `or:@vision,or:@vision2,or:openrouter/free`).
Antwort als Strom: `data: {"delta":"Text"}` … `data: {"done":true,"model":"…"}`.
