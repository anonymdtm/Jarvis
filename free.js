// 1.4.0 – Sebastian, 13./14.11.: „dass er auch Bilder generieren kann … relativ gut, so wie von ChatGPT – auf Handy und PC“
// und „dass die KI besser zuhört … der versteht viele Sachen falsch“.
// Beides kostenlos über Cloudflare Workers AI (10.000 „Neuronen“ am Tag frei, ein eigenes Konto reicht):
//   Bilder:  FLUX.2 [dev] von Black Forest Labs – sehr gute Bilder, kann auch bis zu 4 Bilder als Vorlage nehmen
//            („ändere die Person …“). Ein 1024×1024-Bild ≈ 150 Neuronen → gut 60 Bilder am Tag für alle zusammen.
//   Hören:   Whisper large-v3-turbo – viel genauer als die kleine Erkennung auf dem PC. ≈ 47 Neuronen pro Minute Ton,
//            ein Befehl (3–5 s) also ≈ 3–4 Neuronen.
// Umgebungsvariablen: CF_ACCOUNT_ID, CF_API_TOKEN (ein API-Token mit „Workers AI – Read“ … „Edit“ reicht).
// Fehlen sie, antworten /v1/image und /v1/stt mit 503 – die App hört dann wie bisher selbst zu.
"use strict";

const env = process.env;
const CFG = {
  account: env.CF_ACCOUNT_ID || "",
  token: env.CF_API_TOKEN || "",
  base: env.CF_BASE || "https://api.cloudflare.com/client/v4/accounts",
  imageModel: env.CF_IMAGE_MODEL || "@cf/black-forest-labs/flux-2-dev",
  sttModel: env.CF_STT_MODEL || "@cf/openai/whisper-large-v3-turbo",
  perDay: Number(env.CF_NEURONS_PER_DAY || 9500),         // (die freien 10.000 – mit etwas Luft, gezählt wird hier geschätzt)
  sttReserve: Number(env.CF_STT_RESERVE || 1500),         // (so viel bleibt fürs Zuhören, auch wenn viele Bilder gemacht werden)
};
const on = () => Boolean(CFG.account && CFG.token);

// ---------------------------------------------------------------- was heute verbraucht ist (geschätzt, wie Cloudflare rechnet)
const used = { key: "", n: 0 };
const today = () => new Date().toISOString().slice(0, 10);    // (Cloudflare fängt um 0 Uhr UTC neu an – genau wie hier)
function spent() { if (used.key !== today()) { used.key = today(); used.n = 0; } return used.n; }
function spend(n) { spent(); used.n += n; }
const tiles = (w, h) => Math.ceil(w / 512) * Math.ceil(h / 512);
/** Neuronen für ein Bild: FLUX.2 [dev] 37,5 je 512er-Kachel im Ergebnis, 18,75 je Kachel einer Vorlage (≤ 512 → 1 Kachel). */
const imageCost = (w, h, inputs) => tiles(w, h) * 37.5 + inputs * 18.75;
const sttCost = (seconds) => Math.max(1, (seconds / 60) * 46.63);

/** Darf noch ein Bild gemacht werden? "" = ja, sonst der Satz für den Nutzer. */
function imageAllowed(w, h, inputs) {
  if (!on()) return "Bilder erstellen ist auf dem Jarvis-Server noch nicht eingerichtet.";
  if (spent() + imageCost(w, h, inputs) > CFG.perDay - CFG.sttReserve) return "Für heute sind die kostenlosen Bilder aufgebraucht – morgen geht es wieder.";
  return "";
}
function sttAllowed(seconds) {
  if (!on()) return "nicht eingerichtet";
  if (spent() + sttCost(seconds) > CFG.perDay) return "für heute aufgebraucht";
  return "";
}

const url = (model) => `${CFG.base.replace(/\/+$/, "")}/${CFG.account}/ai/run/${model}`;

/** Größe aus dem Wunsch: „Hochformat“/„Handy-Hintergrund“ → 768×1344, „Querformat“/„Banner“ → 1344×768, sonst 1024×1024. */
function size(shape) {
  if (shape === "portrait") return [768, 1344];
  if (shape === "landscape") return [1344, 768];
  return [1024, 1024];
}
function shapeOf(text) {
  const t = String(text || "").toLowerCase();
  if (/hochformat|hochkant|handy.?hintergrund|sperrbildschirm|wallpaper fürs handy|story|poster/.test(t)) return "portrait";
  if (/querformat|breitbild|banner|desktop.?hintergrund|pc.?hintergrund|youtube.?(?:thumbnail|vorschau)|header|16[:\/ ]9/.test(t)) return "landscape";
  return "square";
}

/** Ein Bild malen. images: [{mime,data}] (je ≤ 512×512, die App verkleinert). → { mime, data } (Base64) */
async function paint(prompt, images, shape, log = () => {}) {
  const [w, h] = size(shape);
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", String(w));
  form.append("height", String(h));
  images.slice(0, 4).forEach((im, i) => form.append(`input_image_${i}`, new Blob([Buffer.from(im.data, "base64")], { type: im.mime }), `bild${i}.${im.mime.split("/")[1]}`));
  const t0 = Date.now();
  const r = await fetch(url(CFG.imageModel), { method: "POST", body: form, signal: AbortSignal.timeout(120_000),
    headers: { authorization: `Bearer ${CFG.token}` } });
  spend(imageCost(w, h, images.length));
  const type = String(r.headers.get("content-type") || "");
  if (!r.ok) {
    let why = "";
    try { why = JSON.stringify((await r.json()).errors || "").slice(0, 300); } catch (e) { }
    log(`WICHTIG: Cloudflare-Bild geht nicht (HTTP ${r.status}) ${why}`);
    if (r.status === 429) { used.n = CFG.perDay; throw Object.assign(new Error("Für heute sind die kostenlosen Bilder aufgebraucht – morgen geht es wieder."), { status: 429 }); }
    // (abgelehnt, z. B. vom Inhaltsfilter)
    if (r.status === 400 && /nsfw|safety|flag|content/i.test(why)) throw Object.assign(new Error("Dazu kann ich kein Bild erstellen. Beschreib es bitte anders."), { status: 422 });
    throw Object.assign(new Error("Das Bild konnte gerade nicht erstellt werden. Versuch es später nochmal."), { status: 503 });
  }
  let out;
  if (type.startsWith("image/")) out = { mime: type.split(";")[0], data: Buffer.from(await r.arrayBuffer()).toString("base64") };
  else {
    const j = await r.json();
    const data = String(j?.result?.image || j?.image || "");
    if (!data) throw Object.assign(new Error("Das Bild konnte gerade nicht erstellt werden."), { status: 503 });
    out = { mime: data.startsWith("/9j/") ? "image/jpeg" : data.startsWith("iVBOR") ? "image/png" : "image/jpeg", data };
  }
  log(`bild (kostenlos): ${w}x${h}, ${images.length} Vorlage(n), ${Date.now() - t0} ms – heute ≈ ${Math.round(spent())} Neuronen`);
  return out;
}

/** Seconds of sound in a WAV (16-bit) – for the daily count. */
function wavSeconds(buf) {
  try {
    if (buf.slice(0, 4).toString() !== "RIFF" || buf.slice(8, 12).toString() !== "WAVE") return buf.length / 32000;
    const rate = buf.readUInt32LE(24), channels = buf.readUInt16LE(22), bits = buf.readUInt16LE(34);
    return Math.max(0, buf.length - 44) / (rate * channels * (bits / 8));
  } catch (e) { return buf.length / 32000; }
}

/** Was gesagt wurde. audio: WAV als Base64. hint: Wörter, die vorkommen können (Namen, Apps) – hilft Whisper sehr. */
async function hear(audio, hint, log = () => {}) {
  const t0 = Date.now();
  const secs = wavSeconds(Buffer.from(audio, "base64"));
  const body = { audio, language: "de", task: "transcribe", condition_on_previous_text: false, beam_size: 5 };
  if (hint) body.initial_prompt = hint;
  const r = await fetch(url(CFG.sttModel), { method: "POST", signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${CFG.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  spend(sttCost(secs));
  if (!r.ok) {
    log(`Cloudflare-Hören geht nicht (HTTP ${r.status})`);
    if (r.status === 429) used.n = CFG.perDay;
    throw Object.assign(new Error("Spracherkennung gerade nicht erreichbar."), { status: 503 });
  }
  const j = await r.json();
  const text = String(j?.result?.text ?? j?.text ?? "").trim();
  log(`hören: ${secs.toFixed(1)} s Ton → ${Date.now() - t0} ms`);
  return text;
}

module.exports = { CFG, on, paint, hear, imageAllowed, sttAllowed, shapeOf, size, wavSeconds, imageCost, sttCost, spent, used };
