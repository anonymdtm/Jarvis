# Jarvis-Proxy – kostenlos aufsetzen (ca. 15 Minuten)

**Was er tut:** Die App schickt ihre Frage an **deinen** Server. Nur der Server kennt den Schlüssel, die App nie. Er sucht das
beste gerade kostenlose Modell (NVIDIA Nemotron, Google Gemma, beim Programmieren Cohere North Mini Code …), wechselt bei
„ausgelastet“ von selbst zum nächsten und schickt die Antwort **Wort für Wort** zurück. Nutzer müssen nichts eintragen.

## 1. Schlüssel holen (kostenlos, ohne Kreditkarte)
**OpenRouter**: openrouter.ai → anmelden (Google-Konto geht) → „Keys“ → neuen Schlüssel erstellen.
Die kostenlosen Modelle sucht der Server selbst aus der aktuellen Gratis-Liste von OpenRouter – die ändert sich oft.

## 2. Kostenlos hosten (Render) – mit einem Klick
Der Code liegt schon im Zweig `proxy` deines GitHub-Repos `Jarvis`, zusammen mit `render.yaml` (der Bauplan für Render).
1. Link öffnen: https://render.com/deploy?repo=https://github.com/anonymdtm/Jarvis/tree/proxy
2. Bei Render anmelden (mit GitHub, kostenlos, ohne Kreditkarte).
3. Render fragt nach zwei Werten:
   - `OPENROUTER_API_KEY` = dein OpenRouter-Schlüssel
   - `APP_TOKEN` = das lange Zufallswort von Claude. Ohne dieses Wort nimmt der Server **keine** Anfrage an.
4. „Deploy Blueprint“ / „Apply“ → nach 2–3 Minuten steht oben die Adresse, z. B. `https://jarvis-warpline.onrender.com`.
5. Test im Browser: `https://…onrender.com/healthz` → `{"ok":true}`.
6. Schick Claude **nur die Adresse** (nie den OpenRouter-Schlüssel) – dann wird sie fest in die App eingebaut.

## 3. Ohne den Ein-Klick-Link (falls Render etwas ändert)
render.com → New → Web Service → Repo `Jarvis`, Zweig `proxy` → Runtime Node, Build `npm install --omit=dev`,
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
die Eingabeprüfung, Bilder, überlastete Modelle, das Tageskontingent und die Standard-Einstellung (29 Prüfungen).

## 9. So spricht die App mit dem Server
`POST /v1/chat`, Kopfzeilen `x-jarvis-token` und `x-device` (zufällige ID des Geräts), Body:
`{"messages":[{"role":"user","content":"…"}],"system":"…","task":"chat|code|vision","stream":true}`
Bei `vision` („Was ist das?“ mit Foto, Screenshot oder Bild) zusätzlich `"image":{"mime":"image/jpeg","data":"<base64>"}`
(höchstens gut 1 MB – die App verkleinert vorher). Es antworten nur Gratis-Modelle, die Bilder ansehen können
(`MODELS_VISION`, Standard `or:@vision,or:@vision2,or:openrouter/free`).
Freiwillig `"prefer":["nemotron-3.5-super","nemotron"]`: das Modell, das in der App unter „Modellauswahl“ gewählt ist (Teile der
OpenRouter-Namen, das beste zuerst). Es wird zuerst gefragt, die anderen bleiben als Ersatz dahinter.
Antwort als Strom: `data: {"delta":"Text"}` … `data: {"done":true,"model":"…"}`.

## Neu bauen

Render baut bei jedem Push auf den Zweig `proxy` selbst neu – die Render-App ist dafür bei GitHub für das Repo
`anonymdtm/Jarvis` installiert (3.11.2026). Einen Neubau von Hand braucht es nur noch, wenn das einmal nicht klappt:
Render → jarvis-warpline → Manual Deploy → Deploy latest commit.

## Jarvis Premium (ab Server 1.3.0)

Premium ist aus, bis du es einschaltest. So geht es:

1. **Guthaben bei OpenRouter aufladen** (openrouter.ai → Credits, mindestens 5 $). Derselbe Schlüssel wie bisher.
2. In **Render → jarvis-warpline → Environment** zwei Werte anlegen (beide denkst du dir selbst aus, lang und zufällig, und
   gibst sie niemandem):
   - `PREMIUM_SECRET` – damit unterschreibt der Server die Codes (mindestens 20 Zeichen). Nie mehr ändern, sonst gelten
     alle alten Codes nicht mehr.
   - `ADMIN_TOKEN` – dein Passwort für die Verwaltungsseite (mindestens 12 Zeichen).
3. **Codes erstellen:** `https://jarvis-warpline.onrender.com/admin` öffnen, Passwort eingeben, Abo wählen → Code kopieren
   und weitergeben. „Test“ = 1 $ Budget zum Verschenken, Basis 4 $, Plus 7 $, Max 15 $ (ändern: `PREMIUM_PLANS`).
4. In Jarvis unter **Mehr → Premium** (Handy) bzw. **Einstellungen → Premium** (PC) den Code eintragen.

Ist das Budget eines Codes leer oder der Code abgelaufen, antworten wieder die kostenlosen Modelle. Mehr als die Budgets
aller Codes zusammen kann es nie kosten.

**Wichtig – Verbrauch dauerhaft speichern:** Ohne Datenbank merkt sich der Server den Verbrauch nur, bis er neu startet
(z. B. nach einem Update). Für echte Kunden deshalb kostenlos bei upstash.com eine Redis-Datenbank anlegen und in Render
`UPSTASH_REDIS_REST_URL` und `UPSTASH_REDIS_REST_TOKEN` eintragen. Zusätzlich bei OpenRouter für den Schlüssel ein
Ausgabenlimit setzen (Keys → Credit limit).

## Kostenlose Bilder und genaues Zuhören (ab Server 1.4.0)

Über **Cloudflare Workers AI**: 10.000 „Neuronen“ pro Tag sind kostenlos, ohne Kreditkarte.
- **Bilder (FLUX.2 [dev]):** etwa 60 Bilder in 1024×1024 pro Tag, für alle zusammen. Pro Gerät höchstens `FREE_IMAGE_PER_DAY` (Standard: 20).
- **Zuhören (Whisper large-v3-turbo):** ein Befehl kostet etwa 3–4 Neuronen. `CF_STT_RESERVE` (Standard: 1500) bleibt immer fürs Zuhören frei.

Einrichten (einmal, etwa 5 Minuten):
1. Auf **dash.cloudflare.com** kostenlos registrieren.
2. Die **Account-ID** kopieren. Sie steht links unten unter „Account home“ oder in der Adresszeile (die lange Zeichenfolge nach `dash.cloudflare.com/`).
3. Unter **Mein Profil → API-Tokens → Token erstellen → Vorlage „Workers AI“** einen Token erstellen und kopieren.
4. Bei Render unter jarvis-warpline → **Environment** zwei Werte eintragen: `CF_ACCOUNT_ID` = die Account-ID, `CF_API_TOKEN` = der Token. Danach speichern; Render startet den Server neu.

Ohne diese zwei Werte läuft alles wie vorher: Der PC hört dann selbst zu, und Bilder gibt es nur mit Premium.
Ist das Tageskontingent leer, fragt der Server bis Mitternacht (UTC) nicht mehr bei Cloudflare nach.

## Premium kaufen mit PayPal (ab Server 1.5.0)

Die Seite **https://jarvis-warpline.onrender.com/kaufen** verkauft Premium für 30 Tage. Die Apps öffnen sie über „Premium kaufen (PayPal)“.
- Den Betrag legt nur der Server fest. Das Geld zieht nur der Server bei PayPal ein. Einen Code gibt es nur, wenn PayPal selbst „bezahlt“ meldet. Wer nur zur PayPal-Seite geht und zurückkommt, bekommt nichts.
- Der Code erscheint sofort auf der Seite. Mit Brevo geht er außerdem per E-Mail an die PayPal-Adresse des Käufers.
- Dieselbe Bestellung gibt immer denselben Code. Nichts wird doppelt abgebucht.

Einrichten:
1. **developer.paypal.com** → mit deinem PayPal-Konto anmelden → **Apps & Credentials** → zuerst **Sandbox** → „Create App“. Dann **Client ID** und **Secret** kopieren.
2. Bei Render unter **Environment** eintragen: `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `PAYPAL_MODE` = `sandbox`. Außerdem `PREMIUM_SECRET`, falls noch nicht gesetzt (mindestens 16 Zeichen, nie ändern, sonst werden alle Codes ungültig).
3. Testen: Unter **Sandbox → Accounts** hat PayPal schon ein Testkäufer-Konto angelegt (E-Mail und Passwort stehen dort). Auf /kaufen damit bezahlen. Das ist Spielgeld.
4. Echtes Geld: Mit einem **PayPal-Geschäftskonto** unter **Live** eine App anlegen, deren Client ID und Secret eintragen und `PAYPAL_MODE` = `live` setzen.
5. Code per E-Mail (freiwillig): bei **brevo.com** kostenlos registrieren (300 Mails am Tag), deine Absender-Adresse bestätigen, unter SMTP & API einen **API-Key** erstellen. Dann `BREVO_API_KEY` und `MAIL_FROM` (die bestätigte Adresse) eintragen.
6. Freiwillig: `SHOP_PRICE` (Standard 4), `SHOP_DAYS` (30), `SHOP_BUDGET` (2.5 = Dollar KI-Guthaben pro Kauf, damit nach PayPal-Gebühren etwas übrig bleibt), `SHOP_IMPRESSUM` (Link zu deinem Impressum).
7. Ohne Upstash merkt sich der Server die verkauften Codes nur bis zum nächsten Neustart. Fragt jemand später mit derselben Bestellung, schaut der Server bei PayPal nach.

Vor dem Verkauf mit echtem Geld: Gewerbe anmelden, Impressum, AGB und Widerrufsbelehrung. Auf der Seite ist schon ein Häkchen eingebaut, mit dem der Käufer auf das Widerrufsrecht verzichtet, damit der Code sofort geliefert werden darf. Lass das prüfen.
