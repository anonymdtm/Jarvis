// 1.4.0 – kostenlose Bilder (FLUX.2) und genaues Zuhören (Whisper) über Cloudflare – gegen einen nachgebauten Cloudflare.
const http = require("http");
const assert = require("assert");
const seen = [];
let mode = "ok";
const upstream = http.createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    const b = Buffer.concat(parts);
    if (req.url.startsWith("/or/models")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "a/free-talk:free", pricing: { prompt: "0", completion: "0" } }] })); }
    if (req.url.startsWith("/or/")) {                       // (der Prompt fürs Bild, ins Englische)
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "A small orange cat floating in outer space, cinematic light, detailed digital art" } }] })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    seen.push({ url: req.url, auth: req.headers.authorization, type: String(req.headers["content-type"] || ""), body: b });
    if (mode === "busy") { res.writeHead(429, { "content-type": "application/json" }); return res.end('{"errors":[{"message":"daily free allocation"}]}'); }
    if (req.url.endsWith("flux-2-dev")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ result: { image: "/9j/" + "A".repeat(200) }, success: true }));
    }
    if (req.url.endsWith("whisper-large-v3-turbo")) {
      const j = JSON.parse(b.toString());
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ result: { text: " Ruf auf Discord meine Freundin an. ", lang: j.language, hint: j.initial_prompt } }));
    }
    res.writeHead(404); res.end();
  });
}).listen(0, "127.0.0.1", () => {
  const p = upstream.address().port;
  Object.assign(process.env, {
    OPENROUTER_API_KEY: "o-geheim", APP_TOKEN: "geheim-token-123", OPENROUTER_BASE: `http://127.0.0.1:${p}/or`, PORT: "0", KEEP_AWAKE: "0",
    MODELS_CHAT: "or:a/free-talk:free", MODELS_CODE: "or:a/free-talk:free", MODELS_VISION: "or:a/free-talk:free",
    CF_ACCOUNT_ID: "konto123", CF_API_TOKEN: "cf-geheim", CF_BASE: `http://127.0.0.1:${p}/cf`, FREE_IMAGE_PER_DAY: "3", FREE_IMAGE_PER_MINUTE: "50",
  });
  const { server, cloud } = require("./server.js");
  server.listen(0, "127.0.0.1", async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ok = (m) => console.log("  ok   " + m);
    const H = { "content-type": "application/json", "x-jarvis-token": "geheim-token-123", "x-device": "geraet-frei-1" };
    const post = async (path, body, h = {}) => { const r = await fetch(base + path, { method: "POST", headers: { ...H, ...h }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json() }; };
    // 2 Sekunden Stille als WAV (16 kHz, mono, 16 bit)
    const pcm = Buffer.alloc(16000 * 2 * 2);
    const head = Buffer.alloc(44);
    head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.length, 4); head.write("WAVE", 8); head.write("fmt ", 12); head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(pcm.length, 40);
    const wav = Buffer.concat([head, pcm]).toString("base64");
    try {
      // --- ohne Token: nichts
      let r = await post("/v1/image", { prompt: "eine Katze" }, { "x-jarvis-token": "falsch" });
      assert.strictEqual(r.status, 401);
      ok("ohne App-Token gibt es keine Bilder");

      // --- ein Bild: Wunsch → englischer Prompt → FLUX.2, quadratisch
      r = await post("/v1/image", { prompt: "Mal mir eine Katze im Weltall" });
      assert.strictEqual(r.status, 200, JSON.stringify(r.j));
      assert.strictEqual(r.j.image.mime, "image/jpeg");
      assert.ok(r.j.image.data.startsWith("/9j/"));
      let last = seen[seen.length - 1];
      assert.ok(last.url === "/cf/konto123/ai/run/@cf/black-forest-labs/flux-2-dev", last.url);
      assert.strictEqual(last.auth, "Bearer cf-geheim");
      assert.ok(last.type.startsWith("multipart/form-data"));
      const form = last.body.toString("latin1");
      assert.ok(form.includes("A small orange cat floating in outer space"), "englischer Prompt");
      assert.ok(/name="width"\r\n\r\n1024/.test(form) && /name="height"\r\n\r\n1024/.test(form));
      ok("„Mal mir eine Katze im Weltall“ → englischer Prompt → FLUX.2 (1024×1024) → JPEG zurück");

      // --- Handy-Hintergrund: Hochformat, mit Vorlage
      const jpg = { mime: "image/jpeg", data: "/9j/" + "B".repeat(400) };
      r = await post("/v1/image", { prompt: "Mach daraus einen Handy-Hintergrund im Anime-Stil", images: [jpg] });
      assert.strictEqual(r.status, 200, JSON.stringify(r.j));
      const form2 = seen[seen.length - 1].body.toString("latin1");
      assert.ok(/name="width"\r\n\r\n768/.test(form2) && /name="height"\r\n\r\n1344/.test(form2), "Hochformat");
      assert.ok(form2.includes('name="input_image_0"'), "Vorlage dabei");
      ok("Handy-Hintergrund → Hochformat 768×1344, das mitgeschickte Bild als Vorlage");

      // --- kaputte Eingaben
      assert.strictEqual((await post("/v1/image", { prompt: "x" })).status, 400);
      assert.strictEqual((await post("/v1/image", { prompt: "eine Katze", images: [{ mime: "text/html", data: "A".repeat(200) }] })).status, 400);
      ok("zu kurzer Wunsch oder falsches Bildformat → 400");

      // --- pro Gerät höchstens FREE_IMAGE_PER_DAY (hier 3; kaputte Versuche zählen nicht)
      assert.strictEqual((await post("/v1/image", { prompt: "Ein Hund am Strand" })).status, 200);
      r = await post("/v1/image", { prompt: "Ein Hund im Schnee" });
      assert.strictEqual(r.status, 429); assert.ok(/genug Bilder/.test(r.j.error));
      assert.strictEqual((await post("/v1/image", { prompt: "Ein Hund am Strand" }, { "x-device": "geraet-frei-2" })).status, 200);
      ok("pro Gerät ein Tageslimit (kaputte Versuche zählen nicht), ein anderes Gerät hat sein eigenes");

      // --- Zuhören
      r = await post("/v1/stt", { audio: wav, hint: "Jarvis, Discord, Spotify" });
      assert.strictEqual(r.status, 200, JSON.stringify(r.j));
      assert.strictEqual(r.j.text, "Ruf auf Discord meine Freundin an.");
      last = seen[seen.length - 1];
      const sent = JSON.parse(last.body.toString());
      assert.strictEqual(sent.language, "de"); assert.strictEqual(sent.initial_prompt, "Jarvis, Discord, Spotify"); assert.strictEqual(sent.audio, wav);
      assert.ok(Math.abs(cloud.wavSeconds(Buffer.from(wav, "base64")) - 2) < 0.01);
      ok("Ton → Whisper large-v3-turbo (Deutsch, mit Namen als Hilfe) → Text");
      assert.strictEqual((await post("/v1/stt", { audio: "kurz" })).status, 400);
      ok("kein richtiger Ton → 400");

      // --- Cloudflare sagt „für heute aufgebraucht“ → 429 an die App, danach fragt der Server gar nicht mehr
      mode = "busy";
      r = await post("/v1/image", { prompt: "Ein Baum im Nebel" }, { "x-device": "geraet-frei-3" });
      assert.strictEqual(r.status, 429); assert.ok(/aufgebraucht/.test(r.j.error));
      const n = seen.length;
      r = await post("/v1/stt", { audio: wav }, { "x-device": "geraet-frei-3" });
      assert.strictEqual(r.status, 503);
      assert.strictEqual(seen.length, n, "fragt nicht mehr nach");
      ok("Tageskontingent bei Cloudflare leer → klare Meldung, keine weiteren Anfragen (die App hört dann selbst zu)");

      // --- ohne Cloudflare-Schlüssel
      cloud.CFG.token = "";
      r = await post("/v1/stt", { audio: wav }, { "x-device": "geraet-frei-4" });
      assert.strictEqual(r.status, 503);
      r = await post("/v1/image", { prompt: "Ein Baum im Nebel" }, { "x-device": "geraet-frei-4" });
      assert.strictEqual(r.status, 503); assert.ok(/nicht eingerichtet/.test(r.j.error));
      ok("ohne CF_API_TOKEN: 503 „noch nicht eingerichtet“");

      // --- Formate aus dem Wunsch
      assert.strictEqual(cloud.shapeOf("ein PC-Hintergrund mit Bergen"), "landscape");
      assert.strictEqual(cloud.shapeOf("YouTube Thumbnail für mein Spiel"), "landscape");
      assert.strictEqual(cloud.shapeOf("ein Logo für Warpline Games"), "square");
      ok("Format aus dem Wunsch (Hoch-/Querformat/quadratisch)");
      console.log("ALLE KOSTENLOS-TESTS OK");
      process.exit(0);
    } catch (e) {
      console.error("FEHLER", e);
      process.exit(1);
    }
  });
});
