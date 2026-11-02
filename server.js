// Jarvis-Proxy – der Schlüssel liegt nur hier auf dem Server, nie in der App.
// Keine Abhängigkeiten (Node 18+). Streamt Antworten Wort für Wort (Server-Sent Events) und wechselt bei Überlastung
// (503/429/Zeitüberschreitung) automatisch zum nächsten kostenlosen Modell.
//
// App → POST /v1/chat   { "messages":[{"role":"user","content":"Hallo"}], "system":"…", "task":"chat"|"code"|"vision", "stream":true }
//       bei "vision" zusätzlich "image":{"mime":"image/jpeg","data":"<base64>"} („Was ist das?“ – Foto, Screenshot, Bild)
//       Kopfzeilen: x-jarvis-token (APP_TOKEN), x-device (zufällige Geräte-ID der App)
// Antwort (stream:true):  data: {"delta":"Hal"}\n\n … data: {"done":true,"model":"…"}\n\n
// Antwort (stream:false): {"text":"…","model":"…"}
//
// 1.0.2 (3.11.2026): Bilder („Was ist das?“ ohne eigenen Schlüssel), überlastete Modelle werden 5 Minuten übersprungen,
// ist das Tageskontingent von OpenRouter weg, hört der Server sofort auf (statt alle Modelle durchzuprobieren), und auf
// Render hält er sich selbst wach (sonst schläft er nach 15 Minuten ein und die erste Antwort dauert fast eine Minute).
//
// Schutz (1.0.1, nach „So wirst du beim Vibe Coding nicht gehackt“):
//  1. Rate-Limiting: pro Gerät, pro IP-Adresse (die Geräte-ID kann jeder fälschen – die IP nicht so leicht) und eine
//     Obergrenze am Tag für alle zusammen, damit die Gratis-Kontingente nicht an einem Tag weg sind.
//  2. Eingabeprüfung: nur bekannte Felder, Rollen user/assistant, Länge jeder Nachricht und des Ganzen begrenzt.
//  3. Schlüssel nur in Umgebungsvariablen auf dem Server – nie in der App, nie in Antworten oder Protokollen.
"use strict";
const http = require("http");
const crypto = require("crypto");

const env = process.env;
const list = (v, d) => (v || d).split(",").map((s) => s.trim()).filter(Boolean);
const CFG = {
  port: Number(env.PORT || 8787),
  appToken: env.APP_TOKEN || "",                         // gemeinsames Geheimnis der App (hält Zufallsbesucher fern, keine Profis)
  geminiKey: env.GEMINI_API_KEY || "",
  openrouterKey: env.OPENROUTER_API_KEY || "",
  // Reihenfolge der kostenlosen Modelle: "gemini:<id>" = Google AI Studio, "or:<id>" = OpenRouter,
  // "or:@chat" / "or:@code" = das beste gerade kostenlose OpenRouter-Modell zum Reden / Programmieren (Liste wird geholt).
  // Standard: nur die kostenlosen OpenRouter-Modelle. Google erlaubt den KOSTENLOSEN Gemini-Zugang nicht in Apps für Nutzer in
  // der EU, der Schweiz und Großbritannien („You may use only Paid Services when making API Clients available to users in the
  // EEA …“, Gemini API Additional Terms) – Gemini also nur mit einem Google-Abrechnungskonto in MODELS_CHAT/MODELS_CODE eintragen.
  chat: list(env.MODELS_CHAT, "or:@chat,or:@chat2,or:openrouter/free"),
  code: list(env.MODELS_CODE, "or:@code,or:@chat,or:openrouter/free"),
  vision: list(env.MODELS_VISION, "or:@vision,or:@vision2,or:openrouter/free"),   // Modelle, die Bilder ansehen können
  firstByteMs: Number(env.FIRST_BYTE_MS || 20000),       // so lange darf ein Modell bis zum ersten Wort brauchen
  perMinute: Number(env.LIMIT_PER_MINUTE || 12),         // pro Gerät
  perDay: Number(env.LIMIT_PER_DAY || 15),               // pro Gerät
  ipPerMinute: Number(env.LIMIT_IP_PER_MINUTE || 30),    // pro IP-Adresse (mehrere Handys im selben WLAN teilen sich eine)
  ipPerDay: Number(env.LIMIT_IP_PER_DAY || 30),
  // alle zusammen: OpenRouter erlaubt ohne gekauftes Guthaben 50 Gratis-Anfragen am Tag (mit einmal 10 $ Guthaben 1000) –
  // 45 lässt etwas Luft. Nach dem Kauf von 10 $: LIMIT_ALL_PER_DAY=950 (und LIMIT_PER_DAY / LIMIT_IP_PER_DAY höher).
  allPerDay: Number(env.LIMIT_ALL_PER_DAY || 45),
  maxBody: 1_700_000,                                    // Bytes pro Anfrage (ein Bild passt – Text ist unten enger begrenzt)
  maxImage: 1_600_000,                                   // Base64-Zeichen eines Bildes (gut 1 MB JPEG; die App verkleinert vorher)
  maxMessage: 8_000,                                     // Zeichen pro Nachricht
  maxTotal: 60_000,                                      // Zeichen aller Nachrichten zusammen
  maxSystem: 20_000,
  trustProxy: env.TRUST_PROXY !== "0",                   // Render/Railway stehen vor dem Server: die echte IP steht in x-forwarded-for
  geminiBase: env.GEMINI_BASE || "https://generativelanguage.googleapis.com/v1beta",   // (Tests zeigen hierhin um)
  openrouterBase: env.OPENROUTER_BASE || "https://openrouter.ai/api/v1",
  busyMs: Number(env.BUSY_MS || 5 * 60_000),             // ein überlastetes Modell so lange hinten anstellen
  // Render schläft nach 15 Minuten ohne Anfrage ein – der Server ruft sich alle 10 Minuten selbst auf (KEEP_AWAKE=0: aus)
  selfUrl: env.KEEP_AWAKE === "0" ? "" : (env.RENDER_EXTERNAL_URL || env.SELF_URL || ""),
};

// ---------------------------------------------------------------- Begrenzung (Rate-Limiting)
const day = () => new Date().toISOString().slice(0, 10);
function limiter(perMinute, perDay) {
  const hits = new Map(); // Schlüssel → { minute:[Zeitpunkte], key:Tag, n }
  return (k) => {
    const now = Date.now();
    const h = hits.get(k) || { minute: [], key: "", n: 0 };
    h.minute = h.minute.filter((t) => now - t < 60_000);
    if (h.key !== day()) { h.key = day(); h.n = 0; }
    if (h.minute.length >= perMinute) return "Zu viele Anfragen – bitte kurz warten.";
    if (h.n >= perDay) return "Das Tageslimit ist erreicht – morgen geht es wieder.";
    h.minute.push(now);
    h.n++;
    hits.delete(k);
    hits.set(k, h);                                       // (zuletzt benutzt nach hinten – die ältesten fliegen zuerst raus)
    if (hits.size > 20_000) for (const old of hits.keys()) { hits.delete(old); if (hits.size < 15_000) break; }
    return "";
  };
}
const byDevice = limiter(CFG.perMinute, CFG.perDay);
const byIp = limiter(CFG.ipPerMinute, CFG.ipPerDay);
const all = { key: "", n: 0 };
function allowedAll() {
  if (all.key !== day()) { all.key = day(); all.n = 0; }
  if (all.n >= CFG.allPerDay) return "Jarvis ist heute schon sehr gefragt – das kostenlose Kontingent für heute ist aufgebraucht. Morgen geht es wieder.";
  all.n++;
  return "";
}

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "");
  // (der Anbieter hängt die echte Adresse hinten an – vorne kann jeder etwas hineinschreiben)
  const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
  return (CFG.trustProxy && parts.length ? parts[parts.length - 1] : req.socket.remoteAddress || "?").slice(0, 64);
}

function sameSecret(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);                    // (gleich lange Prüfung – verrät nichts über den richtigen Code)
}

// ---------------------------------------------------------------- Eingabeprüfung
class Bad extends Error {}
function checkBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Bad("kaputte Anfrage");
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 40) throw new Bad("keine oder zu viele Nachrichten");
  let total = 0;
  const messages = body.messages.map((m) => {
    if (!m || typeof m !== "object" || typeof m.content !== "string") throw new Bad("kaputte Nachricht");
    if (m.role !== "user" && m.role !== "assistant") throw new Bad("unbekannte Rolle");
    const content = m.content.replace(/\u0000/g, "").trim();
    if (content.length > CFG.maxMessage) throw new Bad("Nachricht zu lang");
    total += content.length;
    return { role: m.role, content };
  }).filter((m) => m.content);
  if (!messages.length || messages[messages.length - 1].role !== "user") throw new Bad("die letzte Nachricht muss vom Nutzer sein");
  if (total > CFG.maxTotal) throw new Bad("zu viel Text auf einmal");
  if (body.system !== undefined && typeof body.system !== "string") throw new Bad("kaputter System-Text");
  const system = (body.system || "").slice(0, CFG.maxSystem);
  const task = body.task === undefined ? "chat" : body.task;
  if (!["chat", "code", "vision"].includes(task)) throw new Bad("unbekannte Aufgabe");
  let image = null;
  if (task === "vision") {
    const im = body.image;
    if (!im || typeof im !== "object" || typeof im.data !== "string" || !/^image\/(jpeg|png|webp)$/.test(String(im.mime || ""))) {
      throw new Bad("kein Bild");
    }
    if (im.data.length < 100 || im.data.length > CFG.maxImage || !/^[A-Za-z0-9+/]+={0,2}$/.test(im.data)) throw new Bad("Bild zu groß oder kaputt");
    image = { mime: im.mime, data: im.data };
  } else if (body.image !== undefined) {
    throw new Bad("ein Bild nur bei task vision");
  }
  const mt = Number(body.max_tokens);
  const maxTokens = Number.isFinite(mt) ? Math.min(Math.max(Math.round(mt), 16), 4000) : 800;
  return { messages: messages.slice(-30), system, task, image, maxTokens, stream: body.stream !== false };
}

// ---------------------------------------------------------------- die kostenlosen OpenRouter-Modelle (Liste alle 12 Stunden)
const CHAT_PREFS = ["gemma-4", "nemotron-3.5-super", "nemotron-3-nano", "gemma-3", "nemotron", "llama-4", "llama-3.3", "mistral-small"];
const CODE_PREFS = ["north-mini-code", "coder", "devstral", "codestral", "inkling", "flint"];
const VISION_PREFS = ["gemma-4", "nemotron", "qwen", "llama-4", "gemma-3", "mistral-small", "kimi"];
const free = { ids: [], vision: [], at: 0 };
async function freeModels() {
  if (free.ids.length && Date.now() - free.at < 12 * 3600_000) return free;
  try {
    const r = await fetch(`${CFG.openrouterBase}/models`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    const ok = (j.data || []).filter((m) => {
      const p = m.pricing || {};
      const outs = (m.architecture || {}).output_modalities;
      return m.id && (String(m.id).endsWith(":free") || (p.prompt === "0" && p.completion === "0")) && (!outs || outs.includes("text"));
    });
    const ids = ok.map((m) => String(m.id));
    if (ids.length) {
      free.ids = ids;
      free.vision = ok.filter((m) => ((m.architecture || {}).input_modalities || []).includes("image")).map((m) => String(m.id));
      free.at = Date.now();
    }
  } catch { /* (die alte Liste bleibt) */ }
  return free;
}
const BEST = { "or:@chat": [CHAT_PREFS, 0], "or:@chat2": [CHAT_PREFS, 1], "or:@code": [CODE_PREFS, 0], "or:@vision": [VISION_PREFS, 0], "or:@vision2": [VISION_PREFS, 1] };
async function resolve(entry) {
  if (!BEST[entry]) return entry;
  const f = await freeModels();
  const [prefs, nth] = BEST[entry];
  const ids = entry.startsWith("or:@vision") ? f.vision : f.ids;
  // (@chat2 / @vision2: the second-best free one – another family if there is one)
  const found = [];
  for (const p of prefs) { const m = ids.find((x) => x.includes(p) && x !== "openrouter/free" && !found.includes(x)); if (m) found.push(m); }
  return found[nth] ? "or:" + found[nth] : "";
}

// Ein überlastetes Modell (429 vom Anbieter, 5xx, zu langsam) kommt für ein paar Minuten nach hinten – die nächste Frage
// geht gleich an eines, das gerade antwortet (spart Wartezeit und Gratis-Anfragen).
const busy = new Map();
const isBusy = (entry) => (busy.get(entry) || 0) > Date.now();

// ---------------------------------------------------------------- Anbieter → einheitlicher Strom von Textstücken
class Retry extends Error {}   // dieses Modell geht gerade nicht – das nächste probieren
class Stop extends Error {     // es geht gerade gar keins (Tageskontingent weg, Schlüssel abgelehnt …) – sofort aufhören
  constructor(message, status, note) { super(message); this.status = status; this.note = note; }
}

/** Wann es wieder Gratis-Anfragen gibt: OpenRouter zählt den UTC-Tag → in Deutschland 1 Uhr (Sommerzeit 2 Uhr). */
function resetHour(now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const h = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "numeric", hourCycle: "h23" }).formatToParts(next)
    .find((p) => p.type === "hour");
  return String(Number(h ? h.value : 1));
}

/** Warum OpenRouter Nein sagt – der Text des Anbieters wird nur gelesen, nie an die App geschickt. */
function orWhy(status, text, headers) {
  const t = String(text || "").toLowerCase();
  const upstream = t.includes("upstream") || t.includes("provider_name") || t.includes("provider returned error");
  const pick = (name, re) => {
    const v = headers && typeof headers.get === "function" ? headers.get(name) : null;
    if (v !== null && v !== undefined && v !== "") return Number(v);
    const m = t.match(re);
    return m ? Number(m[1]) : NaN;
  };
  const limit = pick("x-ratelimit-limit", /x-ratelimit-limit\W{1,4}(\d+)/);
  const left = pick("x-ratelimit-remaining", /x-ratelimit-remaining\W{1,4}(\d+)/);
  if (status === 401 || (status === 403 && !/moderation|flagged/.test(t))) return "key";
  if (status === 402) return "pay";
  if (status === 404 && /data policy|privacy|guardrail/.test(t)) return "privacy";
  if (status === 429 && !upstream && (t.includes("per-day") || (left === 0 && limit >= 50))) return "day";
  if (status === 429 && !upstream && (t.includes("per-min") || (left === 0 && limit < 50))) return "minute";
  return "retry";
}

async function* sse(res) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true }).replace(/\r/g, "");   // (Google trennt mit \r\n\r\n)
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (data) yield data;
    }
  }
  const rest = buf.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
  if (rest) yield rest;
}

async function open(url, init, kind = "or") {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CFG.firstByteMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 4000);
      const why = kind === "or" ? orWhy(res.status, text, res.headers) : "retry";
      // (der App nur unsere eigenen Sätze – ins Protokoll nur, was Sebastian tun muss)
      if (why === "day") throw new Stop(`Das kostenlose Kontingent ist für heute aufgebraucht – ab ${resetHour()} Uhr geht es wieder.`, 429);
      if (why === "minute") throw new Stop("Gerade kommen sehr viele Fragen auf einmal – in einer Minute geht es wieder.", 429);
      if (why === "key") throw new Stop("Der Jarvis-Server hat gerade ein Problem mit seinem Zugang. Bitte versuch es später nochmal.", 503,
        "OpenRouter lehnt den Schlüssel ab (401/403) – OPENROUTER_API_KEY in Render prüfen");
      if (why === "privacy") throw new Stop("Der Jarvis-Server darf gerade keine kostenlosen Modelle benutzen. Bitte versuch es später nochmal.", 503,
        "OpenRouter: unter openrouter.ai → Settings → Privacy die kostenlosen Modelle (free endpoints) erlauben");
      throw new Retry(`HTTP ${res.status}`);              // (nur der Code ins Protokoll – nie, was der Anbieter zurückschickt)
    }
    return { res, timer };
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof Stop || e instanceof Retry) throw e;
    throw new Retry(e.name === "AbortError" ? "Zeitüberschreitung" : "keine Verbindung");
  }
}

async function* gemini(model, system, messages, maxTokens, image) {
  if (!CFG.geminiKey) throw new Retry("kein Google-Schlüssel");
  const body = {
    contents: messages.map((m, i) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }].concat(image && i === messages.length - 1 ? [{ inline_data: { mime_type: image.mime, data: image.data } }] : []),
    })),
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.6 },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const { res, timer } = await open(`${CFG.geminiBase}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": CFG.geminiKey }, body: JSON.stringify(body) }, "gemini");
  try {
    for await (const data of sse(res)) {
      let j; try { j = JSON.parse(data); } catch { continue; }
      const parts = j.candidates?.[0]?.content?.parts || [];
      const text = parts.filter((p) => !p.thought).map((p) => (typeof p.text === "string" ? p.text : "")).join("");
      if (text) { clearTimeout(timer); yield text; }
    }
  } finally { clearTimeout(timer); }
}

async function* openrouter(model, system, messages, maxTokens, image) {
  if (!CFG.openrouterKey) throw new Retry("kein OpenRouter-Schlüssel");
  // (ein Bild hängt an der letzten Nachricht – so wie OpenAI es erwartet)
  const withImage = messages.map((m, i) => (image && i === messages.length - 1
    ? { role: m.role, content: [{ type: "text", text: m.content }, { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.data}` } }] }
    : m));
  const msgs = (system ? [{ role: "system", content: system }] : []).concat(withImage);
  const { res, timer } = await open(`${CFG.openrouterBase}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CFG.openrouterKey}`, "x-title": "Jarvis" },
    // (Denk-Modelle zählen ihr Nachdenken in max_tokens mit – Platz dafür lassen, die Antwort bleibt durch den Prompt kurz)
    body: JSON.stringify({ model, messages: msgs, max_tokens: Math.min(8000, Math.max(1500, maxTokens * 4)), stream: true }),
  });
  try {
    for await (const data of sse(res)) {
      if (data === "[DONE]") break;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new Retry("Fehler mitten in der Antwort");
      const text = j.choices?.[0]?.delta?.content;
      if (typeof text === "string" && text) { clearTimeout(timer); yield text; }
    }
  } finally { clearTimeout(timer); }
}

/** Geht die Modellliste durch, bis eines Text liefert. Hat ein Modell schon angefangen, bleibt es dabei – bricht es dann ab,
 *  endet die Antwort dort (nie zwei Modelle in einer Antwort). */
async function* answer(task, system, messages, maxTokens, log, image = null) {
  const entries = task === "code" ? CFG.code : task === "vision" ? CFG.vision : CFG.chat;
  const resolved = [];
  for (const raw of entries) {
    const entry = await resolve(raw);
    if (entry && !resolved.includes(entry)) resolved.push(entry);
  }
  // (gerade überlastete Modelle zuletzt – aber trotzdem noch versuchen, vielleicht sind sie wieder da)
  const order = resolved.filter((e) => !isBusy(e)).concat(resolved.filter(isBusy));
  for (const entry of order) {
    const [kind, ...rest] = entry.split(":");
    const model = rest.join(":");
    let started = false;
    try {
      const gen = (kind === "gemini" ? gemini : openrouter)(model, system, messages, maxTokens, image);
      for await (const piece of gen) { started = true; yield { text: piece, model: entry }; }
      if (started) { busy.delete(entry); return; }
      busy.set(entry, Date.now() + CFG.busyMs);
      log(`Modell ${entry}: leere Antwort`);
    } catch (e) {
      if (e instanceof Stop) {
        if (e.note) log(`WICHTIG: ${e.note}`);
        if (started) return;
        throw e;
      }
      if (started) { log(`Modell ${entry} brach mitten in der Antwort ab (${e.message})`); return; }
      busy.set(entry, Date.now() + CFG.busyMs);
      log(`Modell ${entry} geht nicht (${e.message})`);
    }
  }
  throw new Error(task === "vision" ? "Gerade kann sich keins der kostenlosen Modelle Bilder ansehen. Versuch es in einer Minute nochmal."
    : "Alle kostenlosen Modelle sind gerade überlastet. Versuch es in einer Minute nochmal.");
}

// ---------------------------------------------------------------- HTTP
function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((ok, bad) => {
    let n = 0; const parts = [];
    req.on("data", (c) => { n += c.length; if (n > CFG.maxBody) { bad(new Bad("zu groß")); req.destroy(); } else parts.push(c); });
    req.on("end", () => ok(Buffer.concat(parts).toString("utf8")));
    req.on("error", bad);
  });
}

const server = http.createServer(async (req, res) => {
  const log = (m) => console.log(new Date().toISOString(), m);   // (nie Inhalte oder Schlüssel)
  try {
    if (req.method === "GET" && req.url === "/healthz") return send(res, 200, { ok: true });   // (auch zum Aufwecken)
    if (req.method !== "POST" || req.url !== "/v1/chat") return send(res, 404, { error: "nicht gefunden" });
    if (!CFG.appToken || !sameSecret(req.headers["x-jarvis-token"] || "", CFG.appToken)) return send(res, 401, { error: "nicht erlaubt" });
    if (!String(req.headers["content-type"] || "").includes("application/json")) return send(res, 415, { error: "nur JSON" });
    const ip = clientIp(req);
    const device = String(req.headers["x-device"] || "").slice(0, 80);
    if (!/^[A-Za-z0-9-]{8,80}$/.test(device)) return send(res, 400, { error: "Gerät unbekannt" });
    const limit = byIp(ip) || byDevice(device);
    if (limit) return send(res, 429, { error: limit });

    let input;
    try {
      input = checkBody(JSON.parse(await readBody(req)));
    } catch (e) {
      return send(res, e instanceof Bad ? 400 : 400, { error: e instanceof Bad ? e.message : "kaputte Anfrage" });
    }
    const cap = allowedAll();
    if (cap) return send(res, 429, { error: cap });

    const gen = answer(input.task, input.system, input.messages, input.maxTokens, log, input.image);
    if (!input.stream) {
      let text = "", model = "";
      try {
        for await (const p of gen) { text += p.text; model = p.model; }
      } catch (e) { return send(res, e.status || 503, { error: e.message }); }
      return send(res, 200, { text: text.trim(), model });
    }
    // Streaming: erst wenn das erste Stück da ist, gehen die Kopfzeilen raus (bis dahin darf noch gewechselt werden)
    let headed = false;
    const head = () => {
      if (!headed) {
        headed = true;
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
      }
    };
    let model = "";
    try {
      for await (const p of gen) {
        if (res.destroyed) return;                       // (die App hat aufgelegt)
        head(); model = p.model;
        res.write(`data: ${JSON.stringify({ delta: p.text })}\n\n`);
      }
      head();
      res.write(`data: ${JSON.stringify({ done: true, model })}\n\n`);
      res.end();
    } catch (e) {
      if (!headed) return send(res, e.status || 503, { error: e.message });
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      res.end();
    }
  } catch (e) {
    log(`Fehler: ${e.message}`);
    if (!res.headersSent) send(res, 500, { error: "Serverfehler" }); else res.end();
  }
});
server.headersTimeout = 15_000;     // (wer seine Kopfzeilen nicht schickt, hält keine Verbindung offen)
server.requestTimeout = 30_000;     // (ein Bild über langsames Handynetz braucht etwas länger)

/** Render schläft nach 15 Minuten ohne Anfrage ein – dann dauert die erste Antwort fast eine Minute. Der Server ruft sich
 *  deshalb alle 10 Minuten selbst über seine öffentliche Adresse auf (Render setzt RENDER_EXTERNAL_URL von selbst). */
function keepAwake() {
  if (!CFG.selfUrl) return null;
  const ping = () => fetch(`${CFG.selfUrl.replace(/\/+$/, "")}/healthz`, { signal: AbortSignal.timeout(15000) }).catch(() => {});
  const t = setInterval(ping, 10 * 60_000);
  t.unref();
  return t;
}

if (require.main === module) {
  if (!CFG.appToken) console.warn("WARNUNG: APP_TOKEN fehlt – der Server nimmt keine Anfragen an.");
  if (!CFG.openrouterKey && !CFG.geminiKey) console.warn("WARNUNG: OPENROUTER_API_KEY fehlt – der Server kann keine Frage beantworten.");
  server.listen(CFG.port, () => {
    console.log(`Jarvis-Proxy läuft auf Port ${CFG.port} – Reden: ${CFG.chat.join(" → ")} | Code: ${CFG.code.join(" → ")} | Bilder: ${CFG.vision.join(" → ")}`);
    if (keepAwake()) console.log("Hält sich wach (ruft sich alle 10 Minuten selbst auf).");
  });
}
module.exports = { server, CFG, checkBody, clientIp, orWhy, resetHour, keepAwake, busy };
