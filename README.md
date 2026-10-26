# Jarvis – Webseite

Statische Seite für GitHub Pages (kein Build nötig): `index.html`, `styles.css`, `app.js`, `config.js`, `impressum.html`, `datenschutz.html`, die Bilder und das Video liegen daneben.

## So kommt eine neue Version online
1. In diesem Repository **Releases → Draft a new release**, Tag z. B. `1.0.29`, die APK als Datei anhängen, kurze Notizen, **Publish**.
2. Die Webseite zeigt automatisch die neueste Version (GitHub-API, nach Einwilligung des Besuchers) – der Download-Knopf zeigt auf die APK des Releases.
3. Der Workflow `.github/workflows/release-mail.yml` schickt die Update-Mail an alle Abonnenten – sobald die drei Brevo-Secrets eingetragen sind (steht oben in der Datei).
4. Die App prüft einmal am Tag `releases/latest` und zeigt „Neue Version“.

## Anpassen
- `config.js`: Repository, Brevo-Formular-Adresse, Instagram.
- `impressum.html` / `datenschutz.html`: die orangen Platzhalter ersetzen (Pflicht vor der Veröffentlichung).
