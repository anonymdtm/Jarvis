// 1.7.0 – Sebastian, 18.11.: „einen Account wie bei Google … derselbe Account auf Handy und PC – auch wenn das Handy aus ist oder
// verloren geht, hast du weiter Premium“ und „1 und 2: mit Google anmelden und einen zufälligen Code per E-Mail“.
//
// Ein Konto ist eine E-Mail-Adresse. Anmelden geht auf zwei Wegen, beide landen im selben Konto:
//   E-Mail-Code: 6 zufällige Ziffern per Mail (Brevo), 10 Minuten gültig, höchstens 5 Versuche, höchstens 3 Mails pro Stunde.
//   Google:      im Browser (am Handy wie am PC). Die App zeigt eine 4-stellige Zahl, die Google-Seite danach dieselbe – nur wer
//                sie vergleicht und bestätigt, meldet das Gerät an. (So kann niemand mit einem fremden Link dein Konto abgreifen.)
// Danach hat das Gerät einen Sitzungs-Schlüssel (signiert, nicht zu fälschen). Am Konto hängt der Premium-Code: wer angemeldet ist,
// bekommt ihn auf jedem Gerät – Code einlösen und Kaufen schreiben ihn aufs Konto.
// Gespeichert (Upstash, sonst nur bis zum Neustart): jarvis:acct:<id> = { email, code, created, gen }.
// Umgebung: PREMIUM_SECRET (signiert auch die Sitzungen), UPSTASH_REDIS_REST_URL/_TOKEN, BREVO_API_KEY + MAIL_FROM (Mail-Code),
//           GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (Google; Weiterleitung: <Server>/v1/account/google/callback), PUBLIC_URL.
"use strict";
const crypto = require("crypto");
const premium = require("./premium.js");

const env = process.env;
const CFG = {
  google: env.GOOGLE_CLIENT_ID || "",
  googleSecret: env.GOOGLE_CLIENT_SECRET || "",
  googleAuth: env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
  googleToken: env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
  publicUrl: (env.PUBLIC_URL || "https://jarvis-warpline.onrender.com").replace(/\/+$/, ""),
  brevo: String(env.BREVO_API_KEY || "").trim(),          // (beim Einfügen rutschen gern Leerzeichen/Zeilenumbrüche mit)
  brevoBase: env.BREVO_BASE || "https://api.brevo.com",
  from: String(env.MAIL_FROM || "").trim(),
  maxDevices: Number(env.ACCOUNT_DEVICES || 10),
};
const secret = () => premium.CFG.secret || "";
const on = () => Boolean(secret());
const canMail = () => Boolean(on() && CFG.brevo && CFG.from);
const canGoogle = () => Boolean(on() && CFG.google && CFG.googleSecret);
const persistent = () => Boolean(premium.CFG.upstashUrl && premium.CFG.upstashToken);

const mac = (label, s) => crypto.createHmac("sha256", secret()).update(label + "\u0000" + s).digest();
const b64u = (b) => Buffer.from(b).toString("base64url");
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const EMAIL_RX = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,24}$/i;
function normEmail(e) { return String(e || "").trim().toLowerCase().slice(0, 254); }
const idOf = (email) => b64u(mac("acct", normEmail(email))).slice(0, 22);

// ---------------------------------------------------------------- Konten (Upstash, sonst im Speicher)
const mem = new Map();
async function load(id) {
  if (mem.has(id)) return mem.get(id);
  const v = await premium.upstash("GET", `jarvis:acct:${id}`);
  let a = null;
  if (v) { try { a = JSON.parse(v); } catch (e) { } }
  if (a) mem.set(id, a);
  return a;
}
async function save(id, a) {
  mem.set(id, a);
  await premium.upstash("SET", `jarvis:acct:${id}`, JSON.stringify(a));
}
async function ensure(email) {
  const id = idOf(email);
  let a = await load(id);
  if (!a) { a = { email: normEmail(email), code: "", created: new Date().toISOString(), gen: 1 }; await save(id, a); }
  return { id, a };
}

// ---------------------------------------------------------------- Sitzungen: "JA1.<id>.<gen>.<Ausgabe>.<Signatur>"
function issue(id, gen) {
  const body = `${id}.${gen}.${Math.floor(Date.now() / 1000).toString(36)}`;
  return `JA1.${body}.${b64u(mac("session", body)).slice(0, 32)}`;
}
/** Sitzungs-Schlüssel → { id, a } oder null */
async function session(token) {
  const m = /^JA1\.([A-Za-z0-9_-]{22})\.(\d{1,6})\.([a-z0-9]{1,10})\.([A-Za-z0-9_-]{32})$/.exec(String(token || ""));
  if (!m || !on()) return null;
  if (!eq(m[4], b64u(mac("session", `${m[1]}.${m[2]}.${m[3]}`)).slice(0, 32))) return null;
  const a = await load(m[1]);
  if (!a || String(a.gen) !== m[2]) return null;              // ("Überall abmelden" zählt gen hoch)
  return { id: m[1], a };
}

async function view(id, a, device = "") {
  const st = a.code && premium.on() ? await premium.status(a.code, `acct:${id}`) : null;
  return { email: a.email, code: a.code && st && st.ok ? a.code : "", premium: st && st.ok ? st : null, persistent: persistent() };
}

// ---------------------------------------------------------------- E-Mail-Code
const mailCodes = new Map();                                   // E-Mail → { hash, until, tries }
const mailSent = new Map();                                    // E-Mail → [Zeitpunkte]
async function mailStart(email, log = () => {}) {
  if (!canMail()) throw Object.assign(new Error("Anmelden per E-Mail ist auf dem Jarvis-Server noch nicht eingerichtet."), { status: 503 });
  const e = normEmail(email);
  if (!EMAIL_RX.test(e)) throw Object.assign(new Error("Das sieht nicht nach einer E-Mail-Adresse aus."), { status: 400 });
  const recent = (mailSent.get(e) || []).filter((t) => Date.now() - t < 3_600_000);
  if (recent.length >= 3) throw Object.assign(new Error("Schon 3 Codes in der letzten Stunde – nimm den aus der letzten Mail oder warte etwas."), { status: 429 });
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  mailCodes.set(e, { hash: mac("mailcode", `${e}:${code}`).toString("hex"), until: Date.now() + 10 * 60_000, tries: 0 });
  recent.push(Date.now()); mailSent.set(e, recent);
  const text = `Dein Jarvis-Anmeldecode: ${code}\n\nEr gilt 10 Minuten. Hast du das nicht selbst angefordert, ignoriere diese Mail einfach.\n\nJarvis – Warpline Games`;
  const html = `<p>Dein Jarvis-Anmeldecode:</p><p style="font:700 30px monospace;letter-spacing:6px">${code}</p>` +
    `<p>Er gilt 10 Minuten. Hast du das nicht selbst angefordert, ignoriere diese Mail einfach.</p><p>Jarvis – Warpline Games</p>`;
  const r = await fetch(`${CFG.brevoBase.replace(/\/+$/, "")}/v3/smtp/email`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { "api-key": CFG.brevo, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ sender: { name: "Jarvis", email: CFG.from }, to: [{ email: e }], subject: `${code} ist dein Jarvis-Code`, textContent: text, htmlContent: html }),
  }).catch(() => null);
  if (!r || !r.ok) {
    mailCodes.delete(e);
    let why = "";                                           // (Brevos eigene Begründung – nie der Schlüssel)
    try { const j = await r.json(); why = ` ${String(j.code || "")}: ${String(j.message || "").slice(0, 200)}`; } catch (x) { }
    const hint = r && r.status === 401 ? "BREVO_API_KEY prüfen (API-Schlüssel „xkeysib-…“, kein SMTP-Schlüssel)" : "Brevo-Absender bestätigt?";
    log(`WICHTIG: Anmelde-Mail ging nicht raus (${r ? "HTTP " + r.status : "keine Verbindung"}${why}) – ${hint}`);
    throw Object.assign(new Error("Die Mail konnte gerade nicht verschickt werden. Versuch es gleich nochmal."), { status: 502 });
  }
  return true;
}
async function mailVerify(email, code) {
  const e = normEmail(email);
  const c = mailCodes.get(e);
  if (!c || Date.now() > c.until) throw Object.assign(new Error("Der Code ist abgelaufen – lass dir einen neuen schicken."), { status: 400 });
  if (c.tries >= 5) { mailCodes.delete(e); throw Object.assign(new Error("Zu viele falsche Versuche – lass dir einen neuen Code schicken."), { status: 429 }); }
  c.tries++;
  if (!eq(c.hash, mac("mailcode", `${e}:${String(code || "").replace(/\D/g, "")}`).toString("hex"))) {
    throw Object.assign(new Error(`Der Code stimmt nicht (noch ${5 - c.tries} Versuche).`), { status: 403 });
  }
  mailCodes.delete(e);
  const { id, a } = await ensure(e);
  return { token: issue(id, a.gen), ...(await view(id, a)) };
}

// ---------------------------------------------------------------- Google (im Browser, mit Vergleichszahl)
const polls = new Map();          // öffentliche Kennung → { secret, code, device, until, state: "new"|"google"|"done", email, token }
function googleBegin(device) {
  if (!canGoogle()) throw Object.assign(new Error("Anmelden mit Google ist auf dem Jarvis-Server noch nicht eingerichtet."), { status: 503 });
  for (const [k, p] of polls) if (Date.now() > p.until) polls.delete(k);
  if (polls.size > 2000) throw Object.assign(new Error("Gerade zu viele Anmeldungen – gleich nochmal."), { status: 429 });
  const pub = b64u(crypto.randomBytes(18)), sec = b64u(crypto.randomBytes(24));
  const code = String(crypto.randomInt(1000, 10000));
  polls.set(pub, { secret: sec, code, device: String(device || "ein Gerät").replace(/[<>&"'\u0000-\u001f]/g, "").slice(0, 40), until: Date.now() + 10 * 60_000, state: "new" });
  return { poll: `${pub}.${sec}`, code, url: `${CFG.publicUrl}/v1/account/google/start?p=${pub}` };
}
function googleRedirect(pub) {
  const p = polls.get(String(pub || ""));
  if (!p || Date.now() > p.until) return null;
  const nonce = b64u(crypto.randomBytes(12));
  p.nonce = nonce;
  const state = `${pub}.${nonce}.${b64u(mac("gstate", `${pub}.${nonce}`)).slice(0, 22)}`;
  const q = new URLSearchParams({ client_id: CFG.google, redirect_uri: `${CFG.publicUrl}/v1/account/google/callback`, response_type: "code",
    scope: "openid email", state, prompt: "select_account", access_type: "online" });
  return `${CFG.googleAuth}?${q}`;
}
/** Google kam zurück: Code eintauschen, E-Mail lesen. → die Bestätigungsseite (HTML) */
async function googleCallback(code, state, log = () => {}) {
  const m = /^([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})$/.exec(String(state || ""));
  const p = m && polls.get(m[1]);
  if (!m || !p || Date.now() > p.until || p.nonce !== m[2] || !eq(m[3], b64u(mac("gstate", `${m[1]}.${m[2]}`)).slice(0, 22))) {
    return page("Abgelaufen", "<p>Diese Anmeldung ist abgelaufen. Starte sie in der Jarvis-App noch einmal.</p>");
  }
  p.nonce = "";                                                 // (nur einmal)
  const r = await fetch(CFG.googleToken, { method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: String(code || ""), client_id: CFG.google, client_secret: CFG.googleSecret,
      redirect_uri: `${CFG.publicUrl}/v1/account/google/callback`, grant_type: "authorization_code" }) }).catch(() => null);
  let claims = null;
  try {
    const j = await r.json();
    // (direkt von Google über TLS mit unserem Geheimnis geholt – der Inhalt des id_token ist damit echt)
    claims = JSON.parse(Buffer.from(String(j.id_token).split(".")[1], "base64url").toString());
  } catch (e) { }
  if (!r || !r.ok || !claims || claims.aud !== CFG.google || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss)
    || claims.email_verified !== true || !EMAIL_RX.test(normEmail(claims.email)) || Number(claims.exp) * 1000 < Date.now()) {
    log(`google-anmeldung: abgelehnt (${r ? r.status : "keine Verbindung"})`);
    return page("Hat nicht geklappt", "<p>Google hat die Anmeldung nicht bestätigt. Starte sie in der Jarvis-App noch einmal.</p>");
  }
  p.state = "google"; p.email = normEmail(claims.email);
  p.confirm = b64u(crypto.randomBytes(18));
  return page("Gerät anmelden", `<p>Angemeldet bei Google als <b>${esc(p.email)}</b>.</p>
<p>Melde <b>${esc(p.device)}</b> bei Jarvis an?</p>
<p>Steht in deiner Jarvis-App gerade diese Zahl?</p><div class="code">${p.code}</div>
<p class="muted">Nur bestätigen, wenn du die Anmeldung gerade selbst in der App gestartet hast und die Zahl gleich ist.</p>
<form method="post" action="/v1/account/google/confirm"><input type="hidden" name="p" value="${m[1]}"><input type="hidden" name="c" value="${p.confirm}">
<button>Ja, die Zahl stimmt – anmelden</button></form>`);
}
async function googleConfirm(pub, confirm) {
  const p = polls.get(String(pub || ""));
  if (!p || Date.now() > p.until || p.state !== "google" || !p.confirm || !eq(p.confirm, String(confirm || ""))) {
    return page("Abgelaufen", "<p>Diese Anmeldung ist abgelaufen. Starte sie in der Jarvis-App noch einmal.</p>");
  }
  const { id, a } = await ensure(p.email);
  p.state = "done"; p.token = issue(id, a.gen); p.confirm = "";
  return page("Angemeldet", `<p class="ok"><b>Fertig – ${esc(p.device)} ist angemeldet.</b></p><p>Du kannst dieses Fenster schließen und zur Jarvis-App zurückgehen.</p>`);
}
/** Die App fragt nach: noch nicht / fertig (einmal). */
async function googlePoll(poll) {
  const [pub, sec] = String(poll || "").split(".");
  const p = polls.get(pub || "");
  if (!p || !sec || !eq(p.secret, sec)) return { state: "gone" };
  if (Date.now() > p.until) { polls.delete(pub); return { state: "gone" }; }
  if (p.state !== "done") return { state: "wait" };
  polls.delete(pub);
  const s = await session(p.token);
  return { state: "done", token: p.token, ...(await view(s.id, s.a)) };
}

// ---------------------------------------------------------------- Premium am Konto
/** Einen Code aufs Konto schreiben (beim Einlösen oder Kaufen). */
async function attach(id, code, device = "") {
  const a = await load(id);
  if (!a) throw Object.assign(new Error("Konto nicht gefunden."), { status: 404 });
  // (ein Gerät, das den Code schon hat, darf ihn aufs Konto legen – auch wenn der Code schon auf 3 Geräten war)
  const mine = device ? await premium.status(code, device) : { ok: false };
  const c = premium.parse(code);
  if (mine.ok && c) await premium.claim(c.id, `acct:${id}`, true);
  const st = await premium.status(code, `acct:${id}`);
  if (!st.ok) throw Object.assign(new Error(st.error || "Diesen Code kenne ich nicht."), { status: 400 });
  a.code = premium.parse(code) ? code.trim().toUpperCase() : a.code;
  await save(id, a);
  return view(id, a);
}
async function logoutEverywhere(id) {
  const a = await load(id);
  if (a) { a.gen = Number(a.gen || 1) + 1; await save(id, a); }
}

// ---------------------------------------------------------------- Kauf-Ticket (die Kaufseite weiß, auf welches Konto)
function buyTicket(id) {
  const body = `${id}.${(Math.floor(Date.now() / 1000) + 3600).toString(36)}`;
  return `${body}.${b64u(mac("buy", body)).slice(0, 22)}`;
}
function ticketAccount(t) {
  const m = /^([A-Za-z0-9_-]{22})\.([a-z0-9]{1,10})\.([A-Za-z0-9_-]{22})$/.exec(String(t || ""));
  if (!m || !on() || !eq(m[3], b64u(mac("buy", `${m[1]}.${m[2]}`)).slice(0, 22))) return "";
  return parseInt(m[2], 36) * 1000 > Date.now() ? m[1] : "";
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function page(title, body) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jarvis – ${esc(title)}</title>
<style>:root{color-scheme:dark}body{margin:0;background:#07101f;color:#dbe9ff;font:17px/1.5 system-ui,Segoe UI,Roboto,sans-serif}main{max-width:440px;margin:0 auto;padding:32px 16px}
h1{color:#46e0ff;font-size:24px}.code{font:700 44px ui-monospace,Consolas,monospace;letter-spacing:10px;text-align:center;background:#0d1b33;border:1px solid #1f3a66;border-radius:14px;padding:14px;margin:10px 0}
button{width:100%;background:#46e0ff;color:#04111f;border:0;border-radius:12px;padding:14px;font-weight:700;font-size:17px;cursor:pointer}.muted{color:#8fa6c8;font-size:14px}.ok{color:#8ff0b0}</style>
</head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

module.exports = { CFG, on, canMail, canGoogle, persistent, normEmail, idOf, load, save, ensure, issue, session, view, mailStart, mailVerify,
  googleBegin, googleRedirect, googleCallback, googleConfirm, googlePoll, attach, logoutEverywhere, buyTicket, ticketAccount, polls, mailCodes, page };
