// Jarvis Premium (1.3.0) – Codes mit einem festen Budget für die bezahlten Modelle.
//
// Sebastian, 9.11.2026: „dass man dann zum Beispiel bei mir auch so 12 Euro oder so zahlt und dann kann man die ganzen Modelle
// benutzen“ – und: „dass sie es erstmal kostenlos testen können“. Deshalb: ein Code = ein Abo-Zeitraum = ein Budget in Dollar.
// Jede Antwort eines bezahlten Modells wird vom Budget abgezogen (OpenRouter sagt, was sie gekostet hat). Ist es leer oder der
// Code abgelaufen, antworten wieder die kostenlosen Modelle – es kann nie mehr kosten, als die Codes zusammen wert sind.
//
// Ein Code trägt alles in sich (Abo, Budget, Ablauftag, Nummer) und ist mit PREMIUM_SECRET unterschrieben – der Server muss
// keine Liste der Codes aufbewahren. Aufbewahrt wird nur der Verbrauch je Code: im Speicher und, wenn UPSTASH_REDIS_REST_URL /
// UPSTASH_REDIS_REST_TOKEN gesetzt sind, dauerhaft bei Upstash (kostenlos) – sonst beginnt er nach einem Neustart wieder bei 0.
"use strict";
const crypto = require("crypto");

const env = process.env;
const CFG = {
  secret: env.PREMIUM_SECRET || "",
  admin: env.ADMIN_TOKEN || "",
  upstashUrl: (env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, ""),
  upstashToken: env.UPSTASH_REDIS_REST_TOKEN || "",
  // Abo → Budget in Dollar für die Laufzeit des Codes (Standard 30 Tage)
  plans: Object.fromEntries((env.PREMIUM_PLANS || "test:1,basis:4,plus:7,max:15").split(",").map((s) => s.trim().split(":"))
    .filter((p) => p.length === 2 && Number(p[1]) > 0).map(([n, b]) => [n, Number(b)])),
  // „Name=OpenRouter-Modell“ – leer: die neuesten der bekannten Familien werden aus OpenRouters Liste gesucht
  models: (env.PREMIUM_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean),
};
const PLAN_IDS = ["test", "basis", "plus", "max"];          // (die Nummer im Code – nie umsortieren)
const on = () => CFG.secret.length >= 16;                 // (ein kurzes Geheimnis ließe sich erraten)

// ---------------------------------------------------------------- Codes
const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";              // (ohne 0/O und 1/I – wird abgetippt)
function b32(buf) {
  let bits = 0, n = 0, out = "";
  for (const b of buf) { bits = (bits << 8) | b; n += 8; while (n >= 5) { out += B32[(bits >>> (n - 5)) & 31]; n -= 5; } }
  if (n) out += B32[(bits << (5 - n)) & 31];
  return out;
}
function unb32(s) {
  let bits = 0, n = 0; const out = [];
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    bits = (bits << 5) | v; n += 5;
    if (n >= 8) { out.push((bits >>> (n - 8)) & 255); n -= 8; }
  }
  return Buffer.from(out);
}
const mac = (payload) => crypto.createHmac("sha256", CFG.secret).update(payload).digest().subarray(0, 7);
const today = () => Math.floor(Date.now() / 86_400_000);

/** Ein neuer Code: Abo, Laufzeit in Tagen, Budget in Dollar (leer: das Budget des Abos). */
function make(plan, days = 30, budget = null) {
  if (!on()) throw new Error("PREMIUM_SECRET fehlt");
  const p = PLAN_IDS.indexOf(plan);
  if (p < 0 || !CFG.plans[plan]) throw new Error("unbekanntes Abo");
  const cents = Math.round((budget === null || budget === undefined || budget === "" ? CFG.plans[plan] : Number(budget)) * 100);
  const d = Math.round(Number(days));
  if (!(cents >= 10 && cents <= 20_000) || !(d >= 1 && d <= 400)) throw new Error("Budget oder Laufzeit passt nicht");
  const payload = Buffer.alloc(9);
  payload.writeUInt8(p, 0);
  payload.writeUInt16BE(today() + d, 1);
  payload.writeUInt16BE(cents, 3);
  crypto.randomBytes(4).copy(payload, 5);
  const raw = b32(Buffer.concat([payload, mac(payload)]));   // 16 Bytes → 26 Zeichen
  return "JV-" + raw.match(/.{1,5}/g).join("-");
}

/** Liest einen Code – null, wenn er nicht von diesem Server stammt. */
function parse(code) {
  if (!on() || typeof code !== "string") return null;
  const s = code.toUpperCase().replace(/^JV/, "").replace(/[^A-Z0-9]/g, "");
  if (s.length !== 26) return null;
  const buf = unb32(s);
  if (!buf || buf.length < 16) return null;
  const payload = buf.subarray(0, 9), sig = buf.subarray(9, 16);
  if (!crypto.timingSafeEqual(sig, mac(payload))) return null;
  const plan = PLAN_IDS[payload.readUInt8(0)];
  if (!plan) return null;
  const until = payload.readUInt16BE(1);
  return {
    id: payload.subarray(5, 9).toString("hex"), plan, budget: payload.readUInt16BE(3) / 100,
    until: new Date(until * 86_400_000).toISOString().slice(0, 10), expired: today() >= until,
  };
}

// ---------------------------------------------------------------- Verbrauch je Code (Mikro-Dollar)
const used = new Map();
async function upstash(...cmd) {
  if (!CFG.upstashUrl || !CFG.upstashToken) return null;
  try {
    const r = await fetch(CFG.upstashUrl, {
      method: "POST", headers: { authorization: `Bearer ${CFG.upstashToken}`, "content-type": "application/json" },
      body: JSON.stringify(cmd), signal: AbortSignal.timeout(4000),
    });
    return r.ok ? (await r.json()).result : null;
  } catch { return null; }
}
async function spent(id) {
  if (!used.has(id)) {
    const v = Number(await upstash("GET", `jarvis:used:${id}`));
    if (!used.has(id)) used.set(id, Number.isFinite(v) && v > 0 ? v : 0);
  }
  return used.get(id) / 1e6;
}
function charge(id, dollars) {
  const micro = Math.max(0, Math.round(dollars * 1e6));
  if (!micro) return;
  used.set(id, (used.get(id) || 0) + micro);
  upstash("INCRBY", `jarvis:used:${id}`, micro).then((v) => {
    // (ein anderer Server-Start hat auch gezählt – der höhere Stand gilt)
    if (Number(v) > (used.get(id) || 0)) used.set(id, Number(v));
  });
  upstash("EXPIRE", `jarvis:used:${id}`, 420 * 86_400);
}

/** Was ein Code gerade wert ist. */
async function status(code) {
  const c = parse(code);
  if (!c) return { ok: false, error: "Diesen Code kenne ich nicht. Prüf ihn bitte noch einmal." };
  const u = await spent(c.id);
  const left = Math.max(0, c.budget - u);
  return {
    ok: true, id: c.id, plan: c.plan, until: c.until, expired: c.expired, budget: c.budget, used: Math.round(u * 1000) / 1000,
    left: Math.round(left * 1000) / 1000, percent: Math.round((left / c.budget) * 100), active: !c.expired && left > 0.0005,
  };
}

// ---------------------------------------------------------------- die bezahlten Modelle
// Familie → [Name in der App, Muster der OpenRouter-Kennung]. Aus OpenRouters Liste wird je Familie das neueste genommen.
const FAMILIES = [
  ["claude-fable", "Claude Fable", /^anthropic\/claude-fable-[\d.]+$/],
  ["claude-opus", "Claude Opus", /^anthropic\/claude-opus-[\d.]+$/],
  ["claude-sonnet", "Claude Sonnet", /^anthropic\/claude-sonnet-[\d.]+$/],
  ["claude-haiku", "Claude Haiku", /^anthropic\/claude-haiku-[\d.]+$/],
  ["gpt", "ChatGPT", /^openai\/gpt-[\d.]+$/],
  ["gpt-mini", "ChatGPT mini", /^openai\/gpt-[\d.]+-mini$/],
  ["gemini-pro", "Gemini Pro", /^google\/gemini-[\d.]+-pro(-preview)?$/],
  ["gemini-flash", "Gemini Flash", /^google\/gemini-[\d.]+-flash(-preview)?$/],
  ["grok", "Grok", /^x-ai\/grok-[\d.]+$/],
  ["mistral", "Mistral Large", /^mistralai\/mistral-large(-[\d.]+)?$/],
  ["deepseek", "DeepSeek", /^deepseek\/deepseek-(chat|v[\d.]+)(-v[\d.]+)?$/],
];
// was „Automatisch“ nimmt: Aufgabe → Familien, die beste zuerst (je Abo)
const AUTO = {
  chat: { test: ["claude-haiku", "gpt-mini", "gemini-flash"], basis: ["claude-haiku", "gpt-mini", "gemini-flash"],
    plus: ["claude-sonnet", "gpt", "gemini-pro"], max: ["claude-sonnet", "gpt", "gemini-pro"] },
  code: { test: ["claude-sonnet", "gpt", "gemini-pro"], basis: ["claude-sonnet", "gpt", "gemini-pro"],
    plus: ["claude-sonnet", "gpt", "gemini-pro"], max: ["claude-fable", "claude-opus", "claude-sonnet", "gpt"] },
  vision: { test: ["claude-haiku", "gemini-flash", "gpt-mini"], basis: ["claude-haiku", "gemini-flash", "gpt-mini"],
    plus: ["claude-sonnet", "gpt", "gemini-pro"], max: ["claude-sonnet", "gpt", "gemini-pro"] },
};
let catalogue = [];                                          // [{ key, name, id, in, out, vision }]  (Preise: Dollar je Token)

/** Baut die Modellliste aus OpenRouters /models (server.js holt sie ohnehin alle 12 Stunden). */
function setModels(list) {
  const paid = (list || []).filter((m) => m && m.id && !String(m.id).endsWith(":free") && m.pricing && Number(m.pricing.completion) > 0);
  const entry = (key, name, m) => ({
    key, name: name || m.name || m.id, id: String(m.id), in: Number(m.pricing.prompt) || 0, out: Number(m.pricing.completion) || 0,
    vision: (((m.architecture || {}).input_modalities) || []).includes("image"),
  });
  const out = [];
  if (CFG.models.length) {
    for (const s of CFG.models) {
      const [name, id] = s.includes("=") ? s.split("=") : ["", s];
      const m = paid.find((x) => x.id === id.trim());
      if (m) out.push(entry(m.id, name.trim(), m));
    }
  } else {
    for (const [key, name, re] of FAMILIES) {
      const m = paid.filter((x) => re.test(String(x.id))).sort((a, b) => (b.created || 0) - (a.created || 0))[0];
      if (m) out.push(entry(key, `${name}${/\d/.test(m.id) ? " " + (String(m.id).match(/(\d+(?:\.\d+)?)/) || [""])[0] : ""}`.trim(), m));
    }
  }
  if (out.length) catalogue = out;
  return catalogue;
}
const models = () => catalogue.map((m) => ({ key: m.key, name: m.name, vision: m.vision,
  // (grob für die Anzeige: was 1000 Wörter Antwort kosten, in Cent)
  cost: Math.round(m.out * 1400 * 100 * 100) / 100 }));

/** Welches bezahlte Modell diese Anfrage bekommt: der Wunsch aus der App (key) oder „Automatisch“. null: keins da. */
function pick(plan, task, wish) {
  const usable = catalogue.filter((m) => task !== "vision" || m.vision);
  if (wish) { const m = usable.find((x) => x.key === wish); if (m) return m; }
  for (const key of (AUTO[task] || AUTO.chat)[plan] || []) { const m = usable.find((x) => x.key === key); if (m) return m; }
  return usable[0] || null;
}

/** Was eine Antwort gekostet hat: OpenRouters eigene Zahl, sonst Tokens × Preis, sonst geschätzt aus den Zeichen. */
function cost(model, usage, charsIn, charsOut) {
  if (usage && Number(usage.cost) > 0) return Number(usage.cost);
  if (usage && (usage.prompt_tokens || usage.completion_tokens)) return (usage.prompt_tokens || 0) * model.in + (usage.completion_tokens || 0) * model.out;
  return (charsIn / 3) * model.in + (charsOut / 3) * model.out;
}

// ---------------------------------------------------------------- Verwaltung (nur mit ADMIN_TOKEN)
const ADMIN_PAGE = `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jarvis Premium – Codes</title><style>body{font:16px system-ui;background:#0b1220;color:#e6edf7;max-width:520px;margin:32px auto;padding:0 16px}
input,select,button{font:inherit;padding:10px;border-radius:10px;border:1px solid #2b3a55;background:#111c30;color:inherit;width:100%;box-sizing:border-box;margin:6px 0 14px}
button{background:#2f8cff;border:0;font-weight:600}code{display:block;font-size:20px;padding:14px;background:#111c30;border-radius:10px;word-break:break-all;user-select:all}
small{color:#8fa3c2}</style><h2>Jarvis Premium – Code erstellen</h2>
<label>Verwaltungs-Passwort (ADMIN_TOKEN)<input id="t" type="password" autocomplete="off"></label>
<label>Abo<select id="p"><option value="test">Test (kostenlos für Freunde)</option><option value="basis">Basis</option><option value="plus">Plus</option><option value="max">Max</option></select></label>
<label>Laufzeit in Tagen<input id="d" type="number" value="30" min="1" max="400"></label>
<label>Budget in Dollar <small>(leer = Standard des Abos)</small><input id="b" type="number" step="0.5" min="0.1" max="200" placeholder="Standard"></label>
<button id="go">Code erstellen</button><div id="out"></div>
<script>document.getElementById("go").onclick=async()=>{const o=document.getElementById("out");o.textContent="…";
const r=await fetch("/v1/premium/admin/code",{method:"POST",headers:{"content-type":"application/json","x-admin-token":document.getElementById("t").value},
body:JSON.stringify({plan:document.getElementById("p").value,days:Number(document.getElementById("d").value),budget:document.getElementById("b").value})});
const j=await r.json().catch(()=>({error:"Fehler"}));o.innerHTML="";if(j.code){const c=document.createElement("code");c.textContent=j.code;o.append(c);
const s=document.createElement("small");s.textContent=j.plan+" · "+j.budget+" $ · gültig bis "+j.until;o.append(s)}else o.textContent=j.error||"Fehler"};</script></html>`;

module.exports = { CFG, on, make, parse, status, charge, spent, setModels, models, pick, cost, ADMIN_PAGE, used, PLAN_IDS };
