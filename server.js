// Jarvis-Proxy – der Schlüssel liegt nur hier auf dem Server, nie in der App.
// Keine Abhängigkeiten (Node 18+). Streamt Antworten Wort für Wort (Server-Sent Events) und wechselt bei Überlastung
// (503/429/Zeitüberschreitung) automatisch zum nächsten kostenlosen Modell.
//
// App → POST /v1/chat   { "messages":[{"role":"user","content":"Hallo"}], "system":"…", "task":"chat"|"code"|"vision", "stream":true }
//       bei "vision" zusätzlich "image":{"mime":"image/jpeg","data":"<base64>"} („Was ist das?“ – Foto, Screenshot, Bild)
//       freiwillig "prefer":["nemotron-3.5-super","nemotron"] – das Modell aus der Modellauswahl der App (Teile der Namen)
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
const premium = require("./premium.js");

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
  maxCodeMessage: 40_000,                                // … beim Programmieren (1.0.42: das Spiel geht zum Nachbessern mit)
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
  const longest = body.task === "code" ? CFG.maxCodeMessage : CFG.maxMessage;
  const messages = body.messages.map((m) => {
    if (!m || typeof m !== "object" || typeof m.content !== "string") throw new Bad("kaputte Nachricht");
    if (m.role !== "user" && m.role !== "assistant") throw new Bad("unbekannte Rolle");
    const content = m.content.replace(/\u0000/g, "").trim();
    if (content.length > longest) throw new Bad("Nachricht zu lang");
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
  // der Modell-Wunsch der App (Modellauswahl, oder „ein starkes“ für eine schwere Frage): Teile von OpenRouter-Namen, das beste zuerst
  let prefer = [];
  if (body.prefer !== undefined) {
    if (!Array.isArray(body.prefer) || body.prefer.length > 6 || !body.prefer.every((p) => typeof p === "string" && /^[a-z0-9.:\/_-]{2,80}$/.test(p))) {
      throw new Bad("kaputter Modell-Wunsch");
    }
    prefer = body.prefer;
  }
  // (Premium, 1.3.0) das Modell aus der Auswahl „Alle Modelle“ – ein Schlüssel aus /v1/premium/status, z. B. "claude-sonnet"
  let model = "";
  if (body.model !== undefined) {
    if (typeof body.model !== "string" || !/^[a-z0-9.:\/_-]{0,80}$/.test(body.model)) throw new Bad("kaputter Modell-Wunsch");
    model = body.model === "auto" ? "" : body.model;
  }
  const mt = Number(body.max_tokens);
  const maxTokens = Number.isFinite(mt) ? Math.min(Math.max(Math.round(mt), 16), 4000) : 800;
  return { messages: messages.slice(-30), system, task, image, prefer, maxTokens, stream: body.stream !== false, fast: body.fast === true, model };
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
    premium.setModels(j.data);                            // (die bezahlten Modelle für Premium aus derselben Liste)
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

async function open(url, init, kind = "or", outside = null) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CFG.firstByteMs);
  // (ein anderes Modell war schneller – diese Anfrage wird abgebrochen)
  if (outside) {
    if (outside.aborted) ac.abort();
    else outside.addEventListener("abort", () => ac.abort(), { once: true });
  }
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

async function* gemini(model, system, messages, maxTokens, image, signal = null) {
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
    { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": CFG.geminiKey }, body: JSON.stringify(body) }, "gemini", signal);
  try {
    for await (const data of sse(res)) {
      let j; try { j = JSON.parse(data); } catch { continue; }
      const parts = j.candidates?.[0]?.content?.parts || [];
      const text = parts.filter((p) => !p.thought).map((p) => (typeof p.text === "string" ? p.text : "")).join("");
      if (text) { clearTimeout(timer); yield text; }
    }
  } finally { clearTimeout(timer); }
}

async function* openrouter(model, system, messages, maxTokens, image, signal = null, meter = null) {
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
    // (meter: Premium – OpenRouter schickt am Ende mit, was die Antwort gekostet hat)
    body: JSON.stringify({ model, messages: msgs, max_tokens: Math.min(8000, Math.max(1500, maxTokens * 4)), stream: true,
      ...(meter ? { usage: { include: true } } : {}) }),
  }, "or", signal);
  try {
    for await (const data of sse(res)) {
      if (data === "[DONE]") break;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new Retry("Fehler mitten in der Antwort");
      if (meter && j.usage) meter.usage = j.usage;
      const text = j.choices?.[0]?.delta?.content;
      if (typeof text === "string" && text) { clearTimeout(timer); yield text; }
    }
  } finally { clearTimeout(timer); }
}

/** Geht die Modellliste durch, bis eines Text liefert. Hat ein Modell schon angefangen, bleibt es dabei – bricht es dann ab,
 *  endet die Antwort dort (nie zwei Modelle in einer Antwort). */
/** Das gewünschte kostenlose Modell (Modellauswahl der App) – null, wenn es keins gibt. Bei Bildern nur eins, das sehen kann. */
async function wished(prefer, task) {
  if (!prefer || !prefer.length) return null;
  const f = await freeModels();
  const ids = task === "vision" ? f.vision : f.ids;
  for (const p of prefer) {
    const m = ids.find((x) => x !== "openrouter/free" && x.includes(p));
    if (m) return "or:" + m;
  }
  return null;
}

/** Wie schnell ein Modell zuletzt das erste Wort lieferte (ms, gleitender Mittelwert) – bei Bildern kommt das schnellste zuerst. */
const speed = new Map();
function noteSpeed(entry, ms) {
  const old = speed.get(entry);
  speed.set(entry, old === undefined ? ms : Math.round(old * 0.6 + ms * 0.4));
}
/** Nach so vielen ms ohne erstes Wort fragt der Server zusätzlich das nächste Modell – wer zuerst antwortet, gewinnt. */
const HEDGE = { vision: Number(env.HEDGE_VISION_MS || 6000), chat: Number(env.HEDGE_CHAT_MS || 8000), code: Number(env.HEDGE_CODE_MS || 12000) };

const FAST_HEDGE = Number(env.HEDGE_FAST_MS || 2500);

async function* answer(task, system, messages, maxTokens, log, image = null, prefer = [], fast = false) {
  const entries = task === "code" ? CFG.code : task === "vision" ? CFG.vision : CFG.chat;
  const resolved = [];
  for (const raw of entries) {
    const entry = await resolve(raw);
    if (entry && !resolved.includes(entry)) resolved.push(entry);
  }
  // (gerade überlastete Modelle zuletzt – aber trotzdem noch versuchen, vielleicht sind sie wieder da)
  let ready = resolved.filter((e) => !isBusy(e));
  // 1.0.45: bei Bildern das zuletzt schnellste zuerst (der Nutzer, 3.11.: „4, 5 Minuten, bis eine Antwort kommt“)
  // 1.2.1: "fast" (Jarvis spricht in einem Anruf – der Anrufer wartet) → auch hier das schnellste zuerst, früher parallel
  if (task === "vision" || fast) {
    const rank = (e) => (speed.has(e) ? speed.get(e) : 8000);
    ready = ready.map((e, i) => [e, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
  }
  let order = ready.concat(resolved.filter(isBusy));
  // der Wunsch der App zuerst (auch wenn es eben überlastet war – die anderen bleiben als Ersatz dahinter)
  const wish = await wished(prefer, task);
  if (wish) order = [wish].concat(order.filter((e) => e !== wish));
  const t0 = Date.now();
  const runs = [];
  let next = 0;
  const launch = () => {
    if (next >= order.length) return false;
    const entry = order[next++];
    const [kind, ...rest] = entry.split(":");
    const ac = new AbortController();
    const it = (kind === "gemini" ? gemini : openrouter)(rest.join(":"), system, messages, maxTokens, image, ac.signal)[Symbol.asyncIterator]();
    const run = { entry, ac, it, at: Date.now() };
    run.first = it.next().then((r) => ({ run, r }), (e) => ({ run, e }));
    runs.push(run);
    return true;
  };
  const stopAll = (except) => {
    for (const x of runs) if (x !== except) { x.ac.abort(); x.it.return().catch(() => {}); }
  };
  let winner = null, firstPiece = "";
  launch();
  while (!winner && runs.length) {
    let hedgeTimer = null;
    const hedge = next < order.length ? new Promise((ok) => { hedgeTimer = setTimeout(() => ok({ hedge: true }), fast ? FAST_HEDGE : HEDGE[task] || 8000); }) : null;
    const got = await Promise.race(runs.map((x) => x.first).concat(hedge ? [hedge] : []));
    clearTimeout(hedgeTimer);
    if (got.hedge) {                                   // (das Modell lässt sich Zeit – das nächste fängt parallel an)
      log(`${task}: ${runs.map((x) => x.entry).join(" + ")} noch still nach ${Date.now() - t0} ms – frage zusätzlich ${order[next]}`);
      launch();
      continue;
    }
    const { run, r, e } = got;
    runs.splice(runs.indexOf(run), 1);
    if (e) {
      if (e instanceof Stop) {
        if (e.note) log(`WICHTIG: ${e.note}`);
        stopAll(null);
        throw e;
      }
      busy.set(run.entry, Date.now() + CFG.busyMs);
      log(`Modell ${run.entry} geht nicht (${e.message})`);
    } else if (r.done) {
      busy.set(run.entry, Date.now() + CFG.busyMs);
      log(`Modell ${run.entry}: leere Antwort`);
    } else {
      winner = run;
      firstPiece = r.value;
      break;
    }
    if (!runs.length) launch();                        // (keins läuft mehr – gleich das nächste)
  }
  if (!winner) {
    throw new Error(task === "vision" ? "Gerade kann sich keins der kostenlosen Modelle Bilder ansehen. Versuch es in einer Minute nochmal."
      : "Alle kostenlosen Modelle sind gerade überlastet. Versuch es in einer Minute nochmal.");
  }
  stopAll(winner);                                     // (die anderen werden nicht mehr gebraucht)
  const firstMs = Date.now() - winner.at;
  const firstAt = Date.now() - t0;
  noteSpeed(winner.entry, firstMs);
  busy.delete(winner.entry);
  let chars = firstPiece.length;
  yield { text: firstPiece, model: winner.entry };
  try {
    for (;;) {
      const r = await winner.it.next();
      if (r.done) break;
      chars += r.value.length;
      yield { text: r.value, model: winner.entry };
    }
  } catch (e) {
    log(`Modell ${winner.entry} brach mitten in der Antwort ab (${e.message})`);
  } finally {
    // (nur Zeiten und Längen ins Protokoll – nie Inhalte)
    log(`${task}: ${winner.entry} – erstes Wort nach ${firstAt} ms (Modell selbst ${firstMs} ms), fertig nach ${Date.now() - t0} ms, ${chars} Zeichen`);
  }
}

/** Premium (1.3.0): das bezahlte Modell antwortet, die Kosten gehen vom Budget des Codes ab. Geht es nicht (Guthaben bei
 *  OpenRouter leer, Modell weg, Störung), antworten wie immer die kostenlosen – der Nutzer bekommt in jedem Fall eine Antwort. */
async function* paidAnswer(prem, input, log) {
  const meter = {};
  const t0 = Date.now();
  let chars = 0;
  const charsIn = input.system.length + input.messages.reduce((n, m) => n + m.content.length, 0) + (input.image ? 3000 : 0);
  try {
    for await (const text of openrouter(prem.model.id, input.system, input.messages, input.maxTokens, input.image, null, meter)) {
      chars += text.length;
      yield { text, model: "premium:" + prem.model.name };
    }
  } catch (e) {
    if (!chars) {
      log(`WICHTIG: Premium-Modell ${prem.model.id} geht nicht (${e.message}) – Guthaben bei OpenRouter prüfen. Antwort kommt kostenlos.`);
      prem.fellBack = true;
      yield* answer(input.task, input.system, input.messages, input.maxTokens, log, input.image, input.prefer, input.fast);
      return;
    }
    log(`Premium-Modell ${prem.model.id} brach mitten in der Antwort ab (${e.message})`);
  } finally {
    if (chars) {
      const c = premium.cost(prem.model, meter.usage, charsIn, chars);
      premium.charge(prem.id, c);
      log(`premium ${input.task}: ${prem.model.id} – ${Date.now() - t0} ms, ${chars} Zeichen, ${(c * 100).toFixed(3)} Cent, Code …${prem.id.slice(-4)}`);
    }
  }
}

// ---------------------------------------------------------------- HTTP
function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(obj));
}

function readBody(req, max = CFG.maxBody) {
  return new Promise((ok, bad) => {
    let n = 0; const parts = [];
    req.on("data", (c) => { n += c.length; if (n > max) { bad(new Bad("zu groß")); req.destroy(); } else parts.push(c); });
    req.on("end", () => ok(Buffer.concat(parts).toString("utf8")));
    req.on("error", bad);
  });
}

// ---------------------------------------------------------------- Hilfe-Tickets (1.0.43, siehe help.js)
const help = require("./help.js");
const helpByDevice = limiter(Number(env.HELP_PER_MINUTE || 120), Number(env.HELP_PER_DAY || 20_000));
const helpByIp = limiter(Number(env.HELP_IP_PER_MINUTE || 400), Number(env.HELP_IP_PER_DAY || 100_000));
async function handleHelp(req, res) {
  if (!CFG.appToken || !sameSecret(req.headers["x-jarvis-token"] || "", CFG.appToken)) return send(res, 401, { error: "nicht erlaubt" });
  const device = String(req.headers["x-device"] || "").slice(0, 80);
  if (!/^[A-Za-z0-9-]{8,80}$/.test(device)) return send(res, 400, { error: "Gerät unbekannt" });
  const limit = helpByIp(clientIp(req)) || helpByDevice(device);
  if (limit) return send(res, 429, { error: limit });
  const path = req.url.split("?")[0];
  let body = {};
  if (req.method === "POST") {
    if (!String(req.headers["content-type"] || "").includes("application/json")) return send(res, 415, { error: "nur JSON" });
    let raw;
    try { raw = await readBody(req, 200_000); } catch (e) { return send(res, 413, { error: "zu groß" }); }
    try { body = JSON.parse(raw || "{}"); } catch (e) { return send(res, 400, { error: "kaputte Anfrage" }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, { error: "kaputte Anfrage" });
  } else if (req.method !== "GET" || path !== "/v1/help/open") {
    return send(res, 405, { error: "nicht erlaubt" });
  }
  if (path === "/v1/help/wait") {
    // (1.0.44) der Server hält die Anfrage, bis sich an einem der Tickets etwas tut – Nachrichten und Anrufe kommen sofort an
    return new Promise((resolve) => {
      const w = help.wait(device, body, (out) => { send(res, 200, out); resolve(); });
      res.on("close", () => { if (w && w.cancel) w.cancel(); resolve(); });
    });
  }
  try {
    return send(res, 200, help.handle(path, device, body, clientIp(req)));
  } catch (e) {
    if (e instanceof help.HelpError) return send(res, e.status, { error: e.message });
    throw e;
  }
}

// ---------------------------------------------------------------- das Gespräch zu zweit (1.0.44, siehe live.js)
const live = require("./live.js");
help.listeners.push((x, what) => { if (what === "call-end" || what === "closed") live.hangUp(x.id); });
function handleUpgrade(req, socket, head) {
  socket.on("error", () => {});
  const deny = (code, text) => { try { socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); } catch (e) { /* */ } };
  if (String(req.url || "").split("?")[0] !== "/v1/help/live") return deny(404, "Not Found");
  if (!CFG.appToken || !sameSecret(req.headers["x-jarvis-token"] || "", CFG.appToken)) return deny(401, "Unauthorized");
  const device = String(req.headers["x-device"] || "").slice(0, 80);
  if (!/^[A-Za-z0-9-]{8,80}$/.test(device)) return deny(400, "Bad Request");
  const limit = helpByIp(clientIp(req)) || helpByDevice(device);
  if (limit) return deny(429, "Too Many Requests");
  live.join(help, req, socket, head);
}

// ---------------------------------------------------------------- Premium (1.3.0, siehe premium.js)
const premiumByIp = limiter(30, 2000);
const adminByIp = limiter(6, 60);                      // (wer das Verwaltungs-Passwort rät, kommt nicht weit)
const imageByDevice = limiter(Number(env.IMAGE_PER_MINUTE || 4), Number(env.IMAGE_PER_DAY || 60));
const premiumByDevice = limiter(Number(env.PREMIUM_PER_MINUTE || 20), Number(env.PREMIUM_PER_DAY || 1500));
async function handlePremium(req, res) {
  const ip = clientIp(req);
  if (req.method === "GET" && req.url === "/admin") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    return res.end(premium.ADMIN_PAGE);
  }
  if (req.method === "POST" && req.url === "/v1/premium/admin/code") {
    const limit = adminByIp(ip);
    if (limit) return send(res, 429, { error: limit });
    if (!premium.CFG.admin || premium.CFG.admin.length < 12 || !premium.on()) return send(res, 503, { error: "Premium ist auf dem Server noch nicht eingerichtet (ADMIN_TOKEN und PREMIUM_SECRET)." });
    if (!sameSecret(req.headers["x-admin-token"] || "", premium.CFG.admin)) return send(res, 401, { error: "Falsches Passwort." });
    let body;
    try { body = JSON.parse(await readBody(req, 2000) || "{}"); } catch (e) { return send(res, 400, { error: "kaputte Anfrage" }); }
    try {
      const code = premium.make(String(body.plan || ""), body.days === undefined ? 30 : body.days, body.budget);
      const c = premium.parse(code);
      console.log(new Date().toISOString(), `Premium-Code erstellt: ${c.plan}, ${c.budget} $, bis ${c.until}, …${c.id.slice(-4)}`);
      return send(res, 200, { code, plan: c.plan, budget: c.budget, until: c.until });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (req.method === "GET" && req.url === "/v1/premium/status") {
    if (!CFG.appToken || !sameSecret(req.headers["x-jarvis-token"] || "", CFG.appToken)) return send(res, 401, { error: "nicht erlaubt" });
    const limit = premiumByIp(ip);
    if (limit) return send(res, 429, { error: limit });
    if (!premium.on()) return send(res, 200, { ok: false, error: "Premium gibt es auf diesem Server noch nicht." });
    const st = await premium.status(String(req.headers["x-jarvis-premium"] || "").slice(0, 60));
    if (!st.ok) return send(res, 200, st);
    await freeModels();
    const { id, ...out } = st;
    return send(res, 200, { ...out, models: premium.models() });
  }
  // 1.3.1 – Sebastian, 9.11.: „der soll auch Bilder generieren können, so wie ChatGPT … wenn ich ihm 3 Bilder schicke und sage,
  // ändere die Person“. Nur mit Premium (ein Bild kostet ein paar Cent): { "prompt":"…", "images":[{mime,data}] (0–3) }
  if (req.method === "POST" && req.url === "/v1/premium/image") {
    if (!CFG.appToken || !sameSecret(req.headers["x-jarvis-token"] || "", CFG.appToken)) return send(res, 401, { error: "nicht erlaubt" });
    const device = String(req.headers["x-device"] || "").slice(0, 80);
    if (!/^[A-Za-z0-9-]{8,80}$/.test(device)) return send(res, 400, { error: "Gerät unbekannt" });
    const limit = premiumByIp(ip) || imageByDevice(device);
    if (limit) return send(res, 429, { error: limit });
    const code = String(req.headers["x-jarvis-premium"] || "").slice(0, 60);
    const st = premium.on() && code ? await premium.status(code) : { ok: false };
    if (!st.ok) return send(res, 402, { error: "Bilder erstellen geht nur mit Jarvis Premium. Trag unter „Premium“ einen Code ein." });
    if (!st.active) return send(res, 402, { error: st.expired ? "Dein Premium-Code ist abgelaufen." : "Das Budget deines Premium-Codes ist aufgebraucht." });
    let body;
    try { body = JSON.parse(await readBody(req, 5_200_000)); } catch (e) { return send(res, 400, { error: "kaputte Anfrage oder Bilder zu groß" }); }
    const prompt = typeof body.prompt === "string" ? body.prompt.replace(/\u0000/g, "").trim() : "";
    const images = body.images === undefined ? [] : body.images;
    if (prompt.length < 3 || prompt.length > 2000) return send(res, 400, { error: "Beschreib bitte kurz, was auf dem Bild sein soll." });
    if (!Array.isArray(images) || images.length > 3 || !images.every((im) => im && typeof im.data === "string" && /^image\/(jpeg|png|webp)$/.test(String(im.mime || ""))
      && im.data.length >= 100 && im.data.length <= CFG.maxImage && /^[A-Za-z0-9+/]+={0,2}$/.test(im.data))) return send(res, 400, { error: "Bild zu groß oder kaputt" });
    await freeModels();
    const m = premium.imageModel();
    if (!m || !CFG.openrouterKey) return send(res, 503, { error: "Gerade ist kein Modell da, das Bilder erstellen kann. Versuch es später nochmal." });
    const t0 = Date.now();
    let j;
    try {
      const r = await fetch(`${CFG.openrouterBase}/chat/completions`, {
        method: "POST", signal: AbortSignal.timeout(150_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${CFG.openrouterKey}`, "x-title": "Jarvis" },
        body: JSON.stringify({ model: m.id, modalities: ["image", "text"], usage: { include: true }, messages: [{ role: "user",
          content: [{ type: "text", text: prompt }].concat(images.map((im) => ({ type: "image_url", image_url: { url: `data:${im.mime};base64,${im.data}` } }))) }] }),
      });
      if (!r.ok) {
        console.log(new Date().toISOString(), `WICHTIG: Bild-Modell ${m.id} geht nicht (HTTP ${r.status})${r.status === 402 ? " – Guthaben bei OpenRouter prüfen" : ""}`);
        return send(res, 503, { error: "Das Bild konnte gerade nicht erstellt werden. Versuch es später nochmal." });
      }
      j = await r.json();
    } catch (e) {
      return send(res, 503, { error: "Das Bild hat zu lange gedauert. Versuch es nochmal." });
    }
    const msg = j.choices?.[0]?.message || {};
    const url = String(msg.images?.[0]?.image_url?.url || "");
    const got = url.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    const said = typeof msg.content === "string" ? msg.content.trim().slice(0, 600) : "";
    if (!got) {
      // (kein Bild – z. B. weil das Modell es ablehnt; was es dazu sagt, sind wenige Sätze an den Nutzer)
      return send(res, 422, { error: said || "Dazu konnte ich kein Bild erstellen. Beschreib es bitte anders." });
    }
    const c = Number(j.usage?.cost) > 0 ? Number(j.usage.cost) : 0.04;
    premium.charge(st.id, c);
    console.log(new Date().toISOString(), `premium bild: ${m.id} – ${Date.now() - t0} ms, ${images.length} Bild(er) dazu, ${(c * 100).toFixed(2)} Cent, Code …${st.id.slice(-4)}`);
    const now = await premium.status(code);
    return send(res, 200, { image: { mime: got[1], data: got[2] }, text: said, model: m.name, premium: { active: now.active, plan: now.plan, percent: now.percent } });
  }
  return send(res, 404, { error: "nicht gefunden" });
}

// ---------------------------------------------------------------- kostenlos: Bilder und genaues Zuhören (1.4.0, siehe free.js)
const cloud = require("./free.js");
const freeImageByDevice = limiter(Number(env.FREE_IMAGE_PER_MINUTE || 3), Number(env.FREE_IMAGE_PER_DAY || 20));
const sttByDevice = limiter(Number(env.STT_PER_MINUTE || 30), Number(env.STT_PER_DAY || 1500));
const sttByIp = limiter(60, 4000);

/** „mal mir eine Katze im Weltall“ → ein guter englischer Bild-Prompt (FLUX versteht Englisch am besten). Klappt das nicht
 *  schnell, geht der Wunsch so, wie er ist. */
async function imagePrompt(wish, inputs, log) {
  const system = "You turn a user's wish (often German, often spoken) into ONE prompt for the image model FLUX.2. Write in English, " +
    "40–120 words: subject, setting, style, light, colours, camera/medium. Keep every detail the user asked for, invent nothing that " +
    "contradicts it. Text that must appear in the picture stays in its original language, in quotes. " +
    (inputs ? `The user attached ${inputs} picture(s); refer to them as "image 1", "image 2" … and say exactly what to keep and what to change. ` : "") +
    "Answer with the prompt only – no quotes around it, no explanation.";
  try {
    let text = "";
    const gen = answer("chat", system, [{ role: "user", content: wish }], 300, () => {}, null, [], true);
    const stop = Date.now() + 9000;
    for await (const p of gen) { text += p.text; if (Date.now() > stop) break; }
    text = text.trim().replace(/^["„“]|["“”]$/g, "");
    if (text.length >= 10 && text.length <= 1500) return text;
  } catch (e) { log(`bild-prompt: ${e.message}`); }
  return wish;
}

// 1.5.0 – Sebastian, 14.11.: „woher soll derjenige wissen, welche KI-Modelle er kostenlos benutzt und welche er mit Premium kriegt?“
/** "or:google/gemma-4-31b-it:free" → "Gemma 4 31B", "gemini:gemini-2.5-flash" → "Gemini 2.5 Flash" */
function prettyModel(entry) {
  let id = String(entry || "").replace(/^(or|gemini):/, "").split("/").pop().replace(/:free$/, "").replace(/-(it|instruct|chat|preview|exp)(?=-|$)/gi, "");
  return id.split("-").filter(Boolean).map((w) => /^\d+(\.\d+)?[bkm]$/i.test(w) ? w.toUpperCase() : /^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w).join(" ").slice(0, 40);
}
async function modelOverview() {
  await freeModels();
  const chat = [];
  for (const e of CFG.chat) { const r = await resolve(e); if (r && r !== "or:openrouter/free") { const n = prettyModel(r); if (n && !chat.includes(n)) chat.push(n); } }
  const paid = premium.models().map((m) => m.name);
  const painter = premium.imageModel();
  return {
    free: { chat: chat.slice(0, 4), image: cloud.on() ? "FLUX.2 [dev]" : "", hearing: cloud.on() ? "Whisper large-v3-turbo" : "", images_per_day: Number(env.FREE_IMAGE_PER_DAY || 20) },
    premium: { chat: paid, image: painter ? painter.name : "", pc_control: true },
  };
}

async function handleFree(req, res, log) {
  if (req.method === "GET" && req.url === "/v1/models") {
    if (!CFG.appToken || !sameSecret(req.headers["x-jarvis-token"] || "", CFG.appToken)) return send(res, 401, { error: "nicht erlaubt" });
    return send(res, 200, await modelOverview());
  }
  if (req.method !== "POST") return send(res, 404, { error: "nicht gefunden" });
  if (!CFG.appToken || !sameSecret(req.headers["x-jarvis-token"] || "", CFG.appToken)) return send(res, 401, { error: "nicht erlaubt" });
  const device = String(req.headers["x-device"] || "").slice(0, 80);
  if (!/^[A-Za-z0-9-]{8,80}$/.test(device)) return send(res, 400, { error: "Gerät unbekannt" });
  const ip = clientIp(req);
  if (req.url === "/v1/stt") {
    // { "audio":"<WAV 16 kHz mono, Base64>", "hint":"Jarvis, Discord, Spotify …" } → { "text":"…" }
    const limit = sttByIp(ip) || sttByDevice(device);
    if (limit) return send(res, 429, { error: limit });
    let body;
    try { body = JSON.parse(await readBody(req, 1_800_000)); } catch (e) { return send(res, 400, { error: "kaputte Anfrage oder zu lang" }); }
    const audio = typeof body.audio === "string" ? body.audio : "";
    if (audio.length < 1000 || audio.length > 1_750_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) return send(res, 400, { error: "kein Ton" });
    const hint = typeof body.hint === "string" ? body.hint.replace(/\u0000/g, "").slice(0, 400) : "";
    const secs = cloud.wavSeconds(Buffer.from(audio, "base64"));
    const no = cloud.sttAllowed(secs);
    if (no) return send(res, 503, { error: no });
    try { return send(res, 200, { text: await cloud.hear(audio, hint, log), model: "whisper-large-v3-turbo" }); }
    catch (e) { return send(res, e.status || 503, { error: e.message }); }
  }
  if (req.url === "/v1/image") {
    // { "prompt":"…", "images":[{mime,data}] (0–4, je ≤ 512 px), "shape":"square"|"portrait"|"landscape" } → { image:{mime,data} }
    const flood = premiumByIp(ip);
    if (flood) return send(res, 429, { error: flood });
    let body;
    try { body = JSON.parse(await readBody(req, 3_000_000)); } catch (e) { return send(res, 400, { error: "kaputte Anfrage oder Bilder zu groß" }); }
    const wish = typeof body.prompt === "string" ? body.prompt.replace(/\u0000/g, "").trim() : "";
    const images = body.images === undefined ? [] : body.images;
    if (wish.length < 3 || wish.length > 2000) return send(res, 400, { error: "Beschreib bitte kurz, was auf dem Bild sein soll." });
    if (!Array.isArray(images) || images.length > 4 || !images.every((im) => im && typeof im.data === "string" && /^image\/(jpeg|png|webp)$/.test(String(im.mime || ""))
      && im.data.length >= 100 && im.data.length <= 700_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(im.data))) return send(res, 400, { error: "Bild zu groß oder kaputt" });
    const shape = ["square", "portrait", "landscape"].includes(body.shape) ? body.shape : cloud.shapeOf(wish);
    const [w, h] = cloud.size(shape);
    const no = cloud.imageAllowed(w, h, images.length);
    if (no) return send(res, cloud.on() ? 429 : 503, { error: no });
    const limit = freeImageByDevice(device);            // (erst hier: ein kaputter Versuch zählt nicht mit)
    if (limit) return send(res, 429, { error: limit === "Das Tageslimit ist erreicht – morgen geht es wieder." ? "Für heute hast du genug Bilder gemacht – morgen geht es wieder." : limit });
    const prompt = await imagePrompt(wish, images.length, log);
    try {
      const image = await cloud.paint(prompt, images, shape, log);
      return send(res, 200, { image, model: "FLUX.2", text: "" });
    } catch (e) { return send(res, e.status || 503, { error: e.message }); }
  }
  return send(res, 404, { error: "nicht gefunden" });
}

// ---------------------------------------------------------------- Premium kaufen mit PayPal (1.5.0, siehe shop.js)
const shop = require("./shop.js");
const shopByIp = limiter(Number(env.SHOP_PER_MINUTE || 10), Number(env.SHOP_PER_DAY || 60));
async function handleShop(req, res, log) {
  if (req.method === "GET" && (req.url === "/kaufen" || req.url.startsWith("/kaufen?"))) {
    if (!shop.on()) { res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }); return res.end("Premium kaufen ist gerade nicht eingerichtet."); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    return res.end(shop.page());
  }
  if (req.method !== "POST") return send(res, 404, { error: "nicht gefunden" });
  if (!shop.on()) return send(res, 503, { error: "Premium kaufen ist gerade nicht eingerichtet." });
  const limit = shopByIp(clientIp(req));
  if (limit) return send(res, 429, { error: limit });
  try {
    if (req.url === "/v1/shop/order") return send(res, 200, { id: await shop.createOrder() });
    if (req.url === "/v1/shop/capture") {
      let body;
      try { body = JSON.parse(await readBody(req, 2000) || "{}"); } catch (e) { return send(res, 400, { error: "kaputte Anfrage" }); }
      const o = await shop.capture(String(body.order || ""), log);
      return send(res, 200, { code: o.code, email: o.email ? o.email.replace(/^(.).*(@.*)$/, "$1…$2") : "", mailed: Boolean(o.mailed), until: o.until });
    }
  } catch (e) {
    if (!e.status) log(`shop: ${e.message}`);
    return send(res, e.status || 502, { error: e.status ? e.message : "PayPal ist gerade nicht erreichbar. Es wurde nichts abgebucht.", retry: Boolean(e.retry) });
  }
  return send(res, 404, { error: "nicht gefunden" });
}

const server = http.createServer(async (req, res) => {
  const log = (m) => console.log(new Date().toISOString(), m);   // (nie Inhalte oder Schlüssel)
  try {
    if (req.method === "GET" && req.url === "/healthz") return send(res, 200, { ok: true });   // (auch zum Aufwecken)
    if (req.url.startsWith("/v1/help/")) return await handleHelp(req, res);
    if (req.url.startsWith("/v1/premium/") || req.url === "/admin") return await handlePremium(req, res);
    if (req.url === "/v1/image" || req.url === "/v1/stt" || req.url === "/v1/models") return await handleFree(req, res, log);
    if (req.url === "/kaufen" || req.url.startsWith("/kaufen?") || req.url.startsWith("/v1/shop/")) return await handleShop(req, res, log);
    if (req.method !== "POST" || req.url !== "/v1/chat") return send(res, 404, { error: "nicht gefunden" });
    if (!CFG.appToken || !sameSecret(req.headers["x-jarvis-token"] || "", CFG.appToken)) return send(res, 401, { error: "nicht erlaubt" });
    if (!String(req.headers["content-type"] || "").includes("application/json")) return send(res, 415, { error: "nur JSON" });
    const ip = clientIp(req);
    const device = String(req.headers["x-device"] || "").slice(0, 80);
    if (!/^[A-Za-z0-9-]{8,80}$/.test(device)) return send(res, 400, { error: "Gerät unbekannt" });
    // Premium: ein gültiger Code mit Rest-Budget – eigene (großzügige) Grenzen, das Tageslimit der Gratis-Modelle gilt nicht
    let prem = null, premNote = null;
    const code = String(req.headers["x-jarvis-premium"] || "").slice(0, 60);
    if (code && premium.on()) {
      const st = await premium.status(code);
      if (st.ok && st.active) prem = { id: st.id, plan: st.plan };
      else if (st.ok) premNote = { active: false, reason: st.expired ? "abgelaufen" : "leer" };
    }
    const limit = prem ? premiumByDevice(device) : byIp(ip) || byDevice(device);
    if (limit) return send(res, 429, { error: limit });

    let input;
    try {
      input = checkBody(JSON.parse(await readBody(req)));
    } catch (e) {
      return send(res, e instanceof Bad ? 400 : 400, { error: e instanceof Bad ? e.message : "kaputte Anfrage" });
    }
    if (prem) {
      await freeModels();
      prem.model = premium.pick(prem.plan, input.task, input.model);
      if (!prem.model) prem = null;                       // (die Liste der bezahlten Modelle ist gerade nicht da)
    }
    if (!prem) {
      const cap = allowedAll();
      if (cap) return send(res, 429, { error: cap });
    }
    /** Was die App über das Abo wissen muss – hängt an der fertigen Antwort. */
    const premInfo = async () => {
      if (!prem) return premNote ? { premium: premNote } : {};
      const st = await premium.status(code);
      return { premium: { active: st.active, plan: st.plan, percent: st.percent, ...(prem.fellBack ? { fallback: true } : {}) } };
    };
    const gen = prem ? paidAnswer(prem, input, log)
      : answer(input.task, input.system, input.messages, input.maxTokens, log, input.image, input.prefer, input.fast);
    if (!input.stream) {
      let text = "", model = "";
      try {
        for await (const p of gen) { text += p.text; model = p.model; }
      } catch (e) { return send(res, e.status || 503, { error: e.message }); }
      return send(res, 200, { text: text.trim(), model, ...(await premInfo()) });
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
      res.write(`data: ${JSON.stringify({ done: true, model, ...(await premInfo()) })}\n\n`);
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
  if (!shop.on()) console.warn("HINWEIS: PAYPAL_CLIENT_ID / PAYPAL_SECRET (oder PREMIUM_SECRET) fehlen – /kaufen ist aus.");
  else console.log(`Premium kaufen: ${shop.CFG.live ? "LIVE – echtes Geld" : "PayPal-Sandbox (Testgeld)"}, ${shop.CFG.price} € für ${shop.CFG.days} Tage`);
  if (!cloud.on()) console.warn("HINWEIS: CF_ACCOUNT_ID / CF_API_TOKEN fehlen – kostenlose Bilder und genaues Zuhören (Cloudflare) sind aus.");
  if (premium.on() && !premium.CFG.upstashUrl) console.warn("HINWEIS: Premium ohne UPSTASH_REDIS_REST_URL – der Verbrauch der Codes beginnt nach jedem Neustart wieder bei 0.");
  server.listen(CFG.port, () => {
    console.log(`Jarvis-Proxy läuft auf Port ${CFG.port} – Reden: ${CFG.chat.join(" → ")} | Code: ${CFG.code.join(" → ")} | Bilder: ${CFG.vision.join(" → ")}`);
    if (keepAwake()) console.log("Hält sich wach (ruft sich alle 10 Minuten selbst auf).");
  });
}
server.on("upgrade", handleUpgrade);
module.exports = { server, CFG, checkBody, clientIp, orWhy, resetHour, keepAwake, busy, help, live, premium, cloud, shop };
