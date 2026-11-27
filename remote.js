// Den PC von unterwegs erreichen (1.10.0 – der Nutzer, 27.11.2026: „dass ich auch von außerhalb meinen PC steuern kann, wenn
// ich nicht zu Hause bin“). Ist das Handy nicht im Heim-WLAN, schickt es dieselbe Anfrage, die es sonst direkt an den PC
// schickt, hierher. Der PC holt sie ab – er fragt hier ständig nach, wie bei einem Briefkasten, darum muss am Router nichts
// eingestellt werden – und gibt seine Antwort zurück, die das Handy dann bekommt.
//
// Alles ist Ende-zu-Ende verschlüsselt (AES-GCM mit einem Schlüssel aus dem Kopplungs-Geheimnis von Handy und PC): der Server
// sieht nur eine Kennung (aus dem Geheimnis berechnet, ohne es verraten zu können), Größen und Zeiten – nie, was drinsteht.
// Er speichert nichts; wer die Kennung nicht kennt, erreicht keinen PC, und wer sie kennt, kann ohne das Geheimnis weder
// lesen noch einen Befehl schicken, den der PC annimmt.
//
// PC    → POST /v1/pc/wait   {"ids":["<32 hex>", …], "ms"}   ← 200 {"calls":[{"cid","id","box"}, …]} oder 204 (nach 25 s nichts;
//                                                                 "ms":0 = nur „ich bin da“, gleich zurück)
// PC    → POST /v1/pc/answer {"cid":"…","box":"<base64>"}   ← 200 {"ok":true} (404: das Handy wartet nicht mehr)
// Handy → POST /v1/pc/call   {"id":"…","box":"…","to":ms}   ← 200 {"box":"…"} · 503 {"error":"offline"} · 504 {"error":"timeout"}
"use strict";
const crypto = require("crypto");

const LIMITS = {
  ids: 8,                       // so viele gekoppelte Handys wartet ein PC höchstens gleichzeitig ab
  waitMs: 25_000,               // so lange bleibt die Abhol-Anfrage des PCs offen
  onlineMs: 70_000,             // so lange gilt ein PC nach seiner letzten Abhol-Anfrage als erreichbar
  callMs: 60_000,               // so lange wartet das Handy höchstens auf die Antwort
  queue: 30,                    // so viele Anfragen warten höchstens, bis der PC wieder abholt
  callBytes: 1_500_000,         // eine Anfrage vom Handy (Base64)
  answerBytes: 12_000_000,      // eine Antwort des PCs (ein Bildschirmbild, Base64)
  perMinute: 900,               // Anfragen pro Kennung und Minute (der Bildschirm holt ein paar Bilder pro Sekunde)
  bytesPerDay: 2_000_000_000,   // Daten pro Kennung und Tag (Render schenkt 100 GB im Monat – 2 GB am Tag lassen Luft)
  pcs: 5000,                    // so viele Kennungen merkt sich der Server höchstens
};

const okId = (id) => typeof id === "string" && /^[a-f0-9]{32}$/.test(id);
const okBox = (b, max) => typeof b === "string" && b.length >= 40 && b.length <= max && /^[A-Za-z0-9+/=]+$/.test(b);
const today = () => new Date().toISOString().slice(0, 10);

class Remote {
  constructor(limits = {}) {
    this.L = { ...LIMITS, ...limits };
    this.pcs = new Map();       // Kennung → { seen, waiter, queue:[call], minute:[Zeitpunkte], day, bytes }
    this.calls = new Map();     // cid → { res, timer, id, send }
  }

  _pc(id) {
    let p = this.pcs.get(id);
    if (!p) {
      if (this.pcs.size >= this.L.pcs) this._gc();
      p = { seen: 0, waiter: null, queue: [], minute: [], day: today(), bytes: 0 };
      this.pcs.set(id, p);
    }
    return p;
  }

  _gc() {
    const now = Date.now();
    for (const [id, p] of this.pcs) if (!p.waiter && !p.queue.length && now - p.seen > this.L.onlineMs) this.pcs.delete(id);
    if (this.pcs.size >= this.L.pcs) for (const [id, p] of this.pcs) { if (!p.waiter) this.pcs.delete(id); if (this.pcs.size < this.L.pcs * 0.9) break; }
  }

  online(id) {
    const p = this.pcs.get(id);
    return !!p && (!!p.waiter || Date.now() - p.seen < this.L.onlineMs);
  }

  /** Zählt Daten und Anfragen einer Kennung. → "" oder der Grund fürs Ablehnen. */
  _count(p, bytes, call) {
    const now = Date.now();
    if (p.day !== today()) { p.day = today(); p.bytes = 0; }
    if (call) {
      p.minute = p.minute.filter((t) => now - t < 60_000);
      if (p.minute.length >= this.L.perMinute) return "Zu viele Anfragen – bitte kurz warten.";
      p.minute.push(now);
    }
    if (p.bytes + bytes > this.L.bytesPerDay) return "Für heute ist die Leitung zum PC ausgeschöpft – morgen geht es wieder.";
    p.bytes += bytes;
    return "";
  }

  /** Der PC holt ab (send(code, obj) antwortet ihm). ms: wie lange höchstens (0 = nur „ich bin da“ – gleich zurück).
   *  Gibt die Aufräum-Funktion für „Verbindung weg“ zurück. */
  wait(ids, send, ms = this.L.waitMs) {
    const now = Date.now();
    const w = { ids, send, done: false, timer: null };
    const ready = [];
    for (const id of ids) {
      const p = this._pc(id);
      p.seen = now;
      if (p.waiter && p.waiter !== w) this._release(p.waiter, []);    // (dieselbe Kennung zweimal: der Neue gewinnt)
      p.waiter = w;
      for (const c of p.queue.splice(0)) if (this.calls.has(c.cid)) ready.push(c);    // (nur, wer noch wartet)
    }
    const hold = Math.max(0, Math.min(Number.isFinite(ms) ? ms : this.L.waitMs, this.L.waitMs));
    if (ready.length || hold === 0) this._release(w, ready);
    else w.timer = setTimeout(() => this._release(w, []), hold);
    return () => {
      if (w.done) return;
      w.done = true;
      clearTimeout(w.timer);
      for (const id of w.ids) { const p = this.pcs.get(id); if (p && p.waiter === w) { p.waiter = null; p.seen = Date.now(); } }
    };
  }

  _release(w, calls) {
    if (w.done) return false;
    w.done = true;
    clearTimeout(w.timer);
    for (const id of w.ids) { const p = this.pcs.get(id); if (p && p.waiter === w) { p.waiter = null; p.seen = Date.now(); } }
    w.send(calls.length ? 200 : 204, calls.length ? { calls } : null);
    return true;
  }

  /** Das Handy fragt den PC. send(code, obj) antwortet dem Handy (genau einmal). Gibt die Aufräum-Funktion zurück. */
  call(id, box, toMs, send) {
    if (!this.online(id)) { send(503, { error: "offline" }); return () => {}; }
    const p = this._pc(id);
    const why = this._count(p, box.length, true);
    if (why) { send(429, { error: why }); return () => {}; }
    if (!p.waiter && p.queue.length >= this.L.queue) { send(429, { error: "Der PC kommt gerade nicht hinterher – bitte kurz warten." }); return () => {}; }
    const cid = crypto.randomBytes(12).toString("hex");
    const wait = Math.max(1000, Math.min(Number(toMs) || 30_000, this.L.callMs)) + 5000;
    const entry = { id, send, timer: null };
    entry.timer = setTimeout(() => { if (this.calls.delete(cid)) send(504, { error: "timeout" }); }, wait);
    this.calls.set(cid, entry);
    const c = { cid, id, box };
    if (p.waiter) this._release(p.waiter, [c]);
    else p.queue.push(c);
    return () => { const e = this.calls.get(cid); if (e === entry) { clearTimeout(e.timer); this.calls.delete(cid); } };
  }

  /** Die Antwort des PCs. → true, wenn das Handy sie bekommen hat. */
  answer(cid, box) {
    const e = this.calls.get(cid);
    if (!e) return false;
    this.calls.delete(cid);
    clearTimeout(e.timer);
    const p = this.pcs.get(e.id);
    const why = p ? this._count(p, box.length, false) : "";
    if (why) { e.send(429, { error: why }); return true; }
    e.send(200, { box });
    return true;
  }

  stats() {
    let waiting = 0;
    for (const p of this.pcs.values()) if (p.waiter) waiting++;
    return { pcs: this.pcs.size, waiting, calls: this.calls.size };
  }
}

module.exports = { Remote, LIMITS, okId, okBox };
