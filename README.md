# Jarvis – Webseite

Statische Seite für GitHub Pages (kein Build nötig): `index.html`, `styles.css`, `app.js`, `config.js`, `anleitung.html` + `anleitung.js` (Installations-Anleitung je Handy-Marke und für Windows, mit nachgebauten Bildschirmen; Links wie `anleitung.html#samsung`, `#xiaomi`, `#windows`), `impressum.html`, `datenschutz.html`, die Bilder (`screen-*.jpg`, `video-poster.jpg`, `og.jpg` für die Link-Vorschau) und das Video liegen daneben. Live: https://anonymdtm.github.io/Jarvis/

Der Quellcode der App liegt **nicht** in diesem Repository – hier sind nur die Webseite und die fertigen Dateien (Releases).

## So kommt eine neue Version online (automatisch)
1. Claude legt auf dem Zweig `release` die Dateien ab: `VERSION` (z. B. `1.0.30`), `NOTES.md`, `Jarvis.apk`, `Jarvis-Setup.exe` (immer dieselben Namen – so zeigen die Knöpfe der Webseite ohne API-Abfrage direkt auf die neueste Datei: `releases/latest/download/<Name>`) – und pusht (der Zweig wird jedes Mal neu aufgesetzt, damit das Repository nicht wächst).
2. Der Workflow `.github/workflows/publish.yml` macht daraus den GitHub-Release.
3. Die Webseite zeigt automatisch die neueste Version (GitHub-API, nach Einwilligung des Besuchers); die Knöpfe laden APK und Setup, darunter stehen die Hinweise aus `NOTES.md`.
4. Derselbe Workflow schickt die Update-Mail an alle Abonnenten – sobald die drei Brevo-Secrets eingetragen sind (BREVO_API_KEY, BREVO_LIST_ID, BREVO_SENDER unter Settings → Secrets and variables → Actions).
5. Die Apps prüfen einmal am Tag `releases/latest` und zeigen „Neue Version“.

Die Webseite selbst wird bei jedem Push auf `main` vom Workflow `.github/workflows/pages.yml` veröffentlicht (Settings → Pages → Source „GitHub Actions“ ist eingestellt).

## Anpassen
- `config.js`: Repository, Brevo-Formular-Adresse, Instagram. Die neueste Version (`androidVersion`, `pcVersion`, `versionDate`) steht direkt an den Download-Knöpfen – die trägt der Workflow „Veröffentlichen“ bei jedem Release selbst ein und veröffentlicht die Seite neu. Solange `brevoFormUrl` leer ist, zeigt die Seite ehrlich an, dass die E-Mail-Adresse nicht gespeichert wird (kein Mail-Häkchen, passender Absatz im Datenschutz); mit Adresse erscheinen Häkchen und Brevo-Absatz automatisch.
- `impressum.html` / `datenschutz.html`: Anbieterangaben (beide Seiten stehen auf `noindex`, damit Suchmaschinen die Adresse nicht anzeigen).
