/* Jarvis – Anleitung (anleitung.html): Gerät und Handy-Marke wählen (oder erkennen lassen), dann Schritt für Schritt mit
   nachgebauten Bildschirmen. Läuft komplett im Browser. Gemerkt wird nur die gewählte Marke (localStorage, falls erlaubt). */
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const KEY = "jarvis.anleitung";
  const HIT = on => (on ? " hit" : "");

  // ================================================================ nachgebaute Bildschirme (nur Bild, aria-hidden)
  const SB = '<div class="sb"><span>12:15</span><span class="sbi"><i></i><i></i><b></b></span></div>';
  const BG = '<div class="bgl">' + [72, 54, 88, 61, 79, 47, 66, 58].map(w => `<i style="width:${w}%"></i>`).join("") + "</div>";
  const ICON = {
    shield: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" fill="#3E7BFA"/><path d="M12 4.3V20c3.6-1.5 6-5.1 6-9V6.5z" fill="#A9C6FF"/></svg>',
    protect: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" fill="#2E9E55"/><path d="m8.3 12.1 2.5 2.5 5-5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    jarvis: '<span class="jic">J</span>',
  };
  const fig = (cls, inner, caption) =>
    `<figure class="shot${cls}">${inner}${caption ? `<figcaption>${esc(caption)}</figcaption>` : ""}</figure>`;
  const phone = (ui, inner, caption) => fig("", `<div class="mock ui-${ui}" aria-hidden="true">${SB}${inner}</div>`, caption);
  const buttons = list => '<div class="btns">' +
    list.map(([t, hit, pri]) => `<span class="${((pri ? "pri" : "") + HIT(hit)).trim()}">${esc(t)}</span>`).join("") + "</div>";

  const M = {
    // ein Dialog über dem abgedunkelten Bildschirm
    dialog: (ui, o) => phone(ui, `${BG}<div class="dim"></div><div class="dlg">${o.icon ? ICON[o.icon] : ""}` +
      (o.title ? `<h4>${esc(o.title)}</h4>` : "") + (o.text || []).map(t => `<p>${esc(t)}</p>`).join("") +
      buttons(o.btns) + "</div>", o.caption),
    // eine Einstellungsseite: Titel, Zeilen (mit Schalter oder Pfeil), optional das ⋮-Menü
    page: (ui, o) => phone(ui, `<div class="top"><span class="back">‹</span>${o.dots ? `<span class="dots${o.menu ? " open" : ""}">⋮</span>` : ""}</div>` +
      (o.app ? `<div class="apphead">${ICON.jarvis}<b>Jarvis</b></div>` : `<div class="ttl">${esc(o.title)}</div>`) +
      '<div class="card">' + o.rows.map(r =>
        `<div class="row${r.hit && !r.tog ? " hit box" : ""}"><span class="rt">${esc(r.t)}${r.s ? `<small>${esc(r.s)}</small>` : ""}</span>` +
        (r.tog ? `<span class="tog${r.tog === "on" ? " on" : ""}${HIT(r.hit)}"></span>` : r.chev ? '<span class="chev">›</span>' : "") +
        "</div>").join("") + "</div>" +
      (o.note ? `<p class="pnote">${esc(o.note)}</p>` : "") +
      (o.menu ? '<div class="menu">' + o.menu.map(([t, hit]) => `<span${hit ? ' class="hit box"' : ""}>${esc(t)}</span>`).join("") + "</div>" : ""),
      o.caption),
    // eine Auswahl mit Kreisen (z. B. Akku)
    radio: (ui, o) => phone(ui, `<div class="top"><span class="back">‹</span></div><div class="ttl">${esc(o.title)}</div>` +
      (o.lead ? `<div class="card">${o.lead.map(([t, on]) => `<div class="row"><span class="rt">${esc(t)}</span><span class="tog${on ? " on" : ""}"></span></div>`).join("")}</div>` : "") +
      '<div class="card">' + o.opts.map(([t, on, hit, s]) =>
        `<div class="opt${hit ? " hit box" : ""}"><span class="rad${on ? " on" : ""}"></span><span class="rt">${esc(t)}${s ? `<small>${esc(s)}</small>` : ""}</span></div>`).join("") +
      "</div>", o.caption),
    // die Meldung „Download abgeschlossen“
    notif: (ui, caption) => phone(ui, `${BG}<div class="dim soft"></div><div class="noti"><div class="nh"><span class="nd">⤓</span>Browser · jetzt</div>` +
      '<b>Download abgeschlossen</b><span class="nf">Jarvis.apk</span><div class="na"><span class="hit">Öffnen</span></div></div>', caption),
  };

  // Windows-Fenster
  const WIN = {
    smart1: caption => fig(" wide", '<div class="wmock ss" aria-hidden="true"><span class="x">✕</span><h4>Der Computer wurde durch Windows geschützt</h4>' +
      "<p>Von Microsoft Defender SmartScreen wurde der Start einer unbekannten App verhindert. Die Ausführung dieser App stellt ein potenzielles Risiko für den PC dar.</p>" +
      '<p><u class="hit">Weitere Informationen</u></p><div class="wb"><span>Nicht ausführen</span></div></div>', caption),
    smart2: caption => fig(" wide", '<div class="wmock ss" aria-hidden="true"><span class="x">✕</span><h4>Der Computer wurde durch Windows geschützt</h4>' +
      "<p>Von Microsoft Defender SmartScreen wurde der Start einer unbekannten App verhindert.</p>" +
      "<p>App: Jarvis-Setup.exe<br>Herausgeber: Unbekannter Herausgeber</p>" +
      '<div class="wb"><span class="hit">Trotzdem ausführen</span><span>Nicht ausführen</span></div></div>', caption),
    sac: caption => fig(" wide", '<div class="wmock sac" aria-hidden="true"><h4>Smart App Control</h4>' +
      "<p>Schützt vor nicht vertrauenswürdigen Apps.</p>" +
      '<div class="wopt"><span class="rad"></span>Ein</div><div class="wopt"><span class="rad on"></span>Auswertung</div>' +
      '<div class="wopt hit box"><span class="rad"></span>Aus</div></div>', caption),
  };

  // ================================================================ die Schritte
  // Text darf HTML enthalten (nur von hier, nie von außen). <b> = das, was auf dem Bildschirm steht.
  function stepsAndroid(b) {
    const ui = b.ui, out = [];

    // ---------------------------------------------------- 1. Installieren
    const s1 = [];
    s1.push({
      t: "Jarvis.apk laden und öffnen",
      p: ["Auf der <a href=\"index.html#download\">Startseite</a> die E-Mail eintragen und <b>„Jarvis für Android (APK)“</b> antippen. " +
        "Fragt der Browser nach: <b>„Herunterladen“</b> bzw. <b>„Trotzdem herunterladen“</b>.",
      `Danach in der Meldung auf <b>„Öffnen“</b> tippen – oder in der App <b>„${b.files}“</b> unter <b>„Downloads“</b> auf <b>„Jarvis.apk“</b>.`],
      shots: [M.notif(ui, "Fertig geladen → „Öffnen“")],
    });
    if (b.autoBlock) {
      s1.push({
        t: "„Unbekannte App gesperrt“? Automatische Sperre kurz ausschalten",
        p: ["Das ist Samsungs Schutz gegen Apps, die nicht aus dem Play Store oder Galaxy Store kommen. Auf <b>„OK“</b> tippen, dann:",
          "<b>Einstellungen → Sicherheit und Datenschutz → Automatische Sperre</b> → Schalter <b>aus</b> (mit PIN oder Fingerabdruck bestätigen). " +
          "Danach <b>„Jarvis.apk“</b> noch einmal öffnen."],
        tip: "Nach der Installation darfst du die Automatische Sperre wieder einschalten. Für ein Update von Jarvis musst du sie dann wieder kurz ausschalten.",
        shots: [
          M.dialog(ui, { icon: "shield", title: "Unbekannte App gesperrt", text: ["Um dein Telefon und deine Daten zu schützen, verhindert die automatische Sperre die Installation von unbekannten Apps."], btns: [["OK", true]], caption: "Diese Meldung → „OK“" }),
          M.page(ui, { title: "Automatische Sperre", rows: [{ t: "Ein", tog: "on", hit: true }], note: "Blockiert Apps aus nicht autorisierten Quellen …", caption: "Schalter antippen → aus" }),
        ],
      });
    }
    s1.push({
      t: "Installieren aus dieser Quelle erlauben",
      p: ["Kommt <b>„Aus Sicherheitsgründen … keine unbekannten Apps aus dieser Quelle …“</b>: auf <b>„Einstellungen“</b> tippen, " +
        (b.unknownSwitch ? `<b>„${b.unknownSwitch}“</b> einschalten` : "den Schalter einschalten") + " und oben mit <b>‹</b> zurück.",
      `Das gilt nur für die App, mit der du die Datei öffnest (z. B. „${b.files}“ oder deinen Browser). Kam die Frage nicht, ist das schon erlaubt.`],
      shots: [
        M.dialog(ui, { text: ["Aus Sicherheitsgründen kannst du zurzeit keine unbekannten Apps aus dieser Quelle installieren."], btns: [["Abbrechen"], ["Einstellungen", true, true]], caption: "→ „Einstellungen“" }),
        M.page(ui, { title: "Unbekannte Apps installieren", rows: [{ t: b.unknownSwitch || b.files, s: b.unknownSwitch ? "" : "Installieren erlauben", tog: "off", hit: true }], caption: "Schalter an, dann zurück" }),
      ],
    });
    s1.push({
      t: "Play Protect: „App scannen“",
      p: ["Google kennt Jarvis beim ersten Mal oft noch nicht und bietet eine Prüfung an. Tippe auf <b>„App scannen“</b> – nach ein paar Sekunden geht es mit <b>„Installieren“</b> weiter.",
        "Fragt Play Protect <b>„App zum Sicherheitsscan senden?“</b>: <b>„Dieses Mal senden“</b> ist in Ordnung."],
      tip: (b.ownCheck ? `${b.ownCheck} prüft neue Apps manchmal zusätzlich selbst. Kommt dort eine Warnung: <b>„Installieren“</b> bzw. <b>„Trotzdem installieren“</b>` +
        (b.slow ? " – der Knopf geht manchmal erst nach ein paar Sekunden." : ".") + " " : "") +
        "Steht nur <b>„Weitere Details“</b> da: aufklappen → <b>„Trotzdem installieren“</b>. Gibt es gar keinen Weiter-Knopf, hilft <a href=\"#hilfe-pp\">„Play Protect blockiert komplett“</a> unten.",
      shots: [M.dialog(ui, { icon: "protect", title: "Play Protect kennt diese App noch nicht", text: ["Vor der Installation auf Schadsoftware prüfen?"], btns: [["App nicht installieren"], ["App scannen", true, true]], caption: "→ „App scannen“" })],
    });
    s1.push({
      t: "Installieren → Öffnen",
      p: ["<b>„Installieren“</b> tippen, kurz warten, dann <b>„Öffnen“</b>. Jarvis startet mit dem Erklärvideo, danach wählst du Schriftgröße und PIN."],
      shots: [M.dialog(ui, { icon: "jarvis", title: "Jarvis", text: ["Möchtest du diese App installieren?"], btns: [["Abbrechen"], ["Installieren", true, true]], caption: "→ „Installieren“" })],
    });
    out.push({ h: "Installieren", intro: "Die Warnungen kommen bei jeder App, die nicht aus dem Play Store stammt – nicht, weil Jarvis schädlich wäre. Jarvis ist ein kostenloses Projekt ohne teuren Store-Eintrag.", steps: s1 });

    // ---------------------------------------------------- 2. Bedienungshilfe & Benachrichtigungen freischalten
    const s2 = [];
    s2.push({
      t: "Einmal versuchen – dann kommt „Eingeschränkte Einstellung“",
      p: ["In Jarvis oben rechts auf <b>⚙</b> tippen → <b>„Berechtigungen &amp; Einrichtung“</b> → bei <b>„Bedienungshilfe“</b> auf <b>„Erlauben“</b>. " +
        `Jarvis in der Liste antippen (meist unter <b>„${b.accList}“</b>) und einschalten.`,
      "Es erscheint <b>„Eingeschränkte Einstellung“</b> → <b>„OK“</b>. Das ist normal."],
      tip: "Wichtig: Erst nach diesem Versuch zeigt dein Handy den Menüpunkt aus dem nächsten Schritt.",
      shots: [M.dialog(ui, { title: "Eingeschränkte Einstellung", text: ["Aus Sicherheitsgründen ist diese Einstellung derzeit nicht verfügbar."], btns: [["OK", true]], caption: "→ „OK“" })],
    });
    s2.push({
      t: "„Eingeschränkte Einstellungen zulassen“",
      p: ["In Jarvis unter <b>„Berechtigungen &amp; Einrichtung“</b> auf <b>„App-Info öffnen“</b> tippen – oder: " + b.appInfo + ".",
        "Oben rechts auf <b>⋮</b> (drei Punkte) → <b>„Eingeschränkte Einstellungen zulassen“</b> → mit PIN oder Fingerabdruck bestätigen."],
      tip: "Siehst du die drei Punkte nicht? Dann hat dein Handy diese Sperre nicht (Android 11 und 12) – einfach weiter mit dem nächsten Schritt.",
      shots: [M.page(ui, { app: true, dots: true, rows: [{ t: "Benachrichtigungen", chev: true }, { t: "Berechtigungen", chev: true }, { t: "Akku", chev: true }, { t: "Speicher", chev: true }], menu: [["Eingeschränkte Einstellungen zulassen", true]], caption: "⋮ → „Eingeschränkte Einstellungen zulassen“" })],
    });
    s2.push({
      t: "Bedienungshilfe einschalten",
      p: ["Zurück in Jarvis wieder bei <b>„Bedienungshilfe“</b> auf <b>„Erlauben“</b> → <b>Jarvis</b> → Schalter <b>an</b> → <b>„Zulassen“</b>" +
        (b.slow ? " (bei Xiaomi lässt sich „Zulassen“ manchmal erst nach ein paar Sekunden antippen)." : "."),
      "Damit kann Jarvis für dich tippen – zum Beispiel eine WhatsApp-Nachricht absenden oder in Spotify auf Abspielen drücken. Er liest den Bildschirm nur, wenn du ihm einen Auftrag gibst."],
      shots: [M.page(ui, { title: "Jarvis", rows: [{ t: b.accSwitch || "Jarvis", tog: "off", hit: true }], note: "Damit kann dein Assistent Apps für dich bedienen …", caption: "Schalter an → „Zulassen“" })],
    });
    s2.push({
      t: "Benachrichtigungen lesen erlauben",
      p: ["In Jarvis bei <b>„Benachrichtigungen lesen“</b> auf <b>„Erlauben“</b> → <b>Jarvis</b> → Schalter <b>an</b> → <b>„Zulassen“</b>. Dann kann Jarvis dir neue Nachrichten vorlesen."],
      shots: [M.dialog(ui, { title: "Benachrichtigungszugriff für Jarvis zulassen?", text: ["Die App kann alle Benachrichtigungen lesen …"], btns: [["Ablehnen"], ["Zulassen", true, true]], caption: "→ „Zulassen“" })],
    });
    out.push({ h: "Bedienungshilfe & Benachrichtigungen freischalten", intro: "Diese zwei Rechte sperrt Android bei Apps außerhalb des Play Stores, bis du sie einmal freigibst (ab Android 13). Das geht so:", steps: s2 });

    // ---------------------------------------------------- 3. Akku
    out.push({ h: "Damit Jarvis immer zuhört", intro: "Viele Handys schicken Apps im Hintergrund schlafen – dann hört Jarvis nicht mehr auf seinen Namen. Einmal einstellen, fertig:", steps: b.battery(ui) });
    return out;
  }

  const PIXEL_BATTERY = ui => [{
    t: "Akku: „Uneingeschränkt“",
    p: ["<b>Einstellungen → Apps → Jarvis → Akkunutzung der App</b>: <b>„Hintergrundnutzung zulassen“</b> an und <b>„Uneingeschränkt“</b> wählen.",
      "Steht dort <b>„App bei Nichtnutzung pausieren“</b>: ausschalten."],
    shots: [M.radio(ui, { title: "Akkunutzung der App", lead: [["Hintergrundnutzung zulassen", true]], opts: [["Optimiert", 0], ["Uneingeschränkt", 0, 1]], caption: "→ „Uneingeschränkt“" })],
  }];
  const RECENTS = (how) => ({
    t: "Jarvis in der App-Übersicht sperren",
    p: [`Die Übersicht der offenen Apps öffnen (vom unteren Rand nach oben wischen und halten), ${how}. So räumt das Handy Jarvis nicht weg.`],
  });

  const BRANDS = [
    {
      id: "samsung", name: "Samsung", sub: "Galaxy", ui: "samsung", files: "Eigene Dateien", autoBlock: true,
      accList: "Installierte Apps",
      appInfo: "Jarvis-Symbol gedrückt halten → <b>ⓘ</b> (App-Info), oder <b>Einstellungen → Apps → Jarvis</b>",
      battery: ui => [{
        t: "Akku: „Nicht eingeschränkt“",
        p: ["<b>Einstellungen → Apps → Jarvis → Akku</b> → <b>„Nicht eingeschränkt“</b> wählen."],
        shots: [M.radio(ui, { title: "Akku", opts: [["Nicht eingeschränkt", 0, 1], ["Optimiert", 1], ["Eingeschränkt", 0]], caption: "→ „Nicht eingeschränkt“" })],
      }],
    },
    {
      id: "xiaomi", name: "Xiaomi", sub: "Redmi · POCO", ui: "xiaomi", files: "Dateimanager", ownCheck: "Xiaomi", slow: true,
      accList: "Heruntergeladene Apps",
      appInfo: "Jarvis-Symbol gedrückt halten → <b>App-Info</b>, oder <b>Einstellungen → Apps → Apps verwalten → Jarvis</b>",
      battery: ui => [
        {
          t: "Akkusparmodus: „Keine Einschränkungen“",
          p: ["In der <b>App-Info</b> von Jarvis → <b>„Akkusparmodus“</b> → <b>„Keine Einschränkungen“</b>."],
          shots: [M.radio(ui, { title: "Akkusparmodus", opts: [["Keine Einschränkungen", 0, 1], ["Akkusparmodus (empfohlen)", 1], ["Hintergrundaktivität einschränken", 0]], caption: "→ „Keine Einschränkungen“" })],
        },
        {
          t: "Autostart einschalten",
          p: ["In der <b>App-Info</b> von Jarvis <b>„Autostart“</b> einschalten. Bei HyperOS 3 steht das auch unter <b>Einstellungen → Apps → Hintergrund-Autostart</b>."],
          shots: [M.page(ui, { app: true, rows: [{ t: "Autostart", tog: "off", hit: true }, { t: "Akkusparmodus", s: "Keine Einschränkungen", chev: true }, { t: "Berechtigungen", chev: true }], caption: "„Autostart“ an" })],
        },
        RECENTS("Jarvis gedrückt halten bzw. nach unten ziehen und das <b>Schloss</b> antippen"),
      ],
    },
    {
      id: "pixel", name: "Google Pixel", ui: "pixel", files: "Dateien", unknownSwitch: "Dieser Quelle vertrauen",
      accList: "Heruntergeladene Apps", accSwitch: "Jarvis verwenden",
      appInfo: "<b>Einstellungen → Apps → Jarvis</b> (ggf. erst „Alle Apps ansehen“), oder Jarvis-Symbol gedrückt halten → <b>ⓘ</b>",
      battery: PIXEL_BATTERY,
    },
    {
      id: "oneplus", name: "OnePlus", sub: "OPPO · realme", ui: "xiaomi", files: "Dateimanager", ownCheck: "Dein Handy",
      unknownSwitch: "Unbekannte Apps installieren zulassen", accList: "Heruntergeladene Apps",
      appInfo: "Jarvis-Symbol gedrückt halten → <b>App-Info</b>, oder <b>Einstellungen → Apps → App-Management → Jarvis</b>",
      battery: ui => [
        {
          t: "Hintergrundaktivität erlauben",
          p: ["<b>Einstellungen → Apps → App-Management → Jarvis → Akkuverbrauch</b> → <b>„App-Aktivität im Hintergrund erlauben“</b> einschalten.",
            "Gibt es dort auch <b>„Autostart erlauben“</b> bzw. <b>„Automatisch starten“</b>: ebenfalls einschalten."],
          shots: [M.page(ui, { title: "Akkuverbrauch", rows: [{ t: "App-Aktivität im Hintergrund erlauben", tog: "off", hit: true }, { t: "Autostart erlauben", tog: "off" }], caption: "Beide Schalter an" })],
        },
        RECENTS("bei Jarvis auf <b>⋮</b> tippen bzw. die Karte gedrückt halten → <b>„Sperren“</b>"),
      ],
    },
    {
      id: "motorola", name: "Motorola", sub: "moto g · edge", ui: "pixel", files: "Dateien", unknownSwitch: "Dieser Quelle vertrauen",
      accList: "Heruntergeladene Apps", accSwitch: "Jarvis verwenden", note: "Motorola nutzt fast reines Android – die Menüs heißen meist wie bei Google Pixel.",
      appInfo: "<b>Einstellungen → Apps → Jarvis</b> (ggf. erst „Alle Apps ansehen“), oder Jarvis-Symbol gedrückt halten → <b>ⓘ</b>",
      battery: PIXEL_BATTERY,
    },
    {
      id: "nothing", name: "Nothing", sub: "Phone · CMF", ui: "pixel", files: "Dateien", unknownSwitch: "Dieser Quelle vertrauen",
      accList: "Heruntergeladene Apps", accSwitch: "Jarvis verwenden", note: "Nothing OS ist fast reines Android – die Menüs heißen meist wie bei Google Pixel.",
      appInfo: "<b>Einstellungen → Apps → Jarvis</b> (ggf. erst „Alle Apps ansehen“), oder Jarvis-Symbol gedrückt halten → <b>ⓘ</b>",
      battery: PIXEL_BATTERY,
    },
    {
      id: "honor", name: "Honor", sub: "MagicOS", ui: "pixel", files: "Dateien", ownCheck: "Honor", accList: "Heruntergeladene Apps",
      appInfo: "Jarvis-Symbol gedrückt halten → <b>App-Info</b>, oder <b>Einstellungen → Apps → Apps → Jarvis</b>",
      battery: ui => [{
        t: "App-Start: manuell verwalten",
        p: ["<b>Einstellungen → Akku → App-Start</b> → bei Jarvis <b>„Automatisch verwalten“</b> ausschalten und " +
          "<b>„Automatischer Start“</b>, <b>„Sekundärer Start“</b> und <b>„Im Hintergrund ausführen“</b> einschalten."],
        tip: "Je nach MagicOS-Version heißen die Punkte etwas anders – im Zweifel in den Einstellungen nach „App-Start“ suchen.",
        shots: [M.page(ui, { title: "Manuell verwalten", rows: [{ t: "Automatischer Start", tog: "off", hit: true }, { t: "Sekundärer Start", tog: "off" }, { t: "Im Hintergrund ausführen", tog: "off" }], caption: "Alle drei an" })],
      }],
    },
    {
      id: "andere", name: "Andere", sub: "Sony · Fairphone · vivo …", ui: "pixel", files: "Dateien", accList: "Heruntergeladene Apps",
      note: "Die Schritte sind bei allen Android-Handys gleich – nur die Menüs heißen etwas anders. Nutze die Suche oben in den Einstellungen.",
      appInfo: "Jarvis-Symbol gedrückt halten → <b>App-Info</b>, oder <b>Einstellungen → Apps → Jarvis</b>",
      battery: ui => [{
        t: "Akku: keine Einschränkungen",
        p: ["In der <b>App-Info</b> von Jarvis bei <b>„Akku“</b> die Einstellung wählen, die Jarvis <b>nicht einschränkt</b> " +
          "(heißt z. B. „Uneingeschränkt“, „Nicht eingeschränkt“ oder „Keine Einschränkungen“). Gibt es <b>„Autostart“</b>: einschalten."],
        tip: "Suchbegriffe für die Einstellungen-Suche: „Akku“, „Autostart“, „Hintergrund“.",
        shots: [M.radio(ui, { title: "Akku", opts: [["Uneingeschränkt", 0, 1], ["Optimiert", 1], ["Eingeschränkt", 0]], caption: "„Uneingeschränkt“ o. Ä." })],
      }],
    },
  ];

  const STEPS_WINDOWS = [{
    h: "Jarvis für Windows installieren",
    intro: "Jarvis hat kein gekauftes Signatur-Zertifikat (das kostet mehrere hundert Euro im Jahr). Deshalb warnt Windows beim ersten Start – das ist bei kostenlosen Programmen normal.",
    steps: [
      {
        t: "Setup laden",
        p: ["Auf der <a href=\"index.html#download\">Startseite</a> die E-Mail eintragen und <b>„Jarvis für Windows-PC (Setup)“</b> klicken.",
          "Warnt der Browser beim Download (Edge z. B. <b>„… wird nicht häufig heruntergeladen“</b>): auf <b>…</b> → <b>„Beibehalten“</b> → <b>„Trotzdem beibehalten“</b>."],
      },
      {
        t: "„Der Computer wurde durch Windows geschützt“",
        p: ["Das ist SmartScreen. Auf <b>„Weitere Informationen“</b> klicken, dann auf <b>„Trotzdem ausführen“</b>."],
        shots: [WIN.smart1("1. „Weitere Informationen“"), WIN.smart2("2. „Trotzdem ausführen“")],
      },
      {
        t: "„Smart App Control hat eine App blockiert“ (nur neue Windows-11-PCs)",
        p: ["Diese Sperre kennt kein „Trotzdem“ – sie lässt nur Programme mit gekauftem Zertifikat zu. Einmalig ausschalten:",
          "<b>Start → Windows-Sicherheit → App- &amp; Browsersteuerung → Smart App Control-Einstellungen</b> → <b>„Aus“</b>. Dann das Setup erneut starten."],
        tip: "Smart App Control lässt sich danach nur mit einer Windows-Neuinstallation wieder einschalten. Der Virenschutz (Microsoft Defender) bleibt ganz normal aktiv.",
        shots: [WIN.sac("→ „Aus“")],
      },
      {
        t: "Weiter → Fertig",
        p: ["Im Setup <b>„Weiter“</b> und <b>„Fertig“</b> klicken. Jarvis landet in deinem Benutzerordner, mit Verknüpfung auf dem Desktop – ohne Administratorrechte. " +
          "Beim ersten Start kommen Erklärvideo, Schriftgröße und PIN."],
        tip: "Updates: einfach das neue Setup starten – deine Einstellungen bleiben.",
      },
    ],
  }];

  // ================================================================ Anzeige
  const out = $("#guide"), chips = $("#brands"), seg = $("#device"), detected = $("#detected"), brandNote = $("#brand-note");
  let device = "android", brand = "samsung";

  function render() {
    const b = BRANDS.find(x => x.id === brand) || BRANDS[0];
    const phases = device === "windows" ? STEPS_WINDOWS : stepsAndroid(b);
    let n = 0;
    out.innerHTML = phases.map((ph, i) => `<section class="phase" aria-labelledby="ph${i}">` +
      `<div class="eyebrow">${device === "windows" ? "Windows-PC" : "Teil " + (i + 1) + " von " + phases.length}</div>` +
      `<h2 id="ph${i}">${esc(ph.h)}</h2><p class="muted">${esc(ph.intro)}</p>` +
      ph.steps.map(s => {
        n += 1;
        const shots = s.shots && s.shots.length ? `<div class="shots${s.shots.length > 1 ? " two" : ""}">${s.shots.join("")}</div>` : "";
        return `<article class="gstep${shots ? "" : " noshot"}"><div class="n">${String(n).padStart(2, "0")}</div><div class="gt"><h3>${esc(s.t)}</h3>` +
          s.p.map(x => `<p>${x}</p>`).join("") + (s.tip ? `<p class="tip">${s.tip}</p>` : "") + `</div>${shots}</article>`;
      }).join("") + "</section>").join("");
    chips.hidden = device !== "android";
    brandNote.hidden = device !== "android" || !b.note;
    if (b.note) brandNote.textContent = b.note;
    document.querySelectorAll("[data-for]").forEach(el => { el.hidden = el.dataset.for !== device; });
    seg.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.device === device)));
    chips.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.brand === brand)));
    document.querySelectorAll(".only-samsung").forEach(el => { el.hidden = !(device === "android" && b.autoBlock); });
  }

  function choose(dev, br, remember) {
    device = dev;
    if (br) brand = br;
    render();
    const hash = device === "windows" ? "windows" : brand;
    try { history.replaceState(null, "", "#" + hash); } catch (e) { /* file:// u. Ä. */ }
    if (remember) { try { localStorage.setItem(KEY, hash); } catch (e) { /* privat/gesperrt: dann eben nicht merken */ } }
  }

  chips.innerHTML = BRANDS.map(b => `<button type="button" class="chip" data-brand="${b.id}" aria-pressed="false">${esc(b.name)}` +
    (b.sub ? `<small>${esc(b.sub)}</small>` : "") + "</button>").join("");
  chips.addEventListener("click", e => {
    const t = e.target.closest("button[data-brand]");
    if (!t) return;
    detected.textContent = "";
    choose("android", t.dataset.brand, true);
  });
  seg.addEventListener("click", e => {
    const t = e.target.closest("button[data-device]");
    if (t) choose(t.dataset.device, null, true);
  });

  // Marke am Gerät erkennen (nur Handys, nur im Browser – nichts wird gesendet)
  function brandFrom(s) {
    if (/\bSM-[A-Z0-9]|SAMSUNG|Galaxy/i.test(s)) return "samsung";
    if (/Pixel/i.test(s)) return "pixel";
    if (/Redmi|POCO|Xiaomi|\bMi \d|\b2\d{3}[0-9A-Z]{4,6}\b|\bM2\d{3}[A-Z0-9]{3,}/i.test(s)) return "xiaomi";
    if (/OnePlus|OPPO|realme|\bCPH\d{4}|\bRMX\d{4}|\b(?:LE|NE|KB|IN|PJ|PH|PK)\d{4}\b/i.test(s)) return "oneplus";
    if (/motorola|\bmoto\b|\bXT\d{4}/i.test(s)) return "motorola";
    if (/Nothing|\bA0(?:15|59|63|65)\b|\bA142\b/i.test(s)) return "nothing";
    if (/HONOR/i.test(s)) return "honor";
    return null;
  }
  async function detect() {
    const ua = navigator.userAgent || "";
    let model = "";
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        const v = await navigator.userAgentData.getHighEntropyValues(["model", "platform"]);
        model = v.model || "";
      }
    } catch (e) { /* nicht verfügbar */ }
    return { android: /Android/i.test(ua), windows: /Windows NT/i.test(ua), brand: brandFrom(model + " " + ua) };
  }

  // Start: Link (#samsung, #windows …) > gemerkte Wahl > Erkennung > Samsung
  (async function start() {
    const valid = id => id === "windows" || BRANDS.some(b => b.id === id);
    const fromHash = (location.hash || "").slice(1).toLowerCase();
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) { saved = null; }
    if (valid(fromHash)) { choose(fromHash === "windows" ? "windows" : "android", fromHash === "windows" ? null : fromHash, false); return; }
    if (saved && valid(saved)) { choose(saved === "windows" ? "windows" : "android", saved === "windows" ? null : saved, false); return; }
    render();                                                       // sofort etwas zeigen, die Erkennung kann kurz dauern
    const d = await detect();
    if (d.android) {
      const id = d.brand || "andere";
      choose("android", id, false);
      const b = BRANDS.find(x => x.id === id);
      detected.textContent = d.brand ? `Erkannt: ${b.name}. Stimmt nicht? Einfach oben deine Marke antippen.` : "Marke nicht erkannt – tipp oben deine Marke an.";
    } else if (d.windows) {
      choose("windows", null, false);
    } else {
      choose("android", "samsung", false);
    }
  })();
  window.addEventListener("hashchange", () => {
    const id = (location.hash || "").slice(1);
    if (id === "windows") choose("windows", null, false);
    else if (BRANDS.some(b => b.id === id)) choose("android", id, false);
    else {
      const el = document.getElementById(id);                     // Sprung zu einer Frage unten: gleich aufklappen
      if (el && el.tagName === "DETAILS") el.open = true;
    }
  });

  document.querySelectorAll(".year").forEach(el => el.textContent = new Date().getFullYear());
})();
