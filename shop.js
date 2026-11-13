// 1.5.0 – Sebastian, 14.11.: „die bezahlen mit PayPal 4 € und dann kriegen die per E-Mail einen Gutscheincode, den lösen die in
// der App ein – und nicht, dass die nur auf die PayPal-Seite gehen, zurückkommen und Premium haben, ohne Geld zu senden“.
//
// Sicher, weil das Geld nur hier auf dem Server eingezogen wird:
//   1. Die Seite /kaufen zeigt den PayPal-Knopf. Der Betrag steht NUR hier auf dem Server (SHOP_PRICE), nicht in der Seite.
//   2. Der Kunde bestätigt bei PayPal. Das allein bucht noch nichts ab.
//   3. Der Server zieht die Zahlung mit seinem geheimen PayPal-Schlüssel ein (capture) und liest die Antwort von PayPal selbst:
//      nur bei „COMPLETED“, richtigem Betrag und Euro gibt es einen Code. Was der Browser behauptet, zählt nie.
//   4. Der Code steht sofort auf der Seite und geht per E-Mail an die PayPal-Adresse des Kunden (wenn BREVO_API_KEY gesetzt ist).
//   Dieselbe Bestellung zweimal einziehen gibt denselben Code – nie zwei.
//
// Umgebungsvariablen: PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_MODE (sandbox|live, Standard sandbox),
//   SHOP_PRICE (4.00), SHOP_PLAN (basis), SHOP_BUDGET (Dollar fürs KI-Guthaben, 2.5), SHOP_DAYS (30),
//   BREVO_API_KEY, MAIL_FROM (bei Brevo bestätigte Absender-Adresse), SHOP_IMPRESSUM (Link zu deinem Impressum).
"use strict";
const crypto = require("crypto");
const premium = require("./premium.js");

const env = process.env;
const CFG = {
  id: env.PAYPAL_CLIENT_ID || "",
  secret: env.PAYPAL_SECRET || "",
  live: String(env.PAYPAL_MODE || "sandbox").toLowerCase() === "live",
  base: env.PAYPAL_BASE || "",
  price: Number(env.SHOP_PRICE || 4).toFixed(2),
  plan: env.SHOP_PLAN || "basis",
  budget: Number(env.SHOP_BUDGET || 2.5),
  days: Number(env.SHOP_DAYS || 30),
  brevo: env.BREVO_API_KEY || "",
  brevoBase: env.BREVO_BASE || "https://api.brevo.com",
  from: env.MAIL_FROM || "",
  impressum: env.SHOP_IMPRESSUM || "",
};
const api = () => (CFG.base || (CFG.live ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com")).replace(/\/+$/, "");
const on = () => Boolean(CFG.id && CFG.secret && premium.on());

let token = { value: "", until: 0 };
async function accessToken() {
  if (token.value && Date.now() < token.until) return token.value;
  const r = await fetch(`${api()}/v1/oauth2/token`, {
    method: "POST", signal: AbortSignal.timeout(15_000), body: "grant_type=client_credentials",
    headers: { authorization: "Basic " + Buffer.from(`${CFG.id}:${CFG.secret}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
  });
  if (!r.ok) throw new Error(`PayPal-Anmeldung ging nicht (HTTP ${r.status}) – PAYPAL_CLIENT_ID / PAYPAL_SECRET / PAYPAL_MODE prüfen`);
  const j = await r.json();
  token = { value: j.access_token, until: Date.now() + Math.max(60, Number(j.expires_in || 600) - 120) * 1000 };
  return token.value;
}

async function paypal(path, body, once = crypto.randomUUID()) {
  const r = await fetch(`${api()}${path}`, {
    method: "POST", signal: AbortSignal.timeout(30_000), body: JSON.stringify(body || {}),
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", prefer: "return=representation",
      "paypal-request-id": once },                           // (dieselbe Kennung doppelt geschickt = einmal gebucht)
  });
  let j = {};
  try { j = await r.json(); } catch (e) { }
  return { status: r.status, j };
}

/** Eine neue Bestellung – Betrag und Text nur von hier. → PayPal-Bestellnummer */
async function createOrder() {
  const { status, j } = await paypal("/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{ amount: { currency_code: "EUR", value: CFG.price }, description: `Jarvis Premium – ${CFG.days} Tage`.slice(0, 127) }],
    application_context: { brand_name: "Jarvis", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW", locale: "de-DE" },
  });
  if (status >= 300 || !j.id) throw new Error(`PayPal-Bestellung ging nicht (HTTP ${status})`);
  return j.id;
}

// ---------------------------------------------------------------- welche Bestellung welchen Code bekam
const issued = new Map();                                  // Bestellnummer → { code, email }
async function remembered(order) {
  if (issued.has(order)) return issued.get(order);
  const v = await premium.upstash?.("GET", `jarvis:order:${order}`);
  if (v) { try { const o = JSON.parse(v); issued.set(order, o); return o; } catch (e) { } }
  return null;
}
function remember(order, o) {
  issued.set(order, o);
  premium.upstash?.("SET", `jarvis:order:${order}`, JSON.stringify(o), "EX", String(420 * 86_400));
}

const ORDER_RX = /^[A-Z0-9]{8,40}$/;

/** Zieht die Zahlung ein. → { code, email, mailed } oder Error mit Satz für den Kunden (status). */
async function capture(order, log = () => {}) {
  if (!ORDER_RX.test(String(order || ""))) throw Object.assign(new Error("Unbekannte Bestellung."), { status: 400 });
  const old = await remembered(order);
  if (old) return { ...old, again: true };
  const { status, j } = await paypal(`/v2/checkout/orders/${order}/capture`, {}, `capture-${order}`);
  let data = j;
  if (status === 422 && JSON.stringify(j).includes("ORDER_ALREADY_CAPTURED")) {
    // (schon eingezogen, aber der Code ging verloren, z. B. nach einem Neustart ohne Upstash) → die Bestellung selbst ansehen
    const r = await fetch(`${api()}/v2/checkout/orders/${order}`, { signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${await accessToken()}` } });
    data = await r.json().catch(() => ({}));
  } else if (status >= 300) {
    const said = JSON.stringify(j);
    const why = ["INSTRUMENT_DECLINED", "PAYER_ACTION_REQUIRED", "ORDER_NOT_APPROVED"].find((x) => said.includes(x)) || "";
    log(`paypal: Einzug ging nicht (HTTP ${status} ${why})`);
    if (why === "INSTRUMENT_DECLINED") throw Object.assign(new Error("PayPal hat die Zahlung abgelehnt. Versuch es mit einer anderen Zahlungsart."), { status: 402, retry: true });
    if (why === "ORDER_NOT_APPROVED") throw Object.assign(new Error("Die Zahlung wurde bei PayPal noch nicht bestätigt."), { status: 402 });
    throw Object.assign(new Error("Die Zahlung konnte nicht abgeschlossen werden. Es wurde nichts abgebucht."), { status: 502 });
  }
  const unit = data.purchase_units?.[0] || {};
  const cap = (unit.payments?.captures || []).find((c) => c.status === "COMPLETED");
  const amount = cap?.amount || {};
  if (data.status !== "COMPLETED" || !cap) {
    const pending = (unit.payments?.captures || []).some((c) => c.status === "PENDING");
    log(`WICHTIG: paypal-Bestellung ${order} nicht abgeschlossen (${data.status}${pending ? ", Zahlung wird geprüft" : ""})`);
    throw Object.assign(new Error(pending
      ? "PayPal prüft die Zahlung noch. Sobald sie durch ist, bekommst du deinen Code – schreib uns mit deiner Bestellnummer, falls nicht."
      : "Die Zahlung ist nicht abgeschlossen. Es gibt deshalb noch keinen Code."), { status: 402 });
  }
  if (amount.currency_code !== "EUR" || Number(amount.value) + 1e-9 < Number(CFG.price)) {
    log(`WICHTIG: paypal-Bestellung ${order} mit falschem Betrag (${amount.value} ${amount.currency_code})`);
    throw Object.assign(new Error("Der bezahlte Betrag passt nicht."), { status: 402 });
  }
  const code = premium.make(CFG.plan, CFG.days, CFG.budget);
  const email = String(data.payer?.email_address || "").slice(0, 200);
  const o = { code, email, at: new Date().toISOString(), amount: amount.value };
  remember(order, o);
  const c = premium.parse(code);
  log(`verkauft: Premium (${CFG.plan}, ${CFG.days} Tage) für ${amount.value} € – Code …${c.id.slice(-4)}, Bestellung …${order.slice(-4)}`);
  const mailed = await mail(email, code, c.until, log);
  return { code, email, mailed, until: c.until };
}

async function mail(to, code, until, log) {
  if (!CFG.brevo || !CFG.from || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return false;
  const text = `Danke für deinen Kauf!\n\nDein Jarvis-Premium-Code:\n\n${code}\n\nSo löst du ihn ein: In der Jarvis-App auf „Mehr → Premium“ ` +
    `(am PC: Einstellungen → Premium) den Code eintragen.\nGültig bis ${until.split("-").reverse().join(".")}.\n\nViel Spaß!\nJarvis – Warpline Games`;
  const html = `<p>Danke für deinen Kauf!</p><p>Dein Jarvis-Premium-Code:</p><p style="font:600 22px monospace;letter-spacing:1px">${code}</p>` +
    `<p>So löst du ihn ein: In der Jarvis-App auf <b>Mehr → Premium</b> (am PC: <b>Einstellungen → Premium</b>) den Code eintragen.<br>` +
    `Gültig bis ${until.split("-").reverse().join(".")}.</p><p>Viel Spaß!<br>Jarvis – Warpline Games</p>`;
  try {
    const r = await fetch(`${CFG.brevoBase.replace(/\/+$/, "")}/v3/smtp/email`, {
      method: "POST", signal: AbortSignal.timeout(15_000),
      headers: { "api-key": CFG.brevo, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { name: "Jarvis", email: CFG.from }, to: [{ email: to }], subject: "Dein Jarvis-Premium-Code", textContent: text, htmlContent: html }),
    });
    if (!r.ok) { log(`WICHTIG: Code-Mail ging nicht raus (HTTP ${r.status}) – Absender bei Brevo bestätigt?`); return false; }
    return true;
  } catch (e) { log(`WICHTIG: Code-Mail ging nicht raus (${e.message})`); return false; }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Die Kaufseite. */
function page() {
  const price = CFG.price.replace(".", ",");
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jarvis Premium kaufen</title><style>
:root{color-scheme:dark}body{margin:0;background:#07101f;color:#dbe9ff;font:16px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
main{max-width:460px;margin:0 auto;padding:28px 16px}h1{font-size:26px;margin:0 0 4px;color:#46e0ff;letter-spacing:.5px}
.card{background:#0d1b33;border:1px solid #1f3a66;border-radius:16px;padding:18px;margin:16px 0}
.price{font-size:34px;font-weight:700;color:#fff}.muted{color:#8fa6c8;font-size:14px}ul{padding-left:20px;margin:8px 0}
label{display:flex;gap:10px;align-items:flex-start;font-size:14px;margin:12px 0}input{margin-top:4px;width:18px;height:18px}
#code{font:700 21px ui-monospace,Consolas,monospace;letter-spacing:1px;background:#06223a;border:1px dashed #46e0ff;border-radius:10px;padding:12px;word-break:break-all;user-select:all}
button{background:#46e0ff;color:#04111f;border:0;border-radius:10px;padding:10px 16px;font-weight:700;font-size:15px;cursor:pointer}
.err{color:#ff9b9b}.ok{color:#8ff0b0}#pay[aria-disabled=true]{opacity:.35;pointer-events:none}a{color:#46e0ff}
</style></head><body><main>
<h1>Jarvis Premium</h1><div class="muted">Warpline Games</div>
<div class="card"><div class="price">${esc(price)} €</div><div class="muted">einmalig für ${CFG.days} Tage – kein Abo, verlängert sich nicht</div>
<ul><li>Die besten KI-Modelle für Antworten (z. B. Claude, GPT)</li><li>Bilder erstellen mit dem besten Bild-Modell</li><li>Höhere Limits</li></ul>
<div class="muted">Den Code bekommst du sofort hier angezeigt und per E-Mail an deine PayPal-Adresse.</div></div>
${CFG.live ? "" : '<div class="card muted"><b>Testmodus (PayPal-Sandbox):</b> hier fließt kein echtes Geld. Zum Bezahlen ein Sandbox-Käuferkonto nehmen.</div>'}
<div id="buy"><label><input type="checkbox" id="agree"><span>Ich möchte den Code sofort bekommen und weiß, dass mein Widerrufsrecht damit erlischt, sobald der Code angezeigt wird.</span></label>
<div id="pay" aria-disabled="true"></div><p id="msg" class="muted"></p></div>
<div id="done" class="card" hidden><p class="ok"><b>Bezahlt – danke!</b></p><p>Dein Premium-Code:</p><div id="code"></div>
<p><button id="copy">Code kopieren</button></p><p class="muted" id="mailnote"></p>
<p class="muted">In der Jarvis-App: <b>Mehr → Premium</b> → Code eintragen. Am PC: <b>Einstellungen → Premium</b>.</p></div>
<p class="muted">${CFG.impressum ? `<a href="${esc(CFG.impressum)}" target="_blank" rel="noopener">Impressum</a>` : ""}</p>
</main>
<script src="https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(CFG.id)}&currency=EUR&intent=capture&locale=de_DE&components=buttons" data-namespace="paypal"></script>
<script>
const $=s=>document.querySelector(s),msg=(t,c)=>{$("#msg").textContent=t;$("#msg").className=c||"muted"};
$("#agree").onchange=e=>$("#pay").setAttribute("aria-disabled",e.target.checked?"false":"true");
async function post(p,b){const r=await fetch(p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b||{})});let j={};try{j=await r.json()}catch(e){}if(!r.ok)throw Object.assign(new Error(j.error||"Etwas ist schiefgegangen."),{retry:j.retry});return j}
if(!window.paypal){msg("PayPal konnte nicht geladen werden. Lade die Seite neu.","err")}else paypal.Buttons({
 style:{layout:"vertical",color:"gold",shape:"rect",label:"pay"},
 onClick:(d,a)=>$("#agree").checked?a.resolve():(msg("Bitte zuerst das Häkchen setzen.","err"),a.reject()),
 createOrder:async()=>(await post("/v1/shop/order")).id,
 onApprove:async(d,a)=>{msg("Zahlung wird abgeschlossen …");try{const j=await post("/v1/shop/capture",{order:d.orderID});
  $("#buy").hidden=true;$("#done").hidden=false;$("#code").textContent=j.code;
  $("#mailnote").textContent=j.mailed?("Wir haben ihn auch an "+j.email+" geschickt."):"Speichere dir den Code – er wird nur hier angezeigt.";
 }catch(e){if(e.retry)return a.restart();msg(e.message,"err")}},
 onCancel:()=>msg("Abgebrochen – es wurde nichts abgebucht."),
 onError:()=>msg("PayPal hatte ein Problem. Es wurde nichts abgebucht – versuch es nochmal.","err"),
}).render("#pay");
$("#copy").onclick=()=>{navigator.clipboard.writeText($("#code").textContent);$("#copy").textContent="Kopiert ✓"};
</script></body></html>`;
}

module.exports = { CFG, on, page, createOrder, capture, issued, ORDER_RX };
