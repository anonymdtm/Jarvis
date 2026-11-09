// 1.3.0 – Sebastian (9.11.): „dass man bei mir 12 Euro zahlt und dann die ganzen Modelle benutzen kann“, „erstmal kostenlos testen“.
// Ein Premium-Code hat ein Budget; bezahlte Modelle antworten, bis es leer ist – dann wieder die kostenlosen.
const http = require("http");
const assert = require("assert");
const calls = [];
let broke = false;
const MODELS = [
  { id: "a/free-talk:free", pricing: { prompt: "0", completion: "0" } },
  { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", created: 30, pricing: { prompt: "0.0000001", completion: "0.0000005" }, architecture: { input_modalities: ["text", "image"] } },
  { id: "anthropic/claude-haiku-4.5", name: "alt", created: 10, pricing: { prompt: "0.000001", completion: "0.000005" } },
  { id: "anthropic/claude-sonnet-5.5", created: 30, pricing: { prompt: "0.000002", completion: "0.00001" }, architecture: { input_modalities: ["text", "image"] } },
  { id: "anthropic/claude-fable-5.2", created: 40, pricing: { prompt: "0.00001", completion: "0.00005" } },
  { id: "openai/gpt-6", created: 40, pricing: { prompt: "0.000003", completion: "0.000012" } },
  { id: "openai/gpt-6-mini", created: 40, pricing: { prompt: "0.0000003", completion: "0.0000012" } },
  { id: "openai/gpt-image-2", created: 50, pricing: { prompt: "0.000003", completion: "0.000012" }, architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] } },
  { id: "google/gemini-4-flash-image", name: "Nano Banana", created: 45, pricing: { prompt: "0.0000003", completion: "0.000002" }, architecture: { input_modalities: ["text", "image"], output_modalities: ["image", "text"] } },
];
const upstream = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    if (req.url.startsWith("/or/models")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: MODELS })); }
    const j = JSON.parse(b);
    calls.push({ model: j.model, usage: j.usage, parts: Array.isArray(j.messages[0].content) ? j.messages[0].content.length : 0 });
    if (j.modalities) {
      res.writeHead(200, { "content-type": "application/json" });
      if (JSON.stringify(j.messages).includes("verboten")) return res.end(JSON.stringify({ choices: [{ message: { content: "Das kann ich nicht malen." } }] }));
      return res.end(JSON.stringify({ choices: [{ message: { content: "Bitte sehr.", images: [{ image_url: { url: "data:image/png;base64,QUJDREVGR0g=" } }] } }], usage: { cost: 0.05 } }));
    }
    if (broke && !j.model.endsWith(":free")) { res.writeHead(402); return res.end('{"error":{"message":"Insufficient credits"}}'); }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: j.model + " sagt Hallo" } }] })}\n\n`);
    if (j.usage) res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.4 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
}).listen(0, "127.0.0.1", () => {
  const p = upstream.address().port;
  Object.assign(process.env, {
    OPENROUTER_API_KEY: "o-geheim", APP_TOKEN: "geheim-token-123", OPENROUTER_BASE: `http://127.0.0.1:${p}/or`, PORT: "0", KEEP_AWAKE: "0",
    LIMIT_PER_MINUTE: "100", LIMIT_IP_PER_MINUTE: "100", LIMIT_PER_DAY: "3", LIMIT_IP_PER_DAY: "100", LIMIT_ALL_PER_DAY: "100",
    MODELS_CHAT: "or:a/free-talk:free", MODELS_CODE: "or:a/free-talk:free", MODELS_VISION: "or:a/free-talk:free",
    PREMIUM_SECRET: "ein-langes-geheimnis-fuer-die-codes", ADMIN_TOKEN: "verwaltung-geheim-1234",
  });
  const { server, premium } = require("./server.js");
  server.listen(0, "127.0.0.1", async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ok = (m) => console.log("  ok   " + m);
    const H = { "content-type": "application/json", "x-jarvis-token": "geheim-token-123", "x-device": "geraet-premium-1" };
    const ask = async (code, extra = {}, device = "geraet-premium-1") => {
      const r = await fetch(base + "/v1/chat", { method: "POST", headers: { ...H, "x-device": device, ...(code ? { "x-jarvis-premium": code } : {}) },
        body: JSON.stringify({ messages: [{ role: "user", content: "Hallo" }], stream: true, ...extra }) });
      const text = await r.text();
      const got = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
      const done = got.find((x) => x.done) || {};
      return { status: r.status, text: got.map((x) => x.delta || "").join(""), model: done.model, premium: done.premium, raw: text };
    };
    try {
      // --- Codes: unterschrieben, abtippbar, nicht zu fälschen
      const code = premium.make("test");
      assert.match(code, /^JV(-[A-HJ-NP-Z2-9]{1,5}){6}$/);
      const c = premium.parse(code.toLowerCase().replace(/-/g, " "));
      assert.strictEqual(c.plan, "test"); assert.strictEqual(c.budget, 1); assert.strictEqual(c.expired, false);
      const forged = code.slice(0, -1) + (code.endsWith("A") ? "B" : "A");
      assert.strictEqual(premium.parse(forged), null);
      assert.strictEqual(premium.parse("JV-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-A"), null);
      ok("Codes sind unterschrieben – ein geänderter oder erfundener Code gilt nicht");

      // --- Verwaltung: nur mit dem Passwort
      let r = await fetch(base + "/v1/premium/admin/code", { method: "POST", headers: { "content-type": "application/json", "x-admin-token": "falsch" }, body: '{"plan":"plus"}' });
      assert.strictEqual(r.status, 401);
      r = await fetch(base + "/v1/premium/admin/code", { method: "POST", headers: { "content-type": "application/json", "x-admin-token": "verwaltung-geheim-1234" }, body: '{"plan":"plus","days":30}' });
      const made = await r.json();
      assert.strictEqual(r.status, 200); assert.strictEqual(made.plan, "plus"); assert.strictEqual(made.budget, 7);
      assert.strictEqual((await fetch(base + "/admin")).status, 200);
      ok("Codes erstellt nur, wer das Verwaltungs-Passwort hat");

      // --- Status: Abo, Rest und die Modelle (je Familie das neueste – kein Bild-Modell, kein altes)
      r = await fetch(base + "/v1/premium/status", { headers: { ...H, "x-jarvis-premium": made.code } });
      let st = await r.json();
      assert.strictEqual(st.ok, true); assert.strictEqual(st.percent, 100); assert.strictEqual(st.id, undefined);
      assert.deepStrictEqual(st.models.map((m) => m.key), ["claude-fable", "claude-sonnet", "claude-haiku", "gpt", "gpt-mini"]);
      assert.strictEqual(st.models[2].name, "Claude Haiku 5.5");
      st = await (await fetch(base + "/v1/premium/status", { headers: { ...H, "x-jarvis-premium": forged } })).json();
      assert.strictEqual(st.ok, false);
      ok("Status zeigt Abo, Rest und die Modelle");

      // --- mit Code antwortet das bezahlte Modell, die Kosten gehen vom Budget ab
      let a = await ask(code);
      assert.strictEqual(a.status, 200);
      assert.strictEqual(a.text, "anthropic/claude-haiku-5.5 sagt Hallo");
      assert.strictEqual(a.model, "premium:Claude Haiku 5.5");
      assert.deepStrictEqual(calls[calls.length - 1].usage, { include: true });
      assert.strictEqual(a.premium.active, true); assert.strictEqual(a.premium.percent, 60);      // 1 $ − 0,40 $
      ok("Mit Code antwortet ein bezahltes Modell, das Budget sinkt um die echten Kosten");

      // --- das Modell aus „Alle Modelle“
      a = await ask(code, { model: "gpt" });
      assert.strictEqual(a.model, "premium:ChatGPT 6"); assert.strictEqual(a.premium.percent, 20);
      ok("Das gewählte Modell antwortet");

      // --- Budget leer → wieder kostenlos, die App erfährt es
      a = await ask(code);                                         // 0,20 $ übrig → noch einmal bezahlt (danach 0)
      assert.strictEqual(a.premium.active, false);
      a = await ask(code);
      assert.strictEqual(a.model, "or:a/free-talk:free");
      assert.deepStrictEqual(a.premium, { active: false, reason: "leer" });
      ok("Ist das Budget leer, antworten wieder die kostenlosen Modelle");

      // --- das Gratis-Tageslimit (hier 3) gilt für Premium nicht – ohne Code schon
      const plus = made.code;
      for (let i = 0; i < 5; i++) assert.strictEqual((await ask(plus, {}, "geraet-premium-2")).status, 200);
      for (let i = 0; i < 3; i++) assert.strictEqual((await ask(null, {}, "geraet-gratis-3")).status, 200);
      assert.strictEqual((await ask(null, {}, "geraet-gratis-3")).status, 429);
      ok("Premium hat kein Tageslimit von 15 Fragen");

      // --- OpenRouter-Guthaben leer → die Antwort kommt trotzdem (kostenlos), nichts wird abgezogen
      const fresh = premium.make("max");
      broke = true;
      a = await ask(fresh, { task: "code" });
      assert.strictEqual(a.text, "a/free-talk:free sagt Hallo");
      assert.strictEqual(a.premium.fallback, true); assert.strictEqual(a.premium.percent, 100);
      assert.strictEqual(calls[calls.length - 2].model, "anthropic/claude-fable-5.2");            // (Max: Programmieren mit Fable)
      broke = false;
      ok("Geht das bezahlte Modell nicht, antwortet ein kostenloses – ohne Abzug");

      // --- abgelaufen
      const realNow = Date.now;
      Date.now = () => realNow() + 40 * 86_400_000;
      assert.strictEqual(premium.parse(fresh).expired, true);
      Date.now = realNow;
      ok("Ein Code läuft nach seiner Laufzeit ab");
      // --- Bilder erstellen und ändern: nur mit Premium, kostet vom Budget
      const paint = async (c, body) => {
        const rr = await fetch(base + "/v1/premium/image", { method: "POST", headers: { ...H, "x-device": "geraet-bild-1", ...(c ? { "x-jarvis-premium": c } : {}) }, body: JSON.stringify(body) });
        return { status: rr.status, j: await rr.json() };
      };
      assert.strictEqual((await paint(null, { prompt: "eine Katze im Weltall" })).status, 402);
      const pic = { mime: "image/jpeg", data: Buffer.alloc(300, 7).toString("base64") };
      const gold = premium.make("test", 30, 3);
      let pr = await paint(gold, { prompt: "tausche die Person aus Bild 1 mit der aus Bild 2", images: [pic, pic] });
      assert.strictEqual(pr.status, 200);
      assert.deepStrictEqual(pr.j.image, { mime: "image/png", data: "QUJDREVGR0g=" });
      assert.strictEqual(calls[calls.length - 1].model, "google/gemini-4-flash-image"); assert.strictEqual(calls[calls.length - 1].parts, 3);
      assert.strictEqual(pr.j.premium.percent, 98);                                               // 3 $ − 0,05 $
      pr = await paint(gold, { prompt: "etwas verboten es" });
      assert.strictEqual(pr.status, 422); assert.strictEqual(pr.j.error, "Das kann ich nicht malen.");
      assert.strictEqual((await premium.status(gold)).percent, 98);                               // (kein Bild – kein Abzug)
      assert.strictEqual((await paint(gold, { prompt: "x", images: [pic, pic, pic, pic] })).status, 400);
      ok("Bilder erstellen und ändern geht mit Premium und zählt aufs Budget");
      console.log("ALL OK (10)");
      process.exit(0);
    } catch (e) { console.error(e); process.exit(1); }
  });
});
