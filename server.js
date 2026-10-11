/* LowKey team relay - no dependencies.   node server.js   (PORT env, default 8787)
   Speaks the same poll format the game already uses, so dots / chat / SOS / players list all just work.
   POST /create  -> {tid, auth}          GET /poll?auth=..&tid=..&nick=..  -> JSON array of online teammates */
"use strict";
const http = require("http"), fs = require("fs"), crypto = require("crypto"), path = require("path");
const PORT = +process.env.PORT || 8787;
const FILE = process.env.TEAMS_FILE || path.join(__dirname, "teams.json");
const ALIVE_MS = 15000, MSG_MS = 9000, MAX_MEMBERS = 60, MAX_TEAMS = 5000;
const INVALID = "bClBzw7tTJPV6GQ6gqmVsk5MR5oEclR3T1HcUDJR5FXisgl8L8IYXdTX01ZeF3k9Jor0UpxHavkxb73DEDM0SNRf23v0WHKtgJDHv40lWfhIxipG3LOIX0ZEUOtvVSeH";
const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let teams = {};                       // tid -> {auth, created}
try { teams = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) {}
let dirty = false;
setInterval(() => { if (dirty) { dirty = false; fs.writeFile(FILE, JSON.stringify(teams), () => {}); } }, 5000).unref();

const live = {};                      // tid -> Map(nick -> entry)
const rnd = n => { let s = ""; const b = crypto.randomBytes(n); for (let i = 0; i < n; i++) s += ABC[b[i] % ABC.length]; return s; };
const eq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const num = v => { const n = Number(v); return v !== "" && Number.isFinite(n) ? n : v; };
const cut = (v, n) => String(v == null ? "" : v).slice(0, n);
// the game renders some fields as HTML -> neutralise markup from teammates (only <br> allowed in chat text)
const safe = (v, n) => cut(v, n).replace(/&(?!(amp|lt|gt|nbsp);)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/["']/g, "");
const safeMsg = v => cut(v, 400).replace(/<br>/g, "\u0001").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/["']/g, "").replace(/\u0001/g, "<br>");
const safeSrv = v => { v = cut(v, 80); return /^(_GAME_MENU_|[\w.:\-\[\]]*)$/.test(v) ? v : ""; };

const hits = {};                      // tiny per-ip limiter for /create
function limited(ip) { const t = Date.now(), h = (hits[ip] = (hits[ip] || []).filter(x => t - x < 60000)); if (h.length >= 10) return true; h.push(t); return false; }

function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Private-Network": "true", "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function poll(q, res) {
  const tid = cut(q.get("tid"), 64), auth = cut(q.get("auth"), 64), t = teams[tid];
  if (!t || !eq(t.auth, auth)) return send(res, 200, INVALID, "text/plain");
  const nick = cut(q.get("nick"), 40); if (!nick) return send(res, 400, { error: "nick" });
  const now = Date.now(), room = live[tid] || (live[tid] = new Map());
  for (const [k, m] of room) if (now - m.ts > ALIVE_MS) room.delete(k);
  let m = room.get(nick);
  if (!m) { if (room.size >= MAX_MEMBERS) return send(res, 200, []); m = { msg: "", msgTs: 0 }; room.set(nick, m); }
  const msg = safeMsg(q.get("msg"));
  if (msg) { m.msg = msg; m.msgTs = now; }
  else if (now - m.msgTs > MSG_MS) m.msg = "";
  Object.assign(m, {
    ts: now, nick, owner: cut(q.get("owner"), 32) || nick.slice(8),
    score: num(cut(q.get("score"), 12)), rank: num(cut(q.get("rank"), 8)) || 0,
    valx: num(cut(q.get("valx"), 14)), valy: num(cut(q.get("valy"), 14)),
    bot: cut(q.get("bot"), 6) || "false", sos: cut(q.get("sos"), 6) || "false", food: cut(q.get("food"), 6) || "false",
    an: cut(q.get("an"), 6) || "false", srv: safeSrv(q.get("srv")), sid: num(cut(q.get("sid"), 12)),
    ver: safe(q.get("ver"), 24), mmm: safe(q.get("mmm"), 60), cs: num(cut(q.get("cs"), 8)) || 0, tg: q.get("tg") === null || q.get("tg") === "" ? -1 : num(cut(q.get("tg"), 12)),
    dt: safe(q.get("dt"), 120), di: num(cut(q.get("di"), 6)) || 0, tar: safe(q.get("tar"), 60)
  });
  const out = [];
  for (const e of room.values()) out.push({
    nick: e.nick, owner: e.owner, sid: e.sid, srv: e.srv, ver: e.ver, msg: e.msg, score: e.score, rank: e.rank,
    bot: e.bot, sos: e.sos, food: e.food, an: e.an, mmm: e.mmm, valx: e.valx, valy: e.valy, cs: e.cs, tg: e.tg,
    dt: e.dt, di: e.di, tar: e.tar
  });
  send(res, 200, out);
}

http.createServer((req, res) => {
  let u; try { u = new URL(req.url, "http://x"); } catch (e) { return send(res, 400, { error: "url" }); }
  if (req.method === "OPTIONS") return send(res, 204, "");
  if (u.pathname === "/poll") return poll(u.searchParams, res);
  if (u.pathname === "/create" && (req.method === "POST" || req.method === "GET")) {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
    if (limited(ip)) return send(res, 429, { error: "slow down" });
    if (Object.keys(teams).length >= MAX_TEAMS) return send(res, 507, { error: "full" });
    let tid; do { tid = "LWK-" + rnd(16); } while (teams[tid]);
    const auth = rnd(20);
    teams[tid] = { auth, created: Date.now() }; dirty = true;
    return send(res, 200, { tid, auth });
  }
  if (u.pathname === "/" || u.pathname === "/health") return send(res, 200, { ok: true, teams: Object.keys(teams).length });
  send(res, 404, { error: "not found" });
}).listen(PORT, () => console.log("LowKey team server on :" + PORT));
