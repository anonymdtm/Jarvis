// 1.9.0 – der Nutzer, 25.11.: „wie viele aktive Nutzer gerade live auf der Webseite sind und wie viele jemals auf der
// Webseite waren … wenn ich sie schließe und wieder drauf gehe, zählt das trotzdem nur als eine Person“.
//
// Der Browser des Besuchers merkt sich (nur nach „Einverstanden“) eine zufällige Nummer und schickt sie alle 30 Sekunden,
// solange die Seite offen ist. Hier wird daraus ein Fingerabdruck (HMAC – die Nummer selbst wird nie gespeichert):
//   jarvis:visitors   Menge aller Fingerabdrücke  → „insgesamt“ (jeder Browser genau einmal, egal wie oft er wiederkommt)
//   jarvis:live       Fingerabdruck → letztes Lebenszeichen → „gerade da“ (wer sich 75 s nicht gemeldet hat, ist weg)
// Keine IP-Adresse, kein Name, keine Seite, keine Uhrzeit pro Person wird dauerhaft gespeichert.
const crypto = require("crypto");
const premium = require("./premium.js");

const env = process.env;
const CFG = {
  liveMs: Number(env.VISITS_LIVE_SECONDS || 75) * 1000,
  // (die Webseite liegt auf GitHub Pages – nur sie darf zählen; weitere Adressen mit Komma)
  origins: String(env.SITE_ORIGINS || "https://anonymdtm.github.io").split(",").map((s) => s.trim()).filter(Boolean),
  newPerIpPerDay: Number(env.VISITS_NEW_PER_IP_PER_DAY || 20),   // (gegen Hochzählen mit erfundenen Nummern)
  cacheMs: 4000,
};
const secret = () => env.PREMIUM_SECRET || env.ADMIN_TOKEN || env.APP_TOKEN || "jarvis-besucher";

const mem = { all: new Set(), live: new Map() };                  // (ohne Upstash: bis zum nächsten Neustart)
let cache = { at: 0, v: null };

function okId(id) { return typeof id === "string" && /^[A-Za-z0-9-]{16,64}$/.test(id); }
function finger(id) { return crypto.createHmac("sha256", secret()).update("besucher:" + id).digest("hex").slice(0, 32); }

// neue Nummern je IP und Tag – nur im Speicher, nur als Zähler
const fresh = new Map();
function tooManyNew(ip) {
  const k = new Date().toISOString().slice(0, 10) + "|" + ip;
  const n = (fresh.get(k) || 0) + 1;
  fresh.set(k, n);
  if (fresh.size > 20_000) fresh.clear();
  return n > CFG.newPerIpPerDay;
}

function persistent() { return !!(premium.CFG.upstashUrl && premium.CFG.upstashToken); }

/** Ein Lebenszeichen (oder „bye“: die Seite wurde geschlossen). → { live, total } */
async function beat(id, ip, bye = false) {
  const f = finger(id), now = Date.now();
  if (persistent()) {
    if (bye) await premium.upstash("ZREM", "jarvis:live", f);
    else {
      let counted = Number(await premium.upstash("SISMEMBER", "jarvis:visitors", f)) === 1;
      if (!counted && !tooManyNew(ip)) counted = (await premium.upstash("SADD", "jarvis:visitors", f)) !== null;
      if (counted) await premium.upstash("ZADD", "jarvis:live", now, f);
    }
  } else if (bye) mem.live.delete(f);
  else {
    if (!mem.all.has(f) && !tooManyNew(ip)) mem.all.add(f);
    if (mem.all.has(f)) mem.live.set(f, now);
  }
  cache.at = 0;
  return counts();
}

/** { live, total } – höchstens alle paar Sekunden frisch gezählt */
async function counts() {
  const now = Date.now();
  if (cache.v && now - cache.at < CFG.cacheMs) return cache.v;
  let live = null, total = null;
  if (persistent()) {
    await premium.upstash("ZREMRANGEBYSCORE", "jarvis:live", "-inf", now - CFG.liveMs);
    total = await premium.upstash("SCARD", "jarvis:visitors");
    live = await premium.upstash("ZCARD", "jarvis:live");
  }
  if (live === null || total === null) {                          // (ohne Upstash oder Upstash gerade nicht erreichbar)
    for (const [f, t] of mem.live) if (now - t > CFG.liveMs) mem.live.delete(f);
    live = mem.live.size; total = mem.all.size;
  }
  cache = { at: now, v: { live: Number(live) || 0, total: Math.max(Number(total) || 0, Number(live) || 0) } };
  return cache.v;
}

/** CORS nur für die Webseite (die App fragt direkt, ohne Browser) */
function cors(req) {
  const o = String(req.headers.origin || "");
  return CFG.origins.includes(o) ? { "access-control-allow-origin": o, "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type", "access-control-max-age": "86400", vary: "origin" } : {};
}

module.exports = { CFG, beat, counts, cors, okId, finger, mem };
