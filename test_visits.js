// 1.9.0: Besucherzähler der Webseite – jeder Browser zählt einmal, „gerade da“ nur solange er sich meldet.
const http = require("http");
const assert = require("assert");

// ein kleines Upstash zum Testen (nur was visits.js braucht)
const sets = new Map(), zsets = new Map();
const S = (k) => sets.get(k) || sets.set(k, new Set()).get(k);
const Z = (k) => zsets.get(k) || zsets.set(k, new Map()).get(k);
const up = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    if (req.headers.authorization !== "Bearer t") { res.writeHead(401, { "content-type": "application/json" }); return res.end('{"error":"WRONGPASS"}'); }
    const [cmd, key, ...a] = JSON.parse(b); let r = null;
    if (cmd === "SISMEMBER") r = S(key).has(a[0]) ? 1 : 0;
    else if (cmd === "SADD") { r = S(key).has(a[0]) ? 0 : 1; S(key).add(a[0]); }
    else if (cmd === "SCARD") r = S(key).size;
    else if (cmd === "ZADD") { Z(key).set(a[1], Number(a[0])); r = 1; }
    else if (cmd === "ZREM") r = Z(key).delete(a[0]) ? 1 : 0;
    else if (cmd === "ZCARD") r = Z(key).size;
    else if (cmd === "PING") r = "PONG";
    else if (cmd === "ZREMRANGEBYSCORE") { r = 0; for (const [m, sc] of Z(key)) if (sc <= Number(a[1])) { Z(key).delete(m); r++; } }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ result: r }));
  });
}).listen(0, "127.0.0.1", () => {
  Object.assign(process.env, { APP_TOKEN: "geheim-token-123", PORT: "0", KEEP_AWAKE: "0", OPENROUTER_API_KEY: "o",
    PREMIUM_SECRET: "ein-langes-geheimnis-fuer-die-codes", UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${up.address().port}`,
    UPSTASH_REDIS_REST_TOKEN: "t", TRUST_PROXY: "1" });
  const { server, visits, premium } = require("./server.js");
  visits.CFG.cacheMs = 0;
  server.listen(0, "127.0.0.1", async () => {
    const base = `http://127.0.0.1:${server.address().port}/v1/visits`;
    const SITE = "https://anonymdtm.github.io";
    const ok = (m) => console.log("  ok   " + m);
    let ipN = 0;
    const post = (body, { origin = SITE, ip = "10.0.0.1", type = "text/plain" } = {}) => fetch(base, { method: "POST",
      headers: { "content-type": type, origin, "x-forwarded-for": ip }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const beat = async (id, extra = {}, opt) => (await post({ id, ...extra }, opt)).json();
    const A = "a1b2c3d4-e5f6-4a7b-8c9d-000000000001", B = "a1b2c3d4-e5f6-4a7b-8c9d-000000000002";
    try {
      assert.deepStrictEqual(await (await fetch(base)).json(), { live: 0, total: 0 });
      ok("am Anfang: niemand da, niemand gezählt");

      assert.deepStrictEqual(await beat(A), { live: 1, total: 1 });
      assert.deepStrictEqual(await beat(A), { live: 1, total: 1 });
      ok("derselbe Browser zählt nur einmal – auch bei jedem Lebenszeichen");

      assert.deepStrictEqual(await beat(A, { bye: true }), { live: 0, total: 1 });
      assert.deepStrictEqual(await beat(A), { live: 1, total: 1 });
      ok("Seite zu und wieder auf: weiter 1 Person insgesamt (nicht 2)");

      assert.deepStrictEqual(await beat(B, {}, { ip: "10.0.0.2", type: "application/json" }), { live: 2, total: 2 });
      ok("ein zweiter Browser: 2 gerade da, 2 insgesamt (auch mit JSON)");

      visits.CFG.liveMs = 60;
      await new Promise((r) => setTimeout(r, 120));
      assert.deepStrictEqual(await (await fetch(base)).json(), { live: 0, total: 2 });
      visits.CFG.liveMs = 75_000;
      ok("wer sich nicht mehr meldet, ist nach kurzer Zeit nicht mehr „gerade da“ – insgesamt bleibt");

      const stored = JSON.stringify([...S("jarvis:visitors"), ...Z("jarvis:live").keys()]);
      assert.ok(!stored.includes(A) && !stored.includes("10.0.0.1"));
      assert.ok([...S("jarvis:visitors")].includes(visits.finger(A)));
      ok("gespeichert wird nur ein Fingerabdruck – nie die Nummer selbst, nie die IP");

      const g = await fetch(base, { headers: { origin: SITE } });
      assert.strictEqual(g.headers.get("access-control-allow-origin"), SITE);
      const pre = await fetch(base, { method: "OPTIONS", headers: { origin: SITE } });
      assert.strictEqual(pre.status, 204); assert.strictEqual(pre.headers.get("access-control-allow-origin"), SITE);
      assert.strictEqual((await post({ id: "b".repeat(20) }, { origin: "https://boese.example" })).status, 403);
      assert.strictEqual((await fetch(base, { headers: { origin: "https://boese.example" } })).headers.get("access-control-allow-origin"), null);
      ok("nur die Webseite darf aus dem Browser zählen (CORS), fremde Seiten nicht");

      assert.strictEqual((await post({ id: "kurz" })).status, 400);
      assert.strictEqual((await post("kein json")).status, 400);
      assert.strictEqual((await post({ id: "x".repeat(20) + "<script>" })).status, 400);
      assert.strictEqual((await post({ id: "y".repeat(300) })).status, 400);
      ok("kaputte oder fremde Nummern werden abgelehnt");

      visits.CFG.newPerIpPerDay = 3;
      for (let i = 0; i < 6; i++) await beat(`fake-nummer-${String(i).padStart(12, "0")}`, {}, { ip: "10.9.9.9" });
      const c = await (await fetch(base)).json();
      assert.ok(c.total <= 2 + 3, JSON.stringify(c));
      ok("Hochzählen mit erfundenen Nummern geht nicht weit (höchstens ein paar neue je IP und Tag)");

      let limited = 0;
      for (let i = 0; i < 40; i++) if ((await post({ id: A }, { ip: "10.7.7.7" })).status === 429) limited++;
      assert.ok(limited > 0);
      ok("zu viele Anfragen von einer IP: 429");

      // ohne Upstash: im Speicher (bis zum Neustart)
      const url = premium.CFG.upstashUrl; premium.CFG.upstashUrl = "";
      const before = await (await fetch(base)).json();
      assert.deepStrictEqual(await beat("c".repeat(24), {}, { ip: "10.1.1.1" }), { live: before.live + 1, total: before.total + 1 });
      assert.deepStrictEqual(await beat("c".repeat(24), {}, { ip: "10.1.1.1" }), { live: before.live + 1, total: before.total + 1 });
      premium.CFG.upstashUrl = url;
      ok("ohne Upstash zählt der Server im Speicher weiter");

      // 1.9.1 – der Nutzer, 25.11.: Handy + PC offen, trotzdem „1 Besucher“ – Upstash lehnte den Token ab, nichts wurde gezählt
      assert.deepStrictEqual(await premium.upstashCheck(), { ok: true });
      premium.CFG.upstashToken = "falsch";
      assert.ok(/401.*Token/.test((await premium.upstashCheck()).why));
      const b2 = await (await fetch(base)).json();
      const r1 = await beat("handy-0000000000000001", {}, { ip: "10.3.3.3" });
      const r2 = await beat("pc-000000000000000001", {}, { ip: "10.3.3.3" });
      assert.strictEqual(r2.total, b2.total + 2); assert.ok(r2.live >= 2 && r1.total === b2.total + 1);
      premium.CFG.upstashToken = "t";
      ok("Upstash lehnt den Token ab: der Server zählt trotzdem (Handy + PC = 2) und meldet den Grund");

      console.log("ALLE BESUCHER-TESTS OK"); process.exit(0);
    } catch (e) { console.error("FEHLER", e); process.exit(1); }
  });
});
