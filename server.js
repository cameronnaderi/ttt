// DialTone standalone server. No dependencies: run with `node server.js` (Node 18 or newer).
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), dns = require('dns').promises, net = require('net');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'dialtone.json');
const PUBLIC = path.join(__dirname, 'public');
const UPLOADS = path.join(DATA_DIR, 'uploads');

/* ---------- storage: one JSON file, saved shortly after every change ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });
let store = { users: {}, docs: {} };
try { store = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') { console.error('Could not read ' + DB_FILE + ': ' + e.message); process.exit(1); } }
store.users = store.users || {}; store.docs = store.docs || {}; store.pics = store.pics || {};
let saveTimer = null;
function saveNow() { saveTimer = null; const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(store)); fs.renameSync(tmp, DB_FILE); }
function save() { if (!saveTimer) saveTimer = setTimeout(saveNow, 400); }
if (!Object.keys(store.docs).some(k => k.startsWith('rooms/'))) {
  for (const [id, name] of [['town-square', 'Town Square'], ['music-lounge', 'Music Lounge'], ['late-night', 'Late Night']]) store.docs['rooms/' + id] = { name, created: Date.now() };
  save();
}

const snKey = s => String(s).toLowerCase().replace(/\s+/g, '');
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const findUser = sn => Object.entries(store.users).find(([, u]) => u.key === snKey(sn));

/* ---------- admin commands ---------- */
const cmd = process.argv[2];
if (cmd === 'emails') { for (const u of Object.values(store.users)) console.log(u.sn + '\t' + u.email + '\t' + new Date(u.created).toISOString()); process.exit(0); }
if (cmd === 'reset') {
  const hit = findUser(process.argv[3] || ''), pw = process.argv[4] || '';
  if (!hit || pw.length < 6) { console.error('Usage: node server.js reset "Screen Name" newpassword   (6+ characters; stop the server first)'); process.exit(1); }
  hit[1].salt = crypto.randomBytes(16).toString('hex'); hit[1].hash = hashPw(pw, hit[1].salt); saveNow(); console.log('Password reset for ' + hit[1].sn); process.exit(0);
}

/* ---------- sessions and rate limits ---------- */
const tokens = new Map();           // token -> uid
const hits = new Map();             // "bucket:ip" -> {n, t}
function limited(bucket, ip, max, ms) { const k = bucket + ':' + ip, now = Date.now(); let h = hits.get(k); if (!h || now - h.t > ms) { h = { n: 0, t: now }; hits.set(k, h); } return ++h.n > max; }
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now - h.t > 600000) hits.delete(k); }, 60000).unref();

/* ---------- document rules ---------- */
function rule(p, uid) {
  const s = p.split('/');
  if (!/^[A-Za-z0-9_\-/]{1,200}$/.test(p) || s.some(x => !x)) return {};
  if (s[0] === 'accounts' && s.length === 2) return { read: true, write: uid && s[1] === uid ? 'profile' : false };
  if (s[0] === 'data' && s[1] === 'users' && s.length === 4) return { read: uid === s[2], write: uid === s[2] };
  if (s[0] === 'mailkeys' && s.length === 2) return { read: true, write: !!uid && uid === s[1] };
  if ((s[0] === 'mailout' || s[0] === 'mailpics') && s.length === 4 && s[2] === (s[0] === 'mailout' ? 'm' : 'p')) return { read: true, write: !!uid && uid === s[1] };
  if (s[0] === 'rooms' && s.length === 2) return { read: true, write: uid ? 'create' : false };
  if ((s[0] === 'guestbook' || s[0] === 'bposts' || s[0] === 'forums') && s.length === 2) return { read: true, write: !!uid && uid === s[1] };
  return {};
}
const PUBLIC_COLS = new Set(['accounts', 'rooms', 'forums', 'guestbook', 'bposts', 'mailkeys']);

/* ---------- realtime: server-sent events out, small POSTs in ---------- */
const conns = new Map();            // peer -> {peer, uid, res, rooms: Map(name -> presence), n, t}
const dirty = new Set();
function sendTo(c, obj) { try { c.res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) {} }
function members(room) { return [...conns.values()].filter(c => c.rooms.has(room)); }
function flushPeers() { for (const room of dirty) { const ms = members(room), peers = ms.map(c => ({ peer: c.peer, by: c.uid, presence: c.rooms.get(room) })); for (const c of ms) sendTo(c, { t: 'peers', room, peers }); } dirty.clear(); }
function touch(room) { if (!dirty.size) setImmediate(flushPeers); dirty.add(room); }
function broadcast(obj) { for (const c of conns.values()) sendTo(c, obj); }
setInterval(() => { for (const c of conns.values()) try { c.res.write(': ping\n\n'); } catch (e) {} }, 25000).unref();

function realtime(c, m) {
  const now = Date.now(); if (now - c.t > 1000) { c.t = now; c.n = 0; } if (++c.n > 30) return;
  const room = typeof m.room === 'string' ? m.room : '';
  if (room && !/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(room)) return;
  if (m.t === 'join') { if (c.rooms.size < 17 && !c.rooms.has(room)) { c.rooms.set(room, {}); touch(room); } }
  else if (m.t === 'leave') { if (room && c.rooms.delete(room)) touch(room); }
  else if (m.t === 'presence') { if (!c.rooms.has(room) || !m.patch || typeof m.patch !== 'object') return; const p = { ...c.rooms.get(room) }; for (const [k, v] of Object.entries(m.patch)) { if (v == null) delete p[k]; else p[k] = v; } if (JSON.stringify(p).length > 2000) return; c.rooms.set(room, p); touch(room); }
  else if (m.t === 'emit') {
    if (!c.rooms.has(room) || !['im', 'warn', 'chat', 'mail'].includes(m.topic)) return;
    const out = { t: 'msg', room, topic: m.topic, data: m.data, by: c.uid, peer: c.peer };
    if (m.topic === 'chat') { for (const x of members(room)) sendTo(x, out); return; }
    const to = m.data && m.data.to; if (typeof to !== 'string') return;      // IMs, warnings and mail alerts go only to the person addressed (and the sender's other windows)
    for (const x of conns.values()) if (x.uid === to || (x.uid === c.uid && x !== c)) sendTo(x, out);
  }
}

/* ---------- can a site be shown inside a window? ---------- */
const frameCache = new Map();
function privateIp(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  const x = ip.toLowerCase(); return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('::ffff:');
}
async function frameable(raw) {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    let u; try { u = new URL(url); } catch (e) { return { ok: false, reason: 'bad' }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'bad' };
    if (u.port && !['80', '443'].includes(u.port)) return { ok: false, reason: 'bad' };
    let addrs; try { addrs = await dns.lookup(u.hostname, { all: true }); } catch (e) { return { ok: false, reason: 'notfound' }; }
    if (!addrs.length || addrs.some(a => privateIp(a.address))) return { ok: false, reason: 'bad' };
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 7000);
    let r; try { r = await fetch(u, { redirect: 'manual', signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; DialTone WebSurfer frame check)', accept: 'text/html,*/*' } }); } catch (e) { clearTimeout(timer); return { ok: false, reason: 'unreachable' }; }
    clearTimeout(timer); try { r.body && r.body.cancel(); } catch (e) {}
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), u).href; continue; }
    if (r.headers.get('x-frame-options')) return { ok: false, reason: 'refused', url };
    const csp = r.headers.get('content-security-policy') || '', fa = /frame-ancestors([^;]*)/i.exec(csp);
    if (fa && !/(^|\s)(\*|https?:)(\s|$)/.test(fa[1])) return { ok: false, reason: 'refused', url };
    return { ok: true, url };
  }
  return { ok: false, reason: 'unreachable' };
}

/* ---------- http ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
function json(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(b); }
function body(req, max) { return new Promise((ok, bad) => { let n = 0; const parts = []; req.on('data', d => { n += d.length; if (n > max) { bad(new Error('too big')); req.destroy(); } else parts.push(d); }); req.on('end', () => { try { ok(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (e) { bad(e); } }); req.on('error', bad); }); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const auth = (req.headers.authorization || '').replace(/^Bearer /, '') || u.searchParams.get('token') || '', uid = tokens.get(auth) || null;
  try {
    if (u.pathname === '/api/register' && req.method === 'POST') {
      if (limited('reg', ip, 10, 3600000)) return json(res, 429, { error: 'Too many new accounts from this connection. Try again later.' });
      const b = await body(req, 4000), sn = String(b.sn || '').trim().replace(/\s+/g, ' '), email = String(b.email || '').trim(), pw = String(b.pw || '');
      if (!/^[A-Za-z][A-Za-z0-9 ]{2,15}$/.test(sn)) return json(res, 400, { error: 'Screen names are 3 to 16 characters, start with a letter, and use only letters, numbers and spaces.' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) return json(res, 400, { error: 'Enter a valid email address, like name@example.com.' });
      if (pw.length < 6 || pw.length > 64) return json(res, 400, { error: 'Passwords are 6 to 64 characters.' });
      if (findUser(sn)) return json(res, 409, { error: 'The screen name "' + sn + '" is already taken. Please choose another.' });
      const id = 'u' + crypto.randomBytes(6).toString('hex'), salt = crypto.randomBytes(16).toString('hex');
      store.users[id] = { sn, key: snKey(sn), email, salt, hash: hashPw(pw, salt), created: Date.now() };
      store.docs['accounts/' + id] = { sn, created: Date.now(), profile: '' }; save(); broadcast({ t: 'changed', col: 'accounts' });
      return json(res, 200, { ok: true, sn });
    }
    if (u.pathname === '/api/login' && req.method === 'POST') {
      if (limited('login', ip, 12, 60000)) return json(res, 429, { error: 'Too many sign-on attempts. Wait a minute and try again.' });
      const b = await body(req, 4000); let hit = findUser(b.sn || '');
      if (!hit) { const hnd = String(b.sn || '').trim().toLowerCase().replace(/@dialtone\.web$/, ''); const k = Object.keys(store.docs).find(k => k.startsWith('mailkeys/') && store.docs[k].handle === hnd); if (k && store.users[k.slice(9)]) hit = [k.slice(9), store.users[k.slice(9)]]; }
      if (!hit) return json(res, 404, { error: 'No account was found for that screen name. Press "Get a Screen Name" to create one before you sign on.' });
      const [id, usr] = hit, h = Buffer.from(hashPw(b.pw || '', usr.salt)), want = Buffer.from(usr.hash);
      if (h.length !== want.length || !crypto.timingSafeEqual(h, want)) return json(res, 401, { error: 'The password you entered is incorrect. Please try again.' });
      const token = crypto.randomBytes(24).toString('hex'); tokens.set(token, id);
      return json(res, 200, { token, uid: id, sn: usr.sn });
    }
    if (u.pathname === '/api/logout' && req.method === 'POST') { tokens.delete(auth); return json(res, 200, { ok: true }); }
    if (u.pathname === '/api/doc') {
      const p = u.searchParams.get('path') || '', r = rule(p, uid);
      if (req.method === 'GET') { if (!r.read) return json(res, 200, { exists: false }); const d = store.docs[p]; return json(res, 200, d ? { exists: true, data: d } : { exists: false }); }
      if (req.method === 'DELETE') { if (r.write !== true) return json(res, 403, { error: 'not allowed' }); delete store.docs[p]; save(); return json(res, 200, { ok: true }); }
      if (req.method === 'PUT') {
        if (!r.write) return json(res, 403, { error: 'not allowed' });
        const b = await body(req, 300000), data = b.data;
        if (!data || typeof data !== 'object' || Array.isArray(data)) return json(res, 400, { error: 'bad data' });
        if (r.write === 'profile') { store.docs[p] = { ...store.docs[p], profile: String(data.profile || '').slice(0, 600) }; broadcast({ t: 'changed', col: 'accounts' }); }
        else if (r.write === 'create') {
          const col = p.split('/')[0];
          if (!/^(rooms|forums)\/[a-z0-9][a-z0-9-]{1,39}$/.test(p)) return json(res, 400, { error: 'bad name' });
          if (!store.docs[p]) {
            if (Object.keys(store.docs).filter(k => k.startsWith(col + '/')).length >= (col === 'rooms' ? 200 : 50)) return json(res, 400, { error: 'There are too many already.' });
            store.docs[p] = { name: String(data.name || '').slice(0, 40), created: Date.now(), ...(col === 'forums' ? { desc: String(data.desc || '').slice(0, 100), by: uid } : {}) };
            if (col === 'rooms') broadcast({ t: 'changed', col: 'rooms' });
          }
        }
        else store.docs[p] = b.merge && store.docs[p] ? { ...store.docs[p], ...data } : data;
        save(); return json(res, 200, { ok: true });
      }
    }
    if (u.pathname === '/api/upload' && req.method === 'POST') {
      if (!uid) return json(res, 401, { error: 'Sign on to upload photos.' });
      if (limited('up', uid, 30, 3600000)) return json(res, 429, { error: 'You have uploaded a lot of photos. Try again in an hour.' });
      const parts = []; let n = 0, big = false;
      await new Promise((ok, bad) => { req.on('data', d => { n += d.length; if (n > 700000) big = true; else parts.push(d); }); req.on('end', ok); req.on('error', bad); });
      const buf = Buffer.concat(parts);
      if (big) return json(res, 413, { error: 'That photo is too large.' });
      if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return json(res, 400, { error: 'That file is not a picture DialTone can use.' });
      const id = crypto.randomBytes(12).toString('hex'); fs.writeFileSync(path.join(UPLOADS, id + '.jpg'), buf); store.pics[id] = uid; save();
      return json(res, 200, { id });
    }
    const del = /^\/api\/upload\/([a-f0-9]{24})$/.exec(u.pathname);
    if (del && req.method === 'DELETE') {
      if (!uid || store.pics[del[1]] !== uid) return json(res, 403, { error: 'not allowed' });
      delete store.pics[del[1]]; save(); fs.unlink(path.join(UPLOADS, del[1] + '.jpg'), () => {});
      return json(res, 200, { ok: true });
    }
    const up = /^\/uploads\/([a-f0-9]{24})\.jpg$/.exec(u.pathname);
    if (up && req.method === 'GET') {
      return fs.readFile(path.join(UPLOADS, up[1] + '.jpg'), (err, buf) => { if (err) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': 'image/jpeg', 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=31536000, immutable' }); res.end(buf); });
    }
    if (u.pathname === '/api/col' && req.method === 'GET') {
      const col = u.searchParams.get('path') || ''; if (!PUBLIC_COLS.has(col) && !/^mailout\/[A-Za-z0-9_-]+\/m$/.test(col)) return json(res, 200, { docs: [] });
      const pre = col + '/', docs = []; for (const k in store.docs) if (k.startsWith(pre) && !k.slice(pre.length).includes('/')) docs.push({ id: k.slice(pre.length), data: store.docs[k] });
      return json(res, 200, { docs });
    }
    if (u.pathname === '/api/events' && req.method === 'GET') {
      if (!uid) { res.writeHead(401); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const c = { peer: crypto.randomBytes(8).toString('hex'), uid, res, rooms: new Map([['', {}]]), n: 0, t: 0 };
      conns.set(c.peer, c); sendTo(c, { t: 'hello', peer: c.peer }); touch('');
      req.on('close', () => { conns.delete(c.peer); for (const r of c.rooms.keys()) touch(r); });
      return;
    }
    if (u.pathname === '/api/rt' && req.method === 'POST') {
      const b = await body(req, 8000), c = conns.get(b.peer);
      if (!uid || !c || c.uid !== uid) return json(res, 401, { error: 'signed off' });
      realtime(c, b); return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/frameable' && req.method === 'GET') {
      if (limited('frame', ip, 60, 60000)) return json(res, 429, { ok: false, reason: 'busy' });
      const target = (u.searchParams.get('url') || '').slice(0, 500), hit = frameCache.get(target);
      if (hit && Date.now() - hit.t < 600000) return json(res, 200, hit.v);
      const v = await frameable(target); if (frameCache.size > 2000) frameCache.clear(); frameCache.set(target, { t: Date.now(), v });
      return json(res, 200, v);
    }
    if (u.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    // static files
    let file = path.normalize(path.join(PUBLIC, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname)));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => { if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); } res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(buf); });
  } catch (e) { json(res, 400, { error: 'bad request' }); }
});
server.listen(PORT, () => console.log('DialTone is running at http://localhost:' + PORT));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (saveTimer) saveNow(); process.exit(0); });
