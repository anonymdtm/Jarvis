// 1.6.0: jeder Code gilt nur für ein Gerät (+ gekoppelten PC); ohne OpenRouter-Guthaben keine starken Modelle in der Liste.
const http = require("http");
const assert = require("assert");
let credit = 0;
const up = http.createServer((req, res) => {
  const j = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url.startsWith("/or/credits")) return j({ data: { total_credits: credit, total_usage: 0 } });
  if (req.url.startsWith("/or/models")) return j({ data: [{ id: "a/free:free", pricing: { prompt: "0", completion: "0" } },
    { id: "anthropic/claude-sonnet-5.5", created: 30, pricing: { prompt: "0.000002", completion: "0.00001" } }] });
  res.writeHead(404); res.end();
}).listen(0, "127.0.0.1", () => {
  Object.assign(process.env, { OPENROUTER_API_KEY: "o", APP_TOKEN: "geheim-token-123", OPENROUTER_BASE: `http://127.0.0.1:${up.address().port}/or`,
    PORT: "0", KEEP_AWAKE: "0", PREMIUM_SECRET: "ein-langes-geheimnis-fuer-die-codes", ADMIN_TOKEN: "verwaltung-geheim-1234" });
  const { server, premium } = require("./server.js");
  server.listen(0, "127.0.0.1", async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ok = (m) => console.log("  ok   " + m);
    const status = async (code, device) => (await fetch(base + "/v1/premium/status", { headers: { "x-jarvis-token": "geheim-token-123", "x-device": device, "x-jarvis-premium": code } })).json();
    try {
      const page = await (await fetch(base + "/admin")).text();
      assert.ok(page.includes("Promo-Code erstellen") && page.includes("nur für <b>ein</b> Handy"));
      const made = await (await fetch(base + "/v1/premium/admin/code", { method: "POST", headers: { "content-type": "application/json", "x-admin-token": "verwaltung-geheim-1234" }, body: '{"plan":"test","days":30,"budget":"1"}' })).json();
      const code = made.code;
      assert.ok((await status(code, "handy-von-tim-123")).ok);
      assert.ok((await status(code, "handy-von-tim-123")).ok, "dasselbe Handy immer wieder");
      assert.ok((await status(code, "pc-von-tim-12345")).ok, "dazu sein PC");
      const third = await status(code, "handy-von-lea-999");
      assert.strictEqual(third.ok, false); assert.ok(/schon auf einem anderen Gerät/.test(third.error));
      ok("Ein Code: ein Handy + ein PC – ein drittes Gerät bekommt „schon eingelöst“");
      let mo = await (await fetch(base + "/v1/models", { headers: { "x-jarvis-token": "geheim-token-123", "x-device": "x-geraet-1234" } })).json();
      assert.deepStrictEqual(mo.premium.chat, []); assert.strictEqual(mo.premium.strong_models, false);
      assert.deepStrictEqual((await status(code, "handy-von-tim-123")).models, []);
      ok("ohne Guthaben bei OpenRouter: keine starken Modelle in der Liste");
      console.log("ALLE EINMAL-TESTS OK"); process.exit(0);
    } catch (e) { console.error("FEHLER", e); process.exit(1); }
  });
});
