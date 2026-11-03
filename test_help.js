// Hilfe-Tickets (1.0.43): erstellen, für alle sichtbar, annehmen wie bei Discord, Chat nur für die beiden, beide können
// schließen – und nach einem Neustart des Servers melden die Geräte ihre Tickets wieder an.
"use strict";
const assert = require("assert");
process.env.APP_TOKEN = "test-token";
process.env.KEEP_AWAKE = "0";
const { server, help } = require("./server.js");
let n = 0;
const ok = (m) => { n++; console.log("  ok  ", m); };

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, device = "geraet-sebastian-1", token = "test-token") => {
    const r = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-jarvis-token": token, "x-device": device },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, j: await r.json() };
  };
  try {
    // --- ohne App-Schlüssel nichts
    assert.equal((await call("/v1/help/open", undefined, "geraet-x-12345", "falsch")).status, 401); ok("ohne App-Schlüssel: 401");
    // --- Sebastian (Handy) erstellt ein Ticket
    let r = await call("/v1/help/create", { name: "Sebastian", reason: "phone", text: "WLAN geht nicht", platform: "phone" });
    assert.equal(r.status, 200); const t = r.j.ticket, sKey = r.j.key;
    assert.ok(t.id && sKey && t.status === "open" && !("ownerDevice" in t)); ok("Ticket erstellt (Schlüssel nur für Sebastian)");
    // --- alle sehen es, ohne Gerät/Schlüssel; das eigene ist markiert
    r = await call("/v1/help/open", undefined, "geraet-jona-0001");
    assert.equal(r.j.tickets.length, 1);
    assert.deepEqual(Object.keys(r.j.tickets[0]).sort(), ["createdAt", "id", "mine", "name", "platform", "reason", "text"]);
    assert.equal(r.j.tickets[0].mine, false); assert.equal((await call("/v1/help/open")).j.tickets[0].mine, true);
    ok("für alle sichtbar: Name, Grund, Text – keine Geräte, keine Schlüssel");
    // --- eigenes Ticket annehmen geht nicht; Jona nimmt an; Lea kommt zu spät
    assert.equal((await call("/v1/help/accept", { id: t.id, name: "Sebastian" })).status, 400);
    r = await call("/v1/help/accept", { id: t.id, name: "Jona" }, "geraet-jona-0001");
    assert.equal(r.status, 200); const jKey = r.j.key;
    assert.equal((await call("/v1/help/accept", { id: t.id, name: "Lea" }, "geraet-lea-00001")).status, 409);
    assert.equal((await call("/v1/help/open", undefined, "geraet-lea-00001")).j.tickets.length, 0);
    ok("Jona nimmt an – danach ist es aus der Liste, Lea bekommt „schon angenommen“");
    // --- Chat: nur die beiden; Lea mit falschem Schlüssel nicht
    assert.equal((await call("/v1/help/send", { id: t.id, key: sKey, text: "Hallo Jona, danke!", mid: "m1" })).status, 200);
    assert.equal((await call("/v1/help/send", { id: t.id, key: jKey, text: "Was genau geht nicht?", mid: "m2" }, "geraet-jona-0001")).status, 200);
    assert.equal((await call("/v1/help/send", { id: t.id, key: "geraten", text: "Ich bin auch da" }, "geraet-lea-00001")).status, 403);
    r = await call("/v1/help/sync", { items: [{ id: t.id, key: sKey, since: 0 }] });
    const it = r.j.items[0];
    assert.equal(it.role, "owner"); assert.equal(it.status, "taken"); assert.equal(it.helperName, "Jona");
    assert.deepEqual(it.msgs.map((m) => [m.from, m.text]), [["system", "Jona hat das Ticket angenommen."], ["owner", "Hallo Jona, danke!"], ["helper", "Was genau geht nicht?"]]);
    const since = it.msgs[1].at;
    r = await call("/v1/help/sync", { items: [{ id: t.id, key: jKey, since }] }, "geraet-jona-0001");
    assert.deepEqual(r.j.items[0].msgs.map((m) => m.text), ["Was genau geht nicht?"]);
    assert.equal((await call("/v1/help/sync", { items: [{ id: t.id, key: "falsch", since: 0 }] }, "geraet-lea-00001")).j.items[0].forbidden, true);
    ok("Chat nur für die beiden (seit-Abfrage, doppelte Nachricht zählt einmal)");
    assert.equal((await call("/v1/help/send", { id: t.id, key: sKey, text: "Hallo Jona, danke!", mid: "m1" })).j.mid, "m1");
    assert.equal(help.tickets.get(t.id).msgs.filter((m) => m.mid === "m1").length, 1);
    // --- nach einem Neustart: beide melden das Ticket wieder an, Nachrichten kommen zurück
    const sTicket = (await call("/v1/help/sync", { items: [{ id: t.id, key: sKey, since: 0 }] })).j.items[0];
    help._reset();
    assert.equal((await call("/v1/help/sync", { items: [{ id: t.id, key: sKey, since: 0 }] })).j.items[0].unknown, true);
    r = await call("/v1/help/restore", { id: t.id, key: sKey, role: "owner", ticket: sTicket, msgs: sTicket.msgs.filter((m) => m.from === "owner") });
    assert.equal(r.status, 200);
    r = await call("/v1/help/restore", { id: t.id, key: jKey, role: "helper", ticket: sTicket, msgs: [{ mid: "m2", from: "helper", text: "Was genau geht nicht?", at: since + 5 }] }, "geraet-jona-0001");
    assert.equal(r.status, 200);
    assert.equal((await call("/v1/help/restore", { id: t.id, key: "falsch", role: "owner", ticket: sTicket })).status, 403);
    r = await call("/v1/help/sync", { items: [{ id: t.id, key: jKey, since: 0 }] }, "geraet-jona-0001");
    assert.deepEqual(r.j.items[0].msgs.map((m) => m.text), ["Hallo Jona, danke!", "Was genau geht nicht?"]);
    ok("Server-Neustart: die Geräte melden das Ticket wieder an – Chat geht weiter, Fremde kommen nicht rein");
    // --- beide können schließen
    r = await call("/v1/help/close", { id: t.id, key: jKey }, "geraet-jona-0001");
    assert.equal(r.j.ticket.status, "closed"); assert.equal(r.j.ticket.closedBy, "helper");
    assert.equal((await call("/v1/help/send", { id: t.id, key: sKey, text: "noch was" })).status, 409);
    r = await call("/v1/help/sync", { items: [{ id: t.id, key: sKey, since: 0 }] });
    assert.equal(r.j.items[0].status, "closed"); assert.ok(r.j.items[0].msgs.some((m) => m.text === "Jona hat das Ticket geschlossen."));
    ok("Schließen geht für beide – danach keine Nachrichten mehr");
    // --- Grenzen: höchstens 3 offene pro Gerät, Name nötig, Text gekürzt
    for (let i = 0; i < 3; i++) assert.equal((await call("/v1/help/create", { name: "Ole", reason: "jarvis", text: "x".repeat(5000) }, "geraet-ole-00001")).status, 200);
    assert.equal((await call("/v1/help/create", { name: "Ole", reason: "jarvis" }, "geraet-ole-00001")).status, 429);
    assert.equal((await call("/v1/help/create", { name: "", reason: "jarvis" }, "geraet-ole-00002")).status, 400);
    assert.ok((await call("/v1/help/open")).j.tickets.every((x) => x.text.length <= 1500));
    ok("Grenzen: 3 offene Tickets pro Gerät, Name nötig, Text höchstens 1500 Zeichen");
    // --- Spam mit ausgedachten Geräten: höchstens 20 neue Tickets pro Anschluss und Tag
    help._reset();
    let made = 0, last;
    for (let i = 0; i < 30; i++) {
      last = await call("/v1/help/create", { name: "Spam", reason: "other" }, `geraet-spam-${String(i).padStart(4, "0")}`);
      if (last.status !== 200) break;
      made++;
    }
    assert.equal(last.status, 429); assert.ok(/Anschluss/.test(last.j.error), last.j.error); assert.equal(made, 20);
    ok("Spam-Schutz: höchstens 20 neue Tickets pro Anschluss und Tag");
    // --- ein unbekannter Grund wird „Etwas anderes“
    help._reset();
    r = await call("/v1/help/create", { name: "Mia", reason: "minecraft" }, "geraet-mia-00001");
    assert.equal(r.j.ticket.reason, "other");
    assert.equal((await call("/v1/help/create", { name: "Mia", reason: "scam" }, "geraet-mia-00001")).j.ticket.reason, "scam");
    ok("Gründe: nur die aus der Liste, sonst „Etwas anderes“");
    // --- falscher Weg
    assert.equal((await call("/v1/help/gibtsnicht", {})).status, 404);
    assert.equal((await call("/v1/help/create")).status, 405);
    ok("unbekannte Wege: 404, Lesen statt Schreiben: 405");
    console.log(`ALL OK (${n})`);
    process.exit(0);
  } catch (e) {
    console.error("FAIL", e);
    process.exit(1);
  }
})();
