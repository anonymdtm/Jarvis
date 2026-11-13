// 1.5.0 – Premium kaufen: nur bezahlte (vom Server eingezogene) Bestellungen bekommen einen Code. Gegen ein nachgebautes PayPal.
const http = require("http");
const assert = require("assert");
const orders = new Map();          // id → { approved, captured, amount }
const mails = [];
let n = 0, captures = 0;
const fake = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/v1/oauth2/token") {
      if (req.headers.authorization !== "Basic " + Buffer.from("cid:csecret").toString("base64")) return json(401, {});
      return json(200, { access_token: "tok", expires_in: 3600 });
    }
    if (req.url === "/v3/smtp/email") { mails.push(JSON.parse(b)); return json(201, { messageId: "x" }); }
    if (req.headers.authorization !== "Bearer tok") return json(401, {});
    if (req.method === "POST" && req.url === "/v2/checkout/orders") {
      const j = JSON.parse(b); const id = "ORDER" + (++n) + "XYZ";
      orders.set(id, { approved: false, captured: false, amount: j.purchase_units[0].amount });
      return json(201, { id, status: "CREATED" });
    }
    let m = req.url.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/);
    if (m) {
      captures++;
      const o = orders.get(m[1]);
      if (!o) return json(404, { name: "RESOURCE_NOT_FOUND" });
      if (o.captured) return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] });
      if (!o.approved) return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] });
      o.captured = true;
      return json(201, { id: m[1], status: "COMPLETED", payer: { email_address: "kollege@example.de" },
        purchase_units: [{ payments: { captures: [{ status: "COMPLETED", amount: o.amount }] } }] });
    }
    m = req.url.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)$/);
    if (m) { const o = orders.get(m[1]); return json(200, { id: m[1], status: o.captured ? "COMPLETED" : "APPROVED", payer: { email_address: "kollege@example.de" }, purchase_units: [{ payments: { captures: o.captured ? [{ status: "COMPLETED", amount: o.amount }] : [] } }] }); }
    json(404, {});
  });
}).listen(0, "127.0.0.1", () => {
  const p = fake.address().port;
  Object.assign(process.env, {
    OPENROUTER_API_KEY: "o", APP_TOKEN: "geheim-token-123", OPENROUTER_BASE: `http://127.0.0.1:${p}/or`, PORT: "0", KEEP_AWAKE: "0",
    PREMIUM_SECRET: "ein-langes-geheimnis-fuer-die-codes", PAYPAL_CLIENT_ID: "cid", PAYPAL_SECRET: "csecret", PAYPAL_BASE: `http://127.0.0.1:${p}`,
    BREVO_API_KEY: "brevo", BREVO_BASE: `http://127.0.0.1:${p}`, MAIL_FROM: "warpline.games@example.de", SHOP_PRICE: "4", SHOP_PER_MINUTE: "100",
  });
  const { server, premium, shop } = require("./server.js");
  server.listen(0, "127.0.0.1", async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ok = (m) => console.log("  ok   " + m);
    const post = async (path, body) => { const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }); return { status: r.status, j: await r.json() }; };
    try {
      const pg = await fetch(base + "/kaufen");
      const html = await pg.text();
      assert.strictEqual(pg.status, 200);
      assert.ok(html.includes("4,00 €") && html.includes("client-id=cid") && html.includes("Testmodus"));
      assert.ok(!html.includes("csecret"), "das Geheimnis steht nie in der Seite");
      ok("/kaufen: Preis und PayPal-Knopf, Testmodus-Hinweis, kein Geheimnis in der Seite");

      let r = await post("/v1/shop/order");
      assert.strictEqual(r.status, 200);
      const id = r.j.id;
      assert.deepStrictEqual(orders.get(id).amount, { currency_code: "EUR", value: "4.00" });
      ok("die Bestellung legt der Server an – 4,00 € stehen nur auf dem Server");

      r = await post("/v1/shop/capture", { order: id });
      assert.strictEqual(r.status, 402); assert.ok(!r.j.code);
      ok("nur zurückgekommen, nicht bezahlt (nicht bestätigt) → kein Code");

      orders.get(id).approved = true;
      r = await post("/v1/shop/capture", { order: id });
      assert.strictEqual(r.status, 200, JSON.stringify(r.j));
      const code = r.j.code;
      const c = premium.parse(code);
      assert.ok(c && c.plan === "basis" && c.budget === 2.5 && !c.expired);
      assert.strictEqual(r.j.mailed, true); assert.strictEqual(r.j.email, "k…@example.de");
      assert.strictEqual(mails.length, 1); assert.strictEqual(mails[0].to[0].email, "kollege@example.de"); assert.ok(mails[0].textContent.includes(code));
      ok("bezahlt → gültiger Premium-Code (30 Tage), auf der Seite und per E-Mail an die PayPal-Adresse");

      const before = captures;
      r = await post("/v1/shop/capture", { order: id });
      assert.strictEqual(r.j.code, code); assert.strictEqual(mails.length, 1); assert.strictEqual(captures, before);
      ok("dieselbe Bestellung nochmal → derselbe Code, keine zweite Abbuchung, keine zweite Mail");

      shop.issued.clear();                                   // (wie nach einem Neustart)
      r = await post("/v1/shop/capture", { order: id });
      assert.strictEqual(r.status, 200); assert.ok(premium.parse(r.j.code));
      ok("nach einem Neustart: PayPal sagt „schon eingezogen“ → der Server sieht nach und gibt den Code wieder");

      r = await post("/v1/shop/capture", { order: "ERFUNDEN123" });
      assert.strictEqual(r.status, 502); assert.ok(!r.j.code);
      r = await post("/v1/shop/capture", { order: "<script>" });
      assert.strictEqual(r.status, 400);
      ok("erfundene Bestellnummer → kein Code");

      // zu wenig bezahlt (ein manipulierter Betrag)
      r = await post("/v1/shop/order");
      orders.get(r.j.id).approved = true; orders.get(r.j.id).amount = { currency_code: "EUR", value: "0.01" };
      const cheap = await post("/v1/shop/capture", { order: r.j.id });
      assert.strictEqual(cheap.status, 402); assert.ok(!cheap.j.code);
      ok("falscher Betrag → kein Code");
      console.log("ALLE SHOP-TESTS OK");
      process.exit(0);
    } catch (e) { console.error("FEHLER", e); process.exit(1); }
  });
});
