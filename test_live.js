// Tests für Anrufe (1.0.44): klingeln, annehmen, ablehnen, verpasst, auflegen; „wait“ (sofort statt alle paar Minuten); das
// Gespräch über WebSocket (nur die beiden, alles wird nur durchgereicht). Start: node test_live.js
"use strict";
process.env.APP_TOKEN = "test-token-live";
process.env.KEEP_AWAKE = "0";
const assert = require("assert");
const http = require("http");
const crypto = require("crypto");
const { server, help, live } = require("./server.js");

let n = 0;
const ok = (m) => { n++; console.log("  ok  ", m); };

/** Ein kleiner WebSocket-Client wie in den Apps (maskiert, Ping → Pong). */
function connect(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: "/v1/help/live", headers: {
      Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
      "x-jarvis-token": "test-token-live", ...headers } });
    req.on("upgrade", (res, socket, first) => {
      const c = { socket, got: [], closed: false, buf: Buffer.alloc(0) };
      c.send = (data, binary) => {
        const p = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        const mask = crypto.randomBytes(4);
        const head = p.length < 126 ? Buffer.from([0x80 | (binary ? 2 : 1), 0x80 | p.length])
          : (() => { const h = Buffer.alloc(4); h[0] = 0x80 | (binary ? 2 : 1); h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); return h; })();
        const body = Buffer.from(p); for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
        socket.write(Buffer.concat([head, mask, body]));
      };
      const take = (d) => {
        c.buf = Buffer.concat([c.buf, d]);
        while (c.buf.length >= 2) {
          let len = c.buf[1] & 0x7f, off = 2;
          if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
          if (c.buf.length < off + len) return;
          const op = c.buf[0] & 0x0f, p = c.buf.subarray(off, off + len);
          c.buf = c.buf.subarray(off + len);
          if (op === 1) c.got.push(JSON.parse(p.toString()));
          else if (op === 2) c.got.push(Buffer.from(p));
          else if (op === 8) c.closed = true;
        }
      };
      if (first && first.length) take(first);
      socket.on("data", take);
      socket.on("close", () => { c.closed = true; });
      resolve(c);
    });
    req.on("response", (res) => { let b = ""; res.on("data", (x) => b += x); res.on("end", () => reject(Object.assign(new Error(b), { status: res.statusCode }))); });
    req.on("error", reject);
    req.end();
  });
}
const until = async (what, f, ms = 3000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error("nicht eingetreten: " + what); await new Promise((r) => setTimeout(r, 20)); } };

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const call = async (path, body, device = "geraet-sebastian-1") => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", "x-jarvis-token": "test-token-live", "x-device": device }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, j: await r.json() };
  };
  try {
    help._reset();
    let r = await call("/v1/help/create", { name: "Sebastian", reason: "phone", text: "Akku lädt nicht" });
    const id = r.j.ticket.id, sKey = r.j.key;
    r = await call("/v1/help/accept", { id, name: "Jona" }, "geraet-jona-00001");
    const jKey = r.j.key;
    let v = r.j.ticket.v;
    const since = Math.max(...r.j.ticket.msgs.map((m) => m.at));
    // --- „wait“: nichts Neues → die Anfrage wartet; Sebastian schreibt → Jona hat es sofort
    let t0 = Date.now();
    const waiting = call("/v1/help/wait", { items: [{ id, key: jKey, since, v }] }, "geraet-jona-00001");
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(help._waiting(), 1);
    await call("/v1/help/send", { id, key: sKey, text: "Moin, danke!" });
    r = await waiting;
    assert.ok(Date.now() - t0 < 1500, "sofort");
    assert.equal(r.j.items.length, 1);
    assert.equal(r.j.items[0].msgs.slice(-1)[0].text, "Moin, danke!");
    v = r.j.items[0].v;
    ok("wait: Nachricht kommt sofort (statt alle paar Minuten)");
    // nichts Neues und kurze Wartezeit → leere Antwort
    const quiet = await new Promise((res) => help.wait("geraet-jona-00001", { items: [{ id, key: jKey, since: Date.now() + 10, v }] }, res, 150));
    assert.deepEqual(quiet.items, []);
    assert.equal(help._waiting(), 0);
    ok("wait: ohne Neuigkeit leer nach der Wartezeit – nichts bleibt hängen");
    // --- Live-Verbindung nur bei laufendem Anruf
    await assert.rejects(connect(port, { "x-device": "geraet-sebastian-1", "x-help-id": id, "x-help-key": sKey }), (e) => e.status === 409);
    ok("ohne Anruf keine Live-Verbindung (409)");
    // --- Sebastian ruft an → Jonas wartende Anfrage meldet „ringing“
    const jWait = call("/v1/help/wait", { items: [{ id, key: jKey, since: Date.now(), v }] }, "geraet-jona-00001");
    await new Promise((res) => setTimeout(res, 100));
    r = await call("/v1/help/call", { id, key: sKey, action: "ring" });
    assert.equal(r.j.call.state, "ringing"); assert.equal(r.j.call.by, "owner");
    r = await jWait;
    assert.equal(r.j.items[0].call.state, "ringing");
    v = r.j.items[0].v;
    ok("Anruf: es klingelt beim anderen sofort");
    assert.equal((await call("/v1/help/call", { id, key: sKey, action: "accept" })).status, 409);
    r = await call("/v1/help/call", { id, key: jKey, action: "accept" }, "geraet-jona-00001");
    assert.equal(r.j.call.state, "active");
    ok("annehmen geht nur beim Angerufenen");
    // --- beide verbinden sich: Sprache und Bild gehen nur zur anderen Seite
    await assert.rejects(connect(port, { "x-device": "geraet-fremd-0001", "x-help-id": id, "x-help-key": "falsch" }), (e) => e.status === 403);
    const a = await connect(port, { "x-device": "geraet-sebastian-1", "x-help-id": id, "x-help-key": sKey });
    await until("hello A", () => a.got.length >= 1);
    assert.deepEqual(a.got[0], { t: "hello", role: "owner", peer: false });
    const b = await connect(port, { "x-device": "geraet-jona-00001", "x-help-id": id, "x-help-key": jKey });
    await until("hello B, peer A", () => b.got.length >= 1 && a.got.length >= 2);
    assert.deepEqual(b.got[0], { t: "hello", role: "helper", peer: true });
    assert.deepEqual(a.got[1], { t: "peer", on: true });
    const voice = Buffer.concat([Buffer.from([1]), crypto.randomBytes(170)]);
    a.send(voice, true);
    await until("Sprache bei B", () => b.got.some((x) => Buffer.isBuffer(x)));
    assert.ok(b.got.find((x) => Buffer.isBuffer(x)).equals(voice));
    const picture = Buffer.concat([Buffer.from([2]), crypto.randomBytes(60_000)]);
    a.send(picture, true);
    b.send(JSON.stringify({ t: "share-ask", control: true }));
    await until("Bild bei B, Anfrage bei A", () => b.got.filter((x) => Buffer.isBuffer(x)).length === 2 && a.got.some((x) => x.t === "share-ask"));
    assert.ok(b.got.filter((x) => Buffer.isBuffer(x))[1].equals(picture));
    assert.equal(a.got.filter((x) => Buffer.isBuffer(x)).length, 0, "nichts kommt zurück");
    ok("Sprache, Bilder (60 KB) und Anfragen gehen nur zur anderen Seite");
    assert.throws(() => help.liveCheck(id, "falsch"), (e) => e.status === 403);
    // --- auflegen: beide Verbindungen zu, im Chat steht die Dauer
    r = await call("/v1/help/call", { id, key: jKey, action: "end" }, "geraet-jona-00001");
    assert.equal(r.j.call.state, "ended");
    await until("beide zu", () => a.closed && b.closed);
    assert.ok(a.got.some((x) => x.t === "end"));
    r = await call("/v1/help/sync", { items: [{ id, key: sKey, since: 0 }] });
    assert.ok(/^Anruf beendet \(0:0\d\)\.$/.test(r.j.items[0].msgs.slice(-1)[0].text), r.j.items[0].msgs.slice(-1)[0].text);
    ok("auflegen: Verbindungen zu, „Anruf beendet (0:01)“ im Chat");
    // --- ablehnen
    await call("/v1/help/call", { id, key: jKey, action: "ring" }, "geraet-jona-00001");
    r = await call("/v1/help/call", { id, key: sKey, action: "decline" });
    assert.equal(r.j.call.state, "declined");
    r = await call("/v1/help/sync", { items: [{ id, key: jKey, since: 0 }] }, "geraet-jona-00001");
    assert.equal(r.j.items[0].msgs.slice(-1)[0].text, "Sebastian hat den Anruf abgelehnt.");
    ok("ablehnen: „Sebastian hat den Anruf abgelehnt.“");
    // --- verpasst: nach 45 Sekunden ohne Antwort
    let fake = Date.now();
    help._clock(() => fake);
    await call("/v1/help/call", { id, key: sKey, action: "ring" });
    fake += 46_000;
    r = await call("/v1/help/sync", { items: [{ id, key: jKey, since: 0 }] }, "geraet-jona-00001");
    assert.equal(r.j.items[0].call.state, "missed");
    assert.equal(r.j.items[0].msgs.slice(-1)[0].text, "Verpasster Anruf von Sebastian.");
    help._clock(null);
    ok("verpasst: nach 45 Sekunden „Verpasster Anruf von Sebastian.“");
    // --- beide rufen gleichzeitig an → verbunden
    await call("/v1/help/call", { id, key: sKey, action: "ring" });
    r = await call("/v1/help/call", { id, key: jKey, action: "ring" }, "geraet-jona-00001");
    assert.equal(r.j.call.state, "active");
    ok("beide rufen gleichzeitig an → das Gespräch steht");
    // --- Ticket schließen beendet den Anruf
    const c = await connect(port, { "x-device": "geraet-sebastian-1", "x-help-id": id, "x-help-key": sKey });
    await call("/v1/help/close", { id, key: jKey }, "geraet-jona-00001");
    await until("geschlossen", () => c.closed);
    r = await call("/v1/help/sync", { items: [{ id, key: sKey, since: 0 }] });
    assert.equal(r.j.items[0].call.state, "ended");
    assert.equal(r.j.items[0].status, "closed");
    assert.equal((await call("/v1/help/call", { id, key: sKey, action: "ring" })).status, 409);
    ok("Ticket geschlossen → Anruf beendet, kein neuer möglich");
    assert.equal(live.rooms.size, 0);
    console.log(`ALL OK (${n})`);
    process.exit(0);
  } catch (e) {
    console.error("FAIL", e);
    process.exit(1);
  }
})();
