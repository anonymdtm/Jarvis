# Jarvis – Webseite

Statische Seite für GitHub Pages (kein Build nötig): `index.html`, `styles.css`, `app.js`, `config.js`, `impressum.html`, `datenschutz.html`, die Bilder und das Video liegen daneben.

## So kommt eine neue Version online (automatisch)
1. Claude legt auf dem Zweig `release` die Dateien ab: `VERSION` (z. B. `1.0.30`), `NOTES.md`, `Jarvis-<Version>.apk`, `Jarvis-PC-<Version>.zip` – und pusht (der Zweig wird jedes Mal neu aufgesetzt, damit das Repository nicht wächst).
2. Der Workflow `.github/workflows/publish.yml` macht daraus den GitHub-Release.
3. Die Webseite zeigt automatisch die neueste Version (GitHub-API, nach Einwilligung des Besuchers); die Knöpfe zeigen auf APK und ZIP des Releases.
4. Derselbe Workflow schickt die Update-Mail an alle Abonnenten – sobald die drei Brevo-Secrets eingetragen sind (BREVO_API_KEY, BREVO_LIST_ID, BREVO_SENDER unter Settings → Secrets and variables → Actions).
5. Die App prüft einmal am Tag `releases/latest` und zeigt „Neue Version“.

Einmalig nötig: **Settings → Pages → Source „Deploy from a branch“, Branch `main`, Ordner `/ (root)` → Save.** Die Seite liegt dann unter https://anonymdtm.github.io/jarvis/

## Anpassen
- `config.js`: Repository, Brevo-Formular-Adresse, Instagram.
- `impressum.html` / `datenschutz.html`: die orangen Platzhalter ersetzen (Pflicht vor der Veröffentlichung).
