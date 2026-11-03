// Hilfe-Tickets (1.0.43 – der Nutzer, 3.11.2026: „auf der Startseite ein großer Hilfe-Button … dann wird auf jedem Handy, das die
// Jarvis-App hat, eine Liste angezeigt mit Leuten, die Hilfe brauchen … die Person kann das Ticket annehmen wie bei Discord …
// dann landen die beiden in einem Chat, der auch bleibt … das Ticket können beide schließen“).
// 1.0.44 (der Nutzer, 3.11.: „oben ein Telefonieren-Button, dann wird der andere angerufen … und im Telefonat nochmal eine extra
// Anfrage für die Bildschirmfreigabe und Steuerung“): Anrufe (klingeln, annehmen, ablehnen, auflegen), und „wait“ – der Server
// hält die Anfrage, bis sich am Ticket etwas tut, damit Nachrichten und Anrufe sofort ankommen. Das Gespräch selbst läuft in
// live.js (WebSocket, nur durchgereicht, nichts gespeichert).
//
// Nur im Arbeitsspeicher, ohne Datenbank: die Geräte halten die Wahrheit (ihre Tickets und Chats liegen auf dem Gerät). Kennt der
// Server ein Ticket nach einem Neustart nicht mehr, meldet ein Gerät es mit „restore“ wieder an (samt seiner letzten
// Nachrichten) – niemand muss etwas einrichten. Schlüssel liegen nur als Hash vor; Inhalte landen nie im Protokoll.

"use strict";
const crypto = require("crypto");

// die Gründe zur Auswahl (wie „Triff eine Auswahl“ bei Discord – der Nutzer, 3.11.: „mehrere Möglichkeiten … nicht nur Technik“)
const REASONS = ["phone", "pc", "jarvis", "internet", "messages", "photos", "scam", "devices", "letters", "school", "code", "other"];
const LIMITS = {
  tickets: 3000,            // höchstens so viele Tickets im Speicher
  openPerDevice: 3,         // so viele offene/angenommene Tickets darf ein Gerät gleichzeitig haben
  createPerDay: 10,         // so viele neue Tickets pro Gerät und Tag
  createPerIpDay: 20,       // … und pro Anschluss (IP) – gegen Spam mit ausgedachten Geräten
  msgsPerTicket: 400,       // ältere fallen raus (die Geräte haben ihre Kopie)
  text: 1500,               // Zeichen pro Nachricht / Beschreibung
  name: 40,
  openHours: 48,            // so lange steht ein Ticket in der Liste, wenn es keiner annimmt
  keepClosedHours: 24,      // ein geschlossenes Ticket bleibt so lange, damit die andere Seite es noch mitbekommt
  list: 100,
  ringSeconds: 45,          // so lange klingelt es, dann ist es ein verpasster Anruf
  callHours: 3,             // ein Gespräch endet spätestens nach so vielen Stunden
  waitMs: 25_000,           // so lange hält der Server eine „wait“-Anfrage, wenn sich nichts tut
  waiters: 3000,            // höchstens so viele wartende Anfragen
};

const tickets = new Map();   // id → Ticket
const created = new Map();   // Gerät → { day, n }
const createdIp = new Map(); // IP-Hash → { day, n }
const waiting = new Set();   // offene „wait“-Anfragen: { ids:Set, device, finish }
const listeners = [];        // (x, what) → wenn sich ein Ticket ändert (live.js: Anruf beendet → Verbindung zu)

let clock = () => Date.now();
const now = () => clock();
const hash = (k) => crypto.createHash("sha256").update(String(k)).digest("base64url");
const newKey = () => crypto.randomBytes(24).toString("base64url");
const newId = () => crypto.randomBytes(9).toString("base64url");
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
const today = () => new Date(now()).toISOString().slice(0, 10);

class HelpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Etwas hat sich geändert: Version hoch, wer wartet, bekommt es sofort. */
function changed(x, what = "") {
  x.v = (x.v || 0) + 1;
  x.touched = now();
  for (const w of [...waiting]) if (w.ids.has(x.id)) w.finish();
  for (const l of listeners) { try { l(x, what); } catch (e) { /* ein Zuhörer darf nichts kaputt machen */ } }
}

function sweep() {
  const t = now();
  for (const [id, x] of tickets) {
    if (x.status === "closed" && t - x.closedAt > LIMITS.keepClosedHours * 3600_000) tickets.delete(id);
    else if (x.status === "open" && t - x.createdAt > LIMITS.openHours * 3600_000) tickets.delete(id);
    else if (t - x.touched > 14 * 24 * 3600_000) tickets.delete(id);                      // (lange niemand mehr da gewesen)
  }
  if (tickets.size > LIMITS.tickets) {
    const old = [...tickets.values()].sort((a, b) => a.touched - b.touched);
    for (const x of old.slice(0, tickets.size - LIMITS.tickets)) tickets.delete(x.id);
  }
}

const nameOf = (x, role) => (role === "owner" ? x.name : x.helperName) || "Jemand";
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** Klingelt es zu lange, ist es ein verpasster Anruf; ein Gespräch endet spätestens nach [LIMITS.callHours]. */
function expireCall(x) {
  const c = x.call;
  if (!c) return;
  if (c.state === "ringing" && now() - c.at > LIMITS.ringSeconds * 1000) {
    Object.assign(c, { state: "missed", endedAt: now() });
    addMsg(x, "system", `Verpasster Anruf von ${nameOf(x, c.by)}.`);
    changed(x, "call");
  } else if (c.state === "active" && now() - c.startedAt > LIMITS.callHours * 3600_000) {
    endCall(x, c.by);
  }
}

/** Was eine Seite über ihr Ticket erfährt – nie Gerätekennungen, nie Schlüssel. */
function view(x, role, since = 0) {
  expireCall(x);
  const c = x.call;
  return {
    id: x.id, status: x.status, role, name: x.name, reason: x.reason, text: x.text, platform: x.platform, createdAt: x.createdAt,
    helperName: x.helperName || "", takenAt: x.takenAt || 0, closedAt: x.closedAt || 0, closedBy: x.closedBy || "",
    ownerHash: x.ownerHash, helperHash: x.helperHash || "", v: x.v || 0,
    call: c ? { n: c.n, state: c.state, by: c.by, at: c.at, startedAt: c.startedAt || 0, endedAt: c.endedAt || 0 } : null,
    msgs: x.msgs.filter((m) => m.at > since),
  };
}

function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function roleOf(x, key) {
  const h = hash(key || "");
  if (x.ownerHash && same(h, x.ownerHash)) return "owner";
  if (x.helperHash && same(h, x.helperHash)) return "helper";
  return "";
}

function find(id) {
  const x = tickets.get(String(id || ""));
  if (!x) throw new HelpError(404, "Dieses Ticket kenne ich nicht (mehr).");
  return x;
}

function addMsg(x, from, text, mid, at = now()) {
  if (mid && x.msgs.some((m) => m.mid === mid)) return x.msgs.find((m) => m.mid === mid);   // (doppelt gesendet)
  const m = { mid: clean(mid, 40) || newId(), from, text, at: Math.max(at, (x.msgs[x.msgs.length - 1]?.at || 0) + 1) };
  x.msgs.push(m);
  if (x.msgs.length > LIMITS.msgsPerTicket) x.msgs.splice(0, x.msgs.length - LIMITS.msgsPerTicket);
  return m;
}

// ---------------------------------------------------------------- die Aktionen
function create(device, b, ip = "") {
  sweep();
  const reason = REASONS.includes(b.reason) ? b.reason : "other";
  const name = clean(b.name, LIMITS.name);
  if (name.length < 2) throw new HelpError(400, "Bitte gib einen Namen an.");
  const mine = [...tickets.values()].filter((x) => x.ownerDevice === device && x.status !== "closed");
  if (mine.length >= LIMITS.openPerDevice) throw new HelpError(429, `Du hast schon ${mine.length} offene Tickets – schließ erst eins.`);
  const c = created.get(device);
  const n = c && c.day === today() ? c.n : 0;
  if (n >= LIMITS.createPerDay) throw new HelpError(429, "Heute hast du schon genug Tickets erstellt – morgen geht es wieder.");
  const ipKey = ip ? hash("ip:" + ip) : "";
  const ci = ipKey ? createdIp.get(ipKey) : null;
  const ni = ci && ci.day === today() ? ci.n : 0;
  if (ipKey && ni >= LIMITS.createPerIpDay) throw new HelpError(429, "Von deinem Anschluss kamen heute schon sehr viele Tickets – morgen geht es wieder.");
  created.set(device, { day: today(), n: n + 1 });
  if (ipKey) createdIp.set(ipKey, { day: today(), n: ni + 1 });
  if (created.size > 50_000) created.clear();
  if (createdIp.size > 50_000) createdIp.clear();
  const key = newKey();
  const x = {
    id: newId(), name, reason, text: clean(b.text, LIMITS.text), platform: b.platform === "pc" ? "pc" : "phone",
    createdAt: now(), touched: now(), status: "open", ownerDevice: device, ownerHash: hash(key), msgs: [], v: 1, call: null,
  };
  tickets.set(x.id, x);
  return { ok: true, key, ticket: view(x, "owner") };
}

/** Die offenen Tickets für alle – das eigene markiert, nichts Geheimes. */
function open(device) {
  sweep();
  return {
    tickets: [...tickets.values()].filter((x) => x.status === "open").sort((a, b) => b.createdAt - a.createdAt).slice(0, LIMITS.list)
      .map((x) => ({ id: x.id, name: x.name, reason: x.reason, text: x.text, platform: x.platform, createdAt: x.createdAt, mine: x.ownerDevice === device })),
  };
}

function accept(device, b) {
  const x = find(b.id);
  if (x.status !== "open") throw new HelpError(409, x.status === "closed" ? "Das Ticket ist schon geschlossen." : "Das hat schon jemand angenommen.");
  if (x.ownerDevice === device) throw new HelpError(400, "Das ist dein eigenes Ticket.");
  const name = clean(b.name, LIMITS.name);
  if (name.length < 2) throw new HelpError(400, "Bitte gib einen Namen an.");
  const key = newKey();
  Object.assign(x, { status: "taken", helperName: name, helperDevice: device, helperHash: hash(key), takenAt: now() });
  addMsg(x, "system", `${name} hat das Ticket angenommen.`);
  changed(x, "taken");
  return { ok: true, key, ticket: view(x, "helper") };
}

function sendMsg(b) {
  const x = find(b.id);
  const role = roleOf(x, b.key);
  if (!role) throw new HelpError(403, "Nicht erlaubt.");
  if (x.status === "open") throw new HelpError(409, "Das Ticket hat noch niemand angenommen.");
  if (x.status === "closed") throw new HelpError(409, "Das Ticket ist geschlossen.");
  const text = clean(b.text, LIMITS.text);
  if (!text) throw new HelpError(400, "Leere Nachricht.");
  const known = b.mid && x.msgs.some((m) => m.mid === b.mid);
  const m = addMsg(x, role, text, b.mid);
  if (!known) changed(x, "msg");
  return { ok: true, at: m.at, mid: m.mid };
}

function endCall(x, role) {
  const c = x.call;
  if (!c || (c.state !== "active" && c.state !== "ringing")) return;
  if (c.state === "ringing") {
    Object.assign(c, { state: "missed", endedAt: now() });
    addMsg(x, "system", `Verpasster Anruf von ${nameOf(x, c.by)}.`);
  } else {
    Object.assign(c, { state: "ended", endedAt: now(), endedBy: role });
    addMsg(x, "system", `Anruf beendet (${mmss(c.endedAt - c.startedAt)}).`);
  }
  changed(x, "call-end");
}

function close(b) {
  const x = find(b.id);
  const role = roleOf(x, b.key);
  if (!role) throw new HelpError(403, "Nicht erlaubt.");
  if (x.status !== "closed") {
    endCall(x, role);
    addMsg(x, "system", `${role === "owner" ? x.name : x.helperName} hat das Ticket geschlossen.`);
    Object.assign(x, { status: "closed", closedAt: now(), closedBy: role });
    changed(x, "closed");
  }
  return { ok: true, ticket: view(x, role) };
}

/** Anrufen (1.0.44): ring → beim anderen klingelt es; accept / decline; cancel (aufgelegt, bevor jemand ranging); end. */
function call(b) {
  const x = find(b.id);
  const role = roleOf(x, b.key);
  if (!role) throw new HelpError(403, "Nicht erlaubt.");
  expireCall(x);
  const c = x.call;
  const action = String(b.action || "");
  if (action === "ring") {
    if (x.status !== "taken") throw new HelpError(409, x.status === "closed" ? "Das Ticket ist geschlossen." : "Das Ticket hat noch niemand angenommen.");
    if (c && (c.state === "ringing" || c.state === "active")) {
      if (c.state === "ringing" && c.by !== role) {           // beide rufen gleichzeitig an → einfach verbinden
        Object.assign(c, { state: "active", startedAt: now() });
        changed(x, "call");
        return { ok: true, call: view(x, role).call };
      }
      return { ok: true, call: view(x, role).call };            // (schon dabei)
    }
    x.call = { n: (c?.n || 0) + 1, state: "ringing", by: role, at: now() };
    changed(x, "call");
    return { ok: true, call: view(x, role).call };
  }
  if (!c || (b.n && Number(b.n) !== c.n)) throw new HelpError(409, "Es gibt keinen Anruf.");
  if (action === "accept") {
    if (c.state !== "ringing" || c.by === role) throw new HelpError(409, c.state === "active" ? "Der Anruf läuft schon." : "Es klingelt gerade nicht.");
    Object.assign(c, { state: "active", startedAt: now() });
    changed(x, "call");
  } else if (action === "decline") {
    if (c.state !== "ringing" || c.by === role) throw new HelpError(409, "Es klingelt gerade nicht.");
    Object.assign(c, { state: "declined", endedAt: now() });
    addMsg(x, "system", `${nameOf(x, role)} hat den Anruf abgelehnt.`);
    changed(x, "call-end");
  } else if (action === "end" || action === "cancel") {
    endCall(x, role);
  } else {
    throw new HelpError(400, "Unbekannte Aktion.");
  }
  return { ok: true, call: view(x, role).call };
}

/** Alle Tickets eines Geräts auf einmal: Stand und neue Nachrichten seit [since]. Unbekannte → { unknown: true } (dann „restore“). */
function sync(b) {
  const items = Array.isArray(b.items) ? b.items.slice(0, 20) : [];
  return {
    items: items.map((it) => {
      const x = tickets.get(String(it.id || ""));
      if (!x) return { id: String(it.id || "").slice(0, 20), unknown: true };
      const role = roleOf(x, it.key);
      if (!role) return { id: x.id, forbidden: true };
      x.touched = now();
      return view(x, role, Number(it.since) || 0);
    }),
  };
}

/** Nur was sich gegenüber dem Stand des Geräts geändert hat (Version [v] oder Nachrichten nach [since]). */
function news(items) {
  const out = [];
  for (const it of items) {
    const x = tickets.get(String(it.id || ""));
    if (!x) { out.push({ id: String(it.id || "").slice(0, 20), unknown: true }); continue; }
    const role = roleOf(x, it.key);
    if (!role) { out.push({ id: x.id, forbidden: true }); continue; }
    expireCall(x);
    const since = Number(it.since) || 0;
    if ((x.v || 0) !== (Number(it.v) || 0) || x.msgs.some((m) => m.at > since)) { x.touched = now(); out.push(view(x, role, since)); }
  }
  return out;
}

/**
 * Wie sync – aber gibt es nichts Neues, hält der Server die Anfrage, bis sich an einem der Tickets etwas tut (höchstens
 * [LIMITS.waitMs]). So kommen Nachrichten und Anrufe in Sekunden an, ohne dass das Handy ständig fragt. [done](antwort)
 */
function wait(device, b, done, ms = LIMITS.waitMs) {
  const items = Array.isArray(b.items) ? b.items.slice(0, 20) : [];
  const first = news(items);
  if (first.length || !items.length) return done({ items: first });
  // ein Gerät wartet höchstens zweimal gleichzeitig (eine neue Anfrage beendet die älteste)
  const mine = [...waiting].filter((w) => w.device === device);
  if (mine.length >= 2) mine[0].finish();
  if (waiting.size >= LIMITS.waiters) return done({ items: [] });
  const w = { ids: new Set(items.map((it) => String(it.id || ""))), device, ended: false };
  // (ein klingelnder Anruf wird nach [ringSeconds] verpasst – auch dann soll die Antwort sofort kommen)
  const ringEnd = items.map((it) => tickets.get(String(it.id || ""))?.call).filter((c) => c && c.state === "ringing")
    .map((c) => c.at + LIMITS.ringSeconds * 1000 + 50 - now());
  const timer = setTimeout(() => w.finish(), Math.max(10, Math.min(ms, ...ringEnd)));
  w.finish = () => {
    if (w.ended) return;
    w.ended = true;
    clearTimeout(timer);
    waiting.delete(w);
    try { done({ items: news(items) }); } catch (e) { /* (Verbindung schon weg) */ }
  };
  /** (die Verbindung ist weg – nichts mehr schicken) */
  w.cancel = () => {
    if (w.ended) return;
    w.ended = true;
    clearTimeout(timer);
    waiting.delete(w);
  };
  waiting.add(w);
  return w;
}

/** Nach einem Neustart des Servers: ein Gerät meldet sein Ticket wieder an – mit beiden Schlüssel-Hashes und seinen letzten
 *  Nachrichten (die andere Seite holt sich, was ihr fehlt). */
function restore(device, b) {
  const t = b.ticket || {};
  const id = clean(b.id, 20);
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) throw new HelpError(400, "kaputtes Ticket");
  const role = b.role === "helper" ? "helper" : "owner";
  const myHash = hash(b.key || "");
  let x = tickets.get(id);
  if (x) {
    if (roleOf(x, b.key) !== role) throw new HelpError(403, "Nicht erlaubt.");
  } else {
    const ownerHash = role === "owner" ? myHash : clean(t.ownerHash, 60);
    const helperHash = role === "helper" ? myHash : clean(t.helperHash, 60);
    const status = ["open", "taken", "closed"].includes(t.status) ? t.status : "open";
    if (status !== "open" && !helperHash) throw new HelpError(400, "kaputtes Ticket");
    x = {
      id, name: clean(t.name, LIMITS.name) || "?", reason: REASONS.includes(t.reason) ? t.reason : "other", text: clean(t.text, LIMITS.text),
      platform: t.platform === "pc" ? "pc" : "phone", createdAt: Math.min(Number(t.createdAt) || now(), now()), touched: now(), status,
      ownerDevice: role === "owner" ? device : "", ownerHash, helperName: clean(t.helperName, LIMITS.name), helperDevice: role === "helper" ? device : "",
      helperHash, takenAt: Number(t.takenAt) || 0, closedAt: status === "closed" ? (Number(t.closedAt) || now()) : 0, closedBy: t.closedBy === "helper" ? "helper" : (status === "closed" ? "owner" : ""),
      msgs: [], v: 1, call: null,
    };
    tickets.set(id, x);
    sweep();
  }
  if (role === "owner" && !x.ownerDevice) x.ownerDevice = device;
  if (role === "helper" && !x.helperDevice) x.helperDevice = device;
  let added = false;
  for (const m of (Array.isArray(b.msgs) ? b.msgs.slice(-50) : [])) {
    if (m && (m.from === role) && typeof m.text === "string" && m.text.trim() && !x.msgs.some((y) => y.mid === m.mid)) {
      addMsg(x, role, clean(m.text, LIMITS.text), clean(m.mid, 40), Math.min(Number(m.at) || now(), now()));
      added = true;
    }
  }
  x.msgs.sort((a, b2) => a.at - b2.at);
  if (added) changed(x, "restore");
  return { ok: true, ticket: view(x, role) };
}

/** Für live.js: wer darf mit wem sprechen? → { x, role } oder HelpError. */
function liveCheck(id, key) {
  const x = find(id);
  const role = roleOf(x, key);
  if (!role) throw new HelpError(403, "Nicht erlaubt.");
  expireCall(x);
  if (!x.call || x.call.state !== "active") throw new HelpError(409, "Es läuft gerade kein Anruf.");
  return { x, role };
}

/** Der Einstieg aus server.js: Pfad + Gerät + Anfrage → Antwort (oder HelpError). „wait“ geht über [wait]. */
function handle(path, device, body, ip = "") {
  switch (path) {
    case "/v1/help/create": return create(device, body, ip);
    case "/v1/help/open": return open(device);
    case "/v1/help/accept": return accept(device, body);
    case "/v1/help/send": return sendMsg(body);
    case "/v1/help/close": return close(body);
    case "/v1/help/sync": return sync(body);
    case "/v1/help/restore": return restore(device, body);
    case "/v1/help/call": return call(body);
    default: throw new HelpError(404, "nicht gefunden");
  }
}

module.exports = {
  handle, wait, liveCheck, endCall, HelpError, LIMITS, REASONS, tickets, hash, listeners,
  _reset: () => { for (const w of [...waiting]) w.finish(); tickets.clear(); created.clear(); createdIp.clear(); },
  _clock: (f) => { clock = f || (() => Date.now()); },
  _waiting: () => waiting.size,
};
