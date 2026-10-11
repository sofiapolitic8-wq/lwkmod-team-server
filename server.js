// LWKMOD Team Server - zero dependencies (only Node.js 16+ needed)
// Run:  node server.js        (PORT env var optional, default 8787)
"use strict";
const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 8787;
const MAX_MEMBERS = 50;
const MAX_FRAME = 64 * 1024;
const EMPTY_TEAM_TTL = 30 * 60 * 1000;
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion

const teams = new Map(); // id -> {id, auth, owner, members:Map(pid->{ws,name,server}), emptySince}
const failBook = new Map(); // ip -> {n, t}

function rnd(len) {
  const b = crypto.randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHA[b[i] % ALPHA.length];
  return s;
}
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);

// ---------- minimal RFC6455 ----------
function accept(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  const h = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + h + "\r\n\r\n");
  const ws = { socket, buf: Buffer.alloc(0), alive: true, ip: (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(), team: null, pid: null, lastChat: [], onmessage: null };
  socket.on("data", (d) => {
    ws.buf = Buffer.concat([ws.buf, d]);
    try { parse(ws); } catch (e) { socket.destroy(); }
  });
  socket.on("close", () => onClose(ws));
  socket.on("error", () => socket.destroy());
  return ws;
}
function frame(opcode, payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let h;
  if (p.length < 126) h = Buffer.from([0x80 | opcode, p.length]);
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | opcode; h[1] = 126; h.writeUInt16BE(p.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
  return Buffer.concat([h, p]);
}
function send(ws, obj) { if (!ws.socket.destroyed) ws.socket.write(frame(1, JSON.stringify(obj))); }
function parse(ws) {
  for (;;) {
    const b = ws.buf;
    if (b.length < 2) return;
    const opcode = b[0] & 15, masked = (b[1] & 128) !== 0;
    let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > MAX_FRAME || !masked) return ws.socket.destroy();
    if (b.length < off + 4 + len) return;
    const mask = b.slice(off, off + 4);
    const data = Buffer.from(b.slice(off + 4, off + 4 + len));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    ws.buf = b.slice(off + 4 + len);
    if (opcode === 8) { ws.socket.end(frame(8, Buffer.alloc(0))); return; }
    if (opcode === 9) ws.socket.write(frame(10, data));
    else if (opcode === 10) ws.alive = true;
    else if (opcode === 1) { ws.alive = true; handle(ws, data.toString("utf8")); }
  }
}

// ---------- team logic ----------
const pub = (m) => ({ pid: m.pid, name: m.name, server: m.server });
function members(t) { return [...t.members.values()].map(pub); }
function broadcast(t, obj, except) {
  for (const m of t.members.values()) if (m.ws !== except) send(m.ws, obj);
}
function tooManyFails(ws) {
  const r = failBook.get(ws.ip);
  return r && Date.now() - r.t < 60000 && r.n >= 6;
}
function noteFail(ws) {
  const r = failBook.get(ws.ip);
  if (!r || Date.now() - r.t >= 60000) failBook.set(ws.ip, { n: 1, t: Date.now() });
  else r.n++;
}
function leave(ws) {
  const t = ws.team && teams.get(ws.team);
  if (t && ws.pid && t.members.get(ws.pid) && t.members.get(ws.pid).ws === ws) {
    t.members.delete(ws.pid);
    broadcast(t, { type: "member_leave", pid: ws.pid });
    if (t.owner === ws.pid) {
      const next = t.members.keys().next().value;
      t.owner = next || null;
      if (next) broadcast(t, { type: "owner", pid: next });
    }
    if (!t.members.size) t.emptySince = Date.now();
  }
  ws.team = null;
}
function enter(ws, t, m) {
  leave(ws);
  const old = t.members.get(m.pid);
  if (old && old.ws !== ws) { try { old.ws.socket.destroy(); } catch (e) {} }
  const isNew = !old;
  t.members.set(m.pid, { ws, pid: m.pid, name: m.name, server: m.server });
  t.emptySince = 0;
  if (!t.owner || !t.members.has(t.owner)) t.owner = m.pid;
  ws.team = t.id; ws.pid = m.pid;
  send(ws, { type: "joined", team: t.id, auth: t.auth, owner: t.owner, pid: m.pid, members: members(t) });
  broadcast(t, { type: isNew ? "member_join" : "member_update", member: { pid: m.pid, name: m.name, server: m.server } }, ws);
}
function ident(msg) {
  const pid = clean(msg.pid, 16).replace(/[^A-Za-z0-9_-]/g, "");
  return { pid: pid || "P" + rnd(5), name: clean(msg.name, 18) || "Player", server: clean(msg.server, 60) || "unknown" };
}
function handle(ws, text) {
  let msg;
  try { msg = JSON.parse(text); } catch (e) { return; }
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "create") {
    if (tooManyFails(ws)) return send(ws, { type: "error", message: "Too many attempts, wait a minute" });
    if (teams.size > 5000) return send(ws, { type: "error", message: "Server busy" });
    let id; do { id = rnd(6); } while (teams.has(id));
    const t = { id, auth: rnd(10), owner: null, members: new Map(), emptySince: Date.now() };
    teams.set(id, t);
    enter(ws, t, ident(msg));
  } else if (msg.type === "join") {
    if (tooManyFails(ws)) return send(ws, { type: "error", message: "Too many wrong attempts, wait a minute" });
    const t = teams.get(String(msg.team || "").toUpperCase().trim());
    if (!t || !safeEq(t.auth, String(msg.auth || "").toUpperCase().trim())) {
      noteFail(ws);
      return send(ws, { type: "error", code: "bad_auth", message: "Wrong Team ID or Auth Key" });
    }
    const m = ident(msg);
    if (!t.members.has(m.pid) && t.members.size >= MAX_MEMBERS) return send(ws, { type: "error", message: "Team is full" });
    enter(ws, t, m);
  } else if (msg.type === "update") {
    const t = ws.team && teams.get(ws.team);
    if (!t || !t.members.has(ws.pid)) return;
    const m = t.members.get(ws.pid), n = ident(Object.assign({}, msg, { pid: ws.pid }));
    if (n.name !== m.name || n.server !== m.server) {
      m.name = n.name; m.server = n.server;
      broadcast(t, { type: "member_update", member: pub(m) }, ws);
    }
  } else if (msg.type === "chat") {
    const t = ws.team && teams.get(ws.team);
    const text = clean(msg.message, 180);
    if (!t || !text) return;
    const now = Date.now();
    ws.lastChat = ws.lastChat.filter((x) => now - x < 5000);
    if (ws.lastChat.length >= 8) return send(ws, { type: "error", message: "Slow down" });
    ws.lastChat.push(now);
    const m = t.members.get(ws.pid);
    broadcast(t, { type: "chat", pid: ws.pid, name: m ? m.name : "Player", message: text, ts: now });
  } else if (msg.type === "leave") {
    leave(ws);
    send(ws, { type: "left" });
  }
}
function onClose(ws) { leave(ws); }

// ---------- http + upgrade ----------
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("LWKMOD Team Server OK - teams: " + teams.size + "\n");
});
const sockets = new Set();
server.on("upgrade", (req, socket) => {
  const ws = accept(req, socket);
  if (ws) sockets.add(ws), socket.on("close", () => sockets.delete(ws));
});
setInterval(() => {
  for (const ws of sockets) {
    if (!ws.alive) { ws.socket.destroy(); continue; }
    ws.alive = false;
    try { ws.socket.write(frame(9, Buffer.alloc(0))); } catch (e) {}
  }
  const now = Date.now();
  for (const [id, t] of teams) if (!t.members.size && t.emptySince && now - t.emptySince > EMPTY_TEAM_TTL) teams.delete(id);
  for (const [ip, r] of failBook) if (now - r.t > 60000) failBook.delete(ip);
}, 25000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log("LWKMOD Team Server listening on :" + PORT));
}
module.exports = { server, teams };
