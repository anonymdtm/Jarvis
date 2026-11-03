// Das Gespräch zu zweit (1.0.44 – der Nutzer, 3.11.2026: „oben auf Telefon klicken … und im Telefonat nochmal eine extra Anfrage
// für die Bildschirmfreigabe und Steuerung“). Eine WebSocket-Verbindung pro Seite eines angenommenen Hilfe-Tickets, solange ein
// Anruf läuft: Sprache, Bildschirmbilder und Steuer-Befehle gehen nur zur anderen Seite durch – nichts wird gespeichert oder
// angesehen. Ohne fremde Pakete (RFC 6455, nur was wir brauchen).

"use strict";
const crypto = require("crypto");
const EventEmitter = require("events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const LIMITS = {
  frame: 1_500_000,       // ein Bild darf so groß sein (Bytes)
  rooms: 200,             // so viele Gespräche gleichzeitig
  backlog: 1_500_000,     // staut sich bei der anderen Seite mehr, fallen Bilder weg (Sprache nicht)
  pingMs: 15_000,
};

class Ws extends EventEmitter {
  constructor(socket) {
    super();
    this.s = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.dead = false;
    this.alive = true;
    socket.setNoDelay(true);
    socket.on("data", (d) => this._data(d));
    socket.on("close", () => this._gone());
    socket.on("error", () => this._gone());
  }

  _data(d) {
    this.alive = true;                                          // (alles, was ankommt, zeigt: die Seite ist noch da)
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (!this.dead) {
      const f = this._frame();
      if (!f) break;
      this._handle(f);
    }
  }

  _frame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      if (b.readUInt32BE(2) !== 0) { this.close(1009); return null; }
      len = b.readUInt32BE(6); off = 10;
    }
    if (len > LIMITS.frame) { this.close(1009); return null; }
    if (!masked) { this.close(1002); return null; }          // (Geräte müssen maskieren)
    if (b.length < off + 4 + len) return null;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + 4 + len);
    return { fin, op, payload };
  }

  _handle({ fin, op, payload }) {
    if (op === 8) { this.close(1000); return; }
    if (op === 9) { this._send(10, payload); return; }
    if (op === 10) { this.alive = true; return; }
    if (op === 0) {
      if (!this.frag) return;
      this.frag.parts.push(payload);
      this.frag.size += payload.length;
      if (this.frag.size > LIMITS.frame) { this.close(1009); return; }
      if (fin) { const all = Buffer.concat(this.frag.parts), bin = this.frag.op === 2; this.frag = null; this.emit("message", all, bin); }
      return;
    }
    if (op === 1 || op === 2) {
      if (!fin) { this.frag = { op, parts: [payload], size: payload.length }; return; }
      this.emit("message", payload, op === 2);
    }
  }

  _send(op, data) {
    if (this.dead) return;
    const len = data.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    try { this.s.write(Buffer.concat([head, data])); } catch (e) { this._gone(); }
  }

  send(data, binary = Buffer.isBuffer(data)) { this._send(binary ? 2 : 1, Buffer.isBuffer(data) ? data : Buffer.from(String(data))); }

  /** Wie viel noch bei dieser Seite hängt (dann lieber ein Bild auslassen). */
  get backlog() { return this.s.writableLength || 0; }

  ping() { this._send(9, Buffer.alloc(0)); }

  close(code = 1000) {
    if (this.dead) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code);
    this._send(8, p);
    this.dead = true;
    try { this.s.end(); } catch (e) { /* */ }
    setTimeout(() => { try { this.s.destroy(); } catch (e) { /* */ } }, 2000).unref?.();
    this.emit("close");
  }

  _gone() {
    if (this.dead) return;
    this.dead = true;
    try { this.s.destroy(); } catch (e) { /* */ }
    this.emit("close");
  }
}

/** Gespräche: Ticket-ID → { owner: Ws, helper: Ws }. */
const rooms = new Map();

function other(role) { return role === "owner" ? "helper" : "owner"; }

function tell(ws, obj) { if (ws && !ws.dead) ws.send(JSON.stringify(obj), false); }

/**
 * Eine Seite verbindet sich: [help].liveCheck sagt, ob das Ticket einen laufenden Anruf hat und wer sie ist. Danach geht alles,
 * was sie schickt, an die andere Seite – Text (Steuer-Nachrichten) wie Binärdaten (Sprache, Bilder).
 */
function join(help, req, socket, head, ok) {
  const id = String(req.headers["x-help-id"] || "");
  const key = String(req.headers["x-help-key"] || "");
  let who;
  try {
    who = help.liveCheck(id, key);
  } catch (e) {
    const code = e.status || 400;
    socket.end(`HTTP/1.1 ${code} ${code === 403 ? "Forbidden" : code === 404 ? "Not Found" : "Conflict"}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n` +
      JSON.stringify({ error: e.message || "nicht erlaubt" }));
    return null;
  }
  if (!rooms.has(id) && rooms.size >= LIMITS.rooms) {
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    return null;
  }
  const wsKey = String(req.headers["sec-websocket-key"] || "");
  if (!wsKey || String(req.headers.upgrade || "").toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }
  const accept = crypto.createHash("sha1").update(wsKey + GUID).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  const ws = new Ws(socket);
  if (head && head.length) ws._data(head);
  const { role } = who;
  const room = rooms.get(id) || {};
  rooms.set(id, room);
  if (room[role] && !room[role].dead) room[role].close(4000);           // (neu verbunden – die alte Verbindung geht)
  room[role] = ws;
  const peer = room[other(role)];
  tell(ws, { t: "hello", role, peer: !!(peer && !peer.dead) });
  if (peer && !peer.dead) tell(peer, { t: "peer", on: true });
  ws.on("message", (data, binary) => {
    const p = room[other(role)];
    if (!p || p.dead) return;
    // Bilder (Typ 2) fallen weg, wenn sich bei der anderen Seite zu viel staut – Sprache (Typ 1) und Text nie
    if (binary && data[0] === 2 && p.backlog > LIMITS.backlog) return;
    p.send(data, binary);
  });
  ws.on("close", () => {
    if (room[role] === ws) delete room[role];
    const p = room[other(role)];
    if (p && !p.dead) tell(p, { t: "peer", on: false });
    if (!room.owner && !room.helper) rooms.delete(id);
  });
  if (ok) ok(ws, role);
  return ws;
}

/** Der Anruf ist zu Ende (aufgelegt, Ticket geschlossen): beide Verbindungen zu. */
function hangUp(id) {
  const room = rooms.get(id);
  if (!room) return;
  for (const r of ["owner", "helper"]) { tell(room[r], { t: "end" }); room[r]?.close(1000); }
  rooms.delete(id);
}

/** Alle paar Sekunden ein Ping – sonst schließen Zwischenstationen stille Verbindungen. */
const pinger = setInterval(() => {
  for (const room of rooms.values()) for (const r of ["owner", "helper"]) {
    const ws = room[r];
    if (!ws || ws.dead) continue;
    if (!ws.alive) { ws.close(1001); continue; }
    ws.alive = false;
    ws.ping();
  }
}, LIMITS.pingMs);
pinger.unref?.();

module.exports = { join, hangUp, rooms, Ws, LIMITS };
