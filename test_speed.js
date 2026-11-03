// 1.0.45 – der Nutzer (3.11.): „wenn ich bei Jarvis ein Bild hochlade, dauert es teilweise 4, 5 Minuten … bei Gemini innerhalb
// 2 Sekunden“. Ein Modell, das sich Zeit lässt, bekommt nach ein paar Sekunden ein zweites parallel – wer zuerst schreibt,
// gewinnt, das andere wird abgebrochen. Bei Bildern kommt danach das zuletzt schnellste zuerst.
const http = require("http");
const assert = require("assert");
const calls = [];
const closedEarly = [];
const upstream = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    if (req.url.startsWith("/or/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [] }));
    }
    const m = JSON.parse(b).model;
    calls.push(m);
    if (m.includes("broken")) { res.writeHead(503); return res.end("{}"); }
    const wait = m.includes("slow") ? 2500 : m.includes("lazy") ? 150 : 0;
    let done = false;
    res.on("close", () => { if (!done) closedEarly.push(m); });
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: m + ": " } }] })}\n\n`);
      setTimeout(() => {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Lösung" } }] })}\n\n`);
        done = true;
        res.end("data: [DONE]\n\n");
      }, 50);
    }, wait);
  });
}).listen(0, "127.0.0.1", () => {
  const p = upstream.address().port;
  Object.assign(process.env, {
    OPENROUTER_API_KEY: "o-geheim", APP_TOKEN: "geheim-token-123", OPENROUTER_BASE: `http://127.0.0.1:${p}/or`, PORT: "0", KEEP_AWAKE: "0",
    LIMIT_PER_MINUTE: "100", LIMIT_IP_PER_MINUTE: "100", LIMIT_PER_DAY: "100", LIMIT_IP_PER_DAY: "100", LIMIT_ALL_PER_DAY: "100",
    HEDGE_VISION_MS: "300", HEDGE_CHAT_MS: "300",
    MODELS_VISION: "or:a/slow-eye:free,or:b/quick-eye:free",
    MODELS_CHAT: "or:a/slow-talk:free,or:b/quick-talk:free",
    MODELS_CODE: "or:a/broken-coder:free,or:b/lazy-coder:free,or:c/quick-coder:free",
  });
  const { server } = require("./server.js");
  server.listen(0, "127.0.0.1", async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ok = (m) => console.log("  ok   " + m);
    const img = { mime: "image/jpeg", data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]).toString("base64") };
    const ask = async (task, extra = {}) => {
      const t0 = Date.now();
      const r = await fetch(base + "/v1/chat", { method: "POST",
        headers: { "content-type": "application/json", "x-jarvis-token": "geheim-token-123", "x-device": "geraet-speed-1" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Was ist das?" }], task, stream: true, ...extra }) });
      const text = await r.text();
      const got = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
      return { ms: Date.now() - t0, text: got.map((x) => x.delta || "").join(""), model: (got.find((x) => x.done) || {}).model, status: r.status };
    };
    try {
      // --- ein Bild: das erste Modell hängt → nach 0,3 s fragt der Server zusätzlich das zweite, das gewinnt
      let a = await ask("vision", { image: img });
      assert.equal(a.text, "b/quick-eye:free: Lösung");
      assert.ok(a.ms < 1500, `${a.ms} ms`);
      assert.deepEqual(calls, ["a/slow-eye:free", "b/quick-eye:free"]);
      ok(`Bild: erstes Modell hängt → nach 0,3 s parallel das zweite, Antwort nach ${a.ms} ms (statt 2,5 s und mehr)`);
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(closedEarly, ["a/slow-eye:free"]);
      ok("das langsame wird abgebrochen (verbraucht nichts weiter)");
      // --- das nächste Bild: das schnelle zuerst – das langsame wird gar nicht erst gefragt
      calls.length = 0;
      a = await ask("vision", { image: img });
      assert.equal(a.text, "b/quick-eye:free: Lösung");
      assert.deepEqual(calls, ["b/quick-eye:free"]);
      ok(`nächstes Bild: das schnellste zuerst (${a.ms} ms, nur eine Anfrage)`);
      // --- Reden: genauso
      calls.length = 0;
      a = await ask("chat");
      assert.equal(a.text, "b/quick-talk:free: Lösung");
      assert.ok(a.ms < 1500);
      ok(`Reden: hängendes Modell → das zweite springt nach 0,3 s ein (${a.ms} ms)`);
      // --- Programmieren: kaputt → sofort das nächste (ohne Wartezeit); ein langsames, das vor der Wartezeit anfängt, bleibt allein
      calls.length = 0;
      a = await ask("code");
      assert.equal(a.text, "b/lazy-coder:free: Lösung");
      assert.deepEqual(calls, ["a/broken-coder:free", "b/lazy-coder:free"]);
      ok("kaputtes Modell → sofort das nächste; fängt das vor der Wartezeit an, wird kein drittes gefragt");
      console.log("ALL OK (5)");
      process.exit(0);
    } catch (e) {
      console.log("  FAIL", e.message, "\n", calls, closedEarly);
      process.exit(1);
    }
  });
});
