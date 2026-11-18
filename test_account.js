// 1.7.0: Konten – E-Mail-Code, Google (mit Vergleichszahl), Premium am Konto auf allen Geräten. Gegen nachgebautes Google/Brevo.
const http = require("http");
const assert = require("assert");
const mails = [];
let googleEmail = "sebastian@example.de";
const fake = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/v3/smtp/email") { mails.push(JSON.parse(b)); return json(201, { messageId: "m" }); }
    if (req.url === "/google/token") {
      const f = new URLSearchParams(b);
      if (f.get("client_secret") !== "g-geheim" || f.get("code") !== "goodcode") return json(400, { error: "invalid_grant" });
      const claims = { iss: "https://accounts.google.com", aud: "gid.apps.googleusercontent.com", email: googleEmail, email_verified: true, exp: Math.floor(Date.now() / 1000) + 600 };
      return json(200, { id_token: "x." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".y" });
    }
    if (req.url.startsWith("/or/")) { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"data":[]}'); }
    json(404, {});
  });
}).listen(0, "127.0.0.1", () => {
  const p = fake.address().port;
  Object.assign(process.env, {
    OPENROUTER_API_KEY: "o", APP_TOKEN: "geheim-token-123", OPENROUTER_BASE: `http://127.0.0.1:${p}/or`, PORT: "0", KEEP_AWAKE: "0",
    PREMIUM_SECRET: "ein-langes-geheimnis-fuer-die-codes", ADMIN_TOKEN: "verwaltung-geheim-1234",
    BREVO_API_KEY: "brevo", BREVO_BASE: `http://127.0.0.1:${p}`, MAIL_FROM: "jarvis@example.de",
    GOOGLE_CLIENT_ID: "gid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "g-geheim", GOOGLE_TOKEN_URL: `http://127.0.0.1:${p}/google/token`,
    GOOGLE_AUTH_URL: "https://accounts.google.test/auth", ACCOUNT_PER_MINUTE: "500",
  });
  const { server, premium, account } = require("./server.js");
  server.listen(0, "127.0.0.1", async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    account.CFG.publicUrl = base;
    const ok = (m) => console.log("  ok   " + m);
    const H = (dev, tok) => ({ "content-type": "application/json", "x-jarvis-token": "geheim-token-123", "x-device": dev, ...(tok ? { "x-jarvis-account": tok } : {}) });
    const post = async (path, body, dev = "handy-1-abcdef", tok = "") => { const r = await fetch(base + path, { method: "POST", headers: H(dev, tok), body: JSON.stringify(body || {}) }); return { status: r.status, j: await r.json() }; };
    const get = async (path, dev = "handy-1-abcdef", tok = "") => { const r = await fetch(base + path, { headers: H(dev, tok) }); return { status: r.status, j: await r.json() }; };
    try {
      assert.deepStrictEqual((await get("/v1/account/ways")).j, { mail: true, google: true, persistent: false });

      // --- E-Mail-Code
      let r = await post("/v1/account/mail/start", { email: "Sebastian@Example.de " });
      assert.strictEqual(r.status, 200, JSON.stringify(r.j));
      const code = mails.at(-1).textContent.match(/(\d{6})/)[1];
      assert.strictEqual(mails.at(-1).to[0].email, "sebastian@example.de");
      r = await post("/v1/account/mail/verify", { email: "sebastian@example.de", code: code === "000000" ? "111111" : "000000" });
      assert.strictEqual(r.status, 403); assert.ok(/noch 4 Versuche/.test(r.j.error));
      r = await post("/v1/account/mail/verify", { email: "sebastian@example.de", code });
      assert.strictEqual(r.status, 200, JSON.stringify(r.j));
      const tokPhone = r.j.token;
      assert.ok(/^JA1\./.test(tokPhone)); assert.strictEqual(r.j.email, "sebastian@example.de"); assert.strictEqual(r.j.code, "");
      assert.strictEqual((await post("/v1/account/mail/verify", { email: "sebastian@example.de", code })).status, 400, "ein Code nur einmal");
      ok("E-Mail-Code: 6 Ziffern per Mail, falscher Code zählt runter, richtiger meldet an, nur einmal gültig");
      for (let i = 0; i < 2; i++) await post("/v1/account/mail/start", { email: "sebastian@example.de" });
      assert.strictEqual((await post("/v1/account/mail/start", { email: "sebastian@example.de" })).status, 429);
      ok("höchstens 3 Mails pro Stunde an eine Adresse");

      // --- Google (am PC): Vergleichszahl, Bestätigen, Abholen
      r = await post("/v1/account/google/begin", { device: "Sebastians PC" }, "pc-1-abcdefgh");
      const { poll, code: four, url } = r.j;
      assert.ok(/^\d{4}$/.test(four));
      assert.deepStrictEqual((await post("/v1/account/google/poll", { poll }, "pc-1-abcdefgh")).j, { state: "wait" });
      const start = await fetch(url, { redirect: "manual" });
      assert.strictEqual(start.status, 302);
      const state = new URL(start.headers.get("location")).searchParams.get("state");
      assert.ok(start.headers.get("location").startsWith("https://accounts.google.test/auth?"));
      const bad = await (await fetch(`${base}/v1/account/google/callback?code=goodcode&state=${state.slice(0, -2)}xx`)).text();
      assert.ok(/abgelaufen/.test(bad), "gefälschter state");
      const cb = await (await fetch(`${base}/v1/account/google/callback?code=goodcode&state=${encodeURIComponent(state)}`)).text();
      assert.ok(cb.includes(four) && cb.includes("sebastian@example.de") && cb.includes("Sebastians PC"));
      assert.deepStrictEqual((await post("/v1/account/google/poll", { poll }, "pc-1-abcdefgh")).j, { state: "wait" }, "erst nach Bestätigen");
      const c = cb.match(/name="c" value="([^"]+)"/)[1], pub = cb.match(/name="p" value="([^"]+)"/)[1];
      const replay = await (await fetch(`${base}/v1/account/google/callback?code=goodcode&state=${encodeURIComponent(state)}`)).text();
      assert.ok(/abgelaufen/.test(replay), "derselbe Rückweg nur einmal");
      const conf = await (await fetch(`${base}/v1/account/google/confirm`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `p=${pub}&c=${c}` })).text();
      assert.ok(/ist angemeldet/.test(conf));
      r = await post("/v1/account/google/poll", { poll }, "pc-1-abcdefgh");
      assert.strictEqual(r.j.state, "done"); assert.strictEqual(r.j.email, "sebastian@example.de");
      const tokPc = r.j.token;
      assert.deepStrictEqual((await post("/v1/account/google/poll", { poll }, "pc-1-abcdefgh")).j, { state: "gone" }, "nur einmal abholbar");
      assert.deepStrictEqual((await post("/v1/account/google/poll", { poll: poll.split(".")[0] + ".falsch" })).j, { state: "gone" });
      ok("Google: Weiterleitung, Bestätigungsseite mit derselben Zahl, erst nach „Ja“ angemeldet, alles nur einmal – gleiche E-Mail = gleiches Konto");

      // --- Premium aufs Konto: am Handy eingelöst → am PC sofort da
      const made = await (await fetch(base + "/v1/premium/admin/code", { method: "POST", headers: { "content-type": "application/json", "x-admin-token": "verwaltung-geheim-1234" }, body: '{"plan":"test","days":30,"budget":"1"}' })).json();
      r = await post("/v1/account/redeem", { code: made.code }, "handy-1-abcdef", tokPhone);
      assert.strictEqual(r.status, 200, JSON.stringify(r.j)); assert.strictEqual(r.j.code, made.code); assert.ok(r.j.premium.active);
      r = await get("/v1/account/me", "pc-1-abcdefgh", tokPc);
      assert.strictEqual(r.j.code, made.code, JSON.stringify(r)); assert.ok(r.j.premium.active);
      const st = await get("/v1/premium/status", "pc-1-abcdefgh", tokPc);
      assert.ok(st.j.ok && st.j.active, "PC hat Premium über das Konto, ohne Code einzutippen");
      ok("Code am Handy aufs Konto → PC ist sofort Premium (über das Konto)");
      // viele Geräte am Konto zählen als eins
      for (const d of ["tablet-1-abcdef", "laptop-1-abcdef", "handy-neu-abcdef"]) assert.ok((await get("/v1/premium/status", d, tokPhone)).j.active);
      const plain = await (await fetch(base + "/v1/premium/status", { headers: { "x-jarvis-token": "geheim-token-123", "x-device": "fremd-1-abcdefg", "x-jarvis-premium": made.code } })).json();
      assert.strictEqual(plain.ok, true, "Code ohne Konto: noch Platz (Konto zählt als eins)");
      ok("beliebig viele Geräte desselben Kontos zählen als eins");

      // --- Sitzung fälschen / abmelden
      assert.strictEqual((await get("/v1/account/me", "x-1-abcdefgh", tokPc.slice(0, -3) + "aaa")).status, 401);
      await post("/v1/account/logout-all", {}, "handy-1-abcdef", tokPhone);
      assert.strictEqual((await get("/v1/account/me", "pc-1-abcdefgh", tokPc)).status, 401);
      ok("gefälschte Sitzung gilt nicht; „Überall abmelden“ meldet alle Geräte ab");

      // --- Kauf-Ticket
      const t = account.buyTicket(account.idOf("sebastian@example.de"));
      assert.strictEqual(account.ticketAccount(t), account.idOf("sebastian@example.de"));
      assert.strictEqual(account.ticketAccount(t.slice(0, -2) + "zz"), "");
      ok("Kauf-Ticket: zeigt aufs richtige Konto, gefälscht → keins");
      console.log("ALLE KONTO-TESTS OK"); process.exit(0);
    } catch (e) { console.error("FEHLER", e); process.exit(1); }
  });
});
