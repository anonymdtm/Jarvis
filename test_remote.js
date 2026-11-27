// 1.10.0: den PC von unterwegs erreichen – der PC holt ab, das Handy fragt, der Server reicht nur verschlüsselte Kästchen weiter.
const assert = require("assert");

Object.assign(process.env, { APP_TOKEN: "geheim-token-123", PORT: "0", KEEP_AWAKE: "0", OPENROUTER_API_KEY: "o", TRUST_PROXY: "1" });
const { server, remote } = require("./server.js");

server.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}/v1/pc`;
  const ok = (m) => console.log("  ok   " + m);
  const H = { "content-type": "application/json", "x-jarvis-token": "geheim-token-123" };
  const post = (p, body, extra = {}) => fetch(`${base}/${p}`, { method: "POST", headers: { ...H, ...extra }, body: JSON.stringify(body) });
  const ID = "0123456789abcdef0123456789abcdef", ID2 = "fedcba9876543210fedcba9876543210";
  const BOX = Buffer.from("verschlüsselt, der Server sieht nur das hier ".repeat(3)).toString("base64");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let r = await post("call", { id: ID, box: BOX, to: 5000 });
    assert.strictEqual(r.status, 503);
    assert.strictEqual((await r.json()).error, "offline");
    ok("PC nicht da → 503 „offline“ (das Handy sagt: PC nicht erreichbar)");

    r = await post("call", { id: ID, box: BOX }, { "x-jarvis-token": "falsch" });
    assert.strictEqual(r.status, 401);
    r = await post("wait", { ids: ["nicht-hex"] });
    assert.strictEqual(r.status, 400);
    r = await post("call", { id: ID, box: "kurz" });
    assert.strictEqual(r.status, 400);
    ok("ohne App-Schlüssel, mit kaputter Kennung oder kaputtem Kästchen: abgelehnt");

    // der PC wartet, das Handy fragt, der PC antwortet
    const pcWait = post("wait", { ids: [ID, ID2] });
    await sleep(50);
    const phone = post("call", { id: ID, box: BOX, to: 5000 });
    r = await pcWait;
    assert.strictEqual(r.status, 200);
    const got = (await r.json()).calls;
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].id, ID);
    assert.strictEqual(got[0].box, BOX);
    const ANSWER = Buffer.from("die Antwort des PCs, auch verschlüsselt ".repeat(4)).toString("base64");
    r = await post("answer", { cid: got[0].cid, box: ANSWER });
    assert.strictEqual(r.status, 200);
    r = await phone;
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).box, ANSWER);
    ok("PC wartet → Handy fragt → PC bekommt genau das Kästchen → seine Antwort landet beim Handy");

    r = await post("answer", { cid: got[0].cid, box: ANSWER });
    assert.strictEqual(r.status, 404);
    ok("eine Antwort zählt nur einmal");

    // zwischen zwei Abhol-Anfragen: die Frage wartet kurz, der PC bekommt sie beim nächsten Abholen sofort
    const phone2 = post("call", { id: ID2, box: BOX, to: 5000 });
    await sleep(80);
    const t0 = Date.now();
    r = await post("wait", { ids: [ID, ID2] });
    assert.ok(Date.now() - t0 < 1000);
    const got2 = (await r.json()).calls;
    assert.strictEqual(got2.length, 1);
    assert.strictEqual(got2[0].id, ID2);
    await post("answer", { cid: got2[0].cid, box: ANSWER });
    assert.strictEqual((await phone2).status, 200);
    ok("eine Frage zwischen zwei Abhol-Runden geht nicht verloren (der PC holt sie sofort)");

    // keine Antwort → 504
    remote.L.callMs = 300;
    const phone3 = post("call", { id: ID, box: BOX, to: 100 });
    r = await post("wait", { ids: [ID] });
    await r.json();
    r = await phone3;
    assert.strictEqual(r.status, 504);
    remote.L.callMs = 60_000;
    ok("antwortet der PC nicht, bekommt das Handy nach seiner Wartezeit 504 (nicht ewig warten)");

    // das Handy gibt auf, bevor der PC abholt: die Frage wird nicht mehr ausgeliefert
    const ac = new AbortController();
    const gone = fetch(`${base}/call`, { method: "POST", headers: H, body: JSON.stringify({ id: ID, box: BOX, to: 5000 }), signal: ac.signal }).catch(() => null);
    await sleep(80);
    ac.abort();
    await gone;
    await sleep(80);
    remote.L.waitMs = 200;
    r = await post("wait", { ids: [ID] });
    assert.strictEqual(r.status, 204);
    remote.L.waitMs = 25_000;
    ok("wer nicht mehr wartet, dessen Frage bekommt der PC auch nicht mehr");

    // „ich bin da“ (ms: 0): gleich zurück, der PC gilt danach als erreichbar
    const ID4 = "44444444444444444444444444444444";
    const t1 = Date.now();
    r = await post("wait", { ids: [ID4], ms: 0 });
    assert.strictEqual(r.status, 204);
    assert.ok(Date.now() - t1 < 1000 && remote.online(ID4));
    ok("„ich bin da“ kommt sofort zurück – der PC gilt gleich als erreichbar");

    // nach 25 s ohne Frage: 204, der PC fragt gleich wieder
    remote.L.waitMs = 150;
    r = await post("wait", { ids: [ID] });
    assert.strictEqual(r.status, 204);
    remote.L.waitMs = 25_000;
    ok("ohne Frage endet das Abholen leer (204) – der PC fragt gleich wieder");

    // Grenze pro PC
    remote.L.perMinute = 3;
    const ID3 = "abcdefabcdefabcdefabcdefabcdef12";
    const many = [];
    const answerAll = (async () => {                  // (der PC holt ab und antwortet, bis nichts mehr kommt)
      for (let round = 0; round < 6; round++) {
        remote.L.waitMs = 300;
        const w = await post("wait", { ids: [ID3] });
        if (w.status !== 200) continue;
        for (const c of (await w.json()).calls) await post("answer", { cid: c.cid, box: ANSWER });
      }
    })();
    await sleep(30);
    for (let i = 0; i < 5; i++) many.push(post("call", { id: ID3, box: BOX, to: 2000 }));
    const codes = [];
    for (const m of many) codes.push((await m).status);
    await answerAll;
    remote.L.waitMs = 25_000;
    assert.ok(codes.filter((c) => c === 429).length >= 2, codes.join(","));
    remote.L.perMinute = 900;
    ok("zu viele Fragen an einen PC in einer Minute → 429");

    const stats = remote.stats();
    assert.strictEqual(stats.calls, 0);
    ok(`nichts bleibt hängen (${JSON.stringify(stats)})`);
    console.log("Fernzugriff: alle Prüfungen bestanden");
  } catch (e) {
    console.error("FEHLER", e);
    process.exitCode = 1;
  } finally {
    server.close();
    server.closeAllConnections();
    setTimeout(() => process.exit(), 50);
  }
});
