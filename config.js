// Einstellungen der Jarvis-Webseite – nur diese Datei anpassen.
window.JARVIS_SITE = {
  // GitHub-Repository mit den Releases (die Seite holt sich dort die neueste APK)
  repo: "anonymdtm/Jarvis",
  // feste Dateinamen in jedem Release – so zeigen die Knöpfe immer direkt auf die neueste Datei
  apkName: "Jarvis.apk",
  setupName: "Jarvis-Setup.exe",
  // die neueste Version – steht direkt an den Download-Knöpfen (ohne Anfrage bei GitHub, also ohne Einwilligung).
  // Wird beim Veröffentlichen automatisch eingetragen (Workflow „Veröffentlichen“), hier also nichts von Hand ändern.
  androidVersion: "1.0.36",
  pcVersion: "1.2.7",
  versionDate: "2026-10-28",
  // Brevo-Formular: die "action"-Adresse des Formulars aus Brevo (Formulare → dein Formular → "HTML-Code" → form action).
  // Leer lassen, solange es noch kein Brevo-Konto gibt – dann geht der Download ohne E-Mail-Liste.
  brevoFormUrl: "",
  // Social
  instagram: "",
  // Pflichtangaben erscheinen auf impressum.html / datenschutz.html (dort die Platzhalter ersetzen)
};
