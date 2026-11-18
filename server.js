'use strict';
/*
  SLBSTI institute website - server
  - Serves the website (public/index.html) and a small JSON API.
  - Stores data in PostgreSQL when DATABASE_URL is set (use this on Render).
  - Without DATABASE_URL it saves to ./data/store.json (only for running on your own computer).
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';
function findIndex() {
  const dirs = [__dirname, path.join(__dirname, 'public')];
  for (const d of dirs) { const f = path.join(d, 'index.html'); if (fs.existsSync(f)) return f; }
  for (const d of dirs) {
    try {
      const h = fs.readdirSync(d).filter((n) => /\.html?$/i.test(n)).sort();
      if (h.length) return path.join(d, h[0]);
    } catch (e) { /* folder missing */ }
  }
  return path.join(__dirname, 'index.html');
}

/* ---------- storage ---------- */
function fileStore(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* new file */ }
  let timer = null;
  function flush() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file + '.tmp', JSON.stringify(data));
        fs.renameSync(file + '.tmp', file);
      } catch (e) { console.error('Could not save data file:', e.message); }
    }, 40);
  }
  return {
    kind: 'file (' + file + ')',
    async init() {},
    async get(c, id) { return data[c] && data[c][id] ? structuredClone(data[c][id]) : null; },
    async all(c) { return Object.values(data[c] || {}).map((x) => structuredClone(x)); },
    async put(c, id, o) { (data[c] = data[c] || {})[id] = structuredClone(o); flush(); },
    async del(c, id) { if (data[c]) { delete data[c][id]; flush(); } },
  };
}

function pgStore(url) {
  const { Pool } = require('pg');
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  u.searchParams.delete('channel_binding');
  const host = u.hostname;
  // Render's internal address has no dot; external databases need SSL.
  const ssl = host.includes('.') && host !== 'localhost' ? { rejectUnauthorized: false } : false;
  const pool = new Pool({ connectionString: u.toString(), ssl, max: 5 });
  pool.on('error', (e) => console.error('Database error:', e.message));
  return {
    kind: 'PostgreSQL',
    async init() {
      await pool.query('CREATE TABLE IF NOT EXISTS docs (col text NOT NULL, id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY (col, id))');
    },
    async get(c, id) {
      const r = await pool.query('SELECT data FROM docs WHERE col = $1 AND id = $2', [c, id]);
      return r.rows[0] ? r.rows[0].data : null;
    },
    async all(c) {
      const r = await pool.query('SELECT data FROM docs WHERE col = $1 ORDER BY id', [c]);
      return r.rows.map((x) => x.data);
    },
    async put(c, id, o) {
      await pool.query(
        'INSERT INTO docs (col, id, data) VALUES ($1, $2, $3) ON CONFLICT (col, id) DO UPDATE SET data = EXCLUDED.data',
        [c, id, JSON.stringify(o)]
      );
    },
    async del(c, id) { await pool.query('DELETE FROM docs WHERE col = $1 AND id = $2', [c, id]); },
  };
}

const store = process.env.DATABASE_URL
  ? pgStore(process.env.DATABASE_URL)
  : fileStore(process.env.DATA_FILE || path.join(__dirname, 'data', 'store.json'));

/* one write at a time, so registration numbers never repeat */
let chain = Promise.resolve();
function locked(fn) {
  const p = chain.then(() => fn());
  chain = p.catch(() => {});
  return p;
}

/* ---------- passwords and login tokens ---------- */
async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 32);
  return 's1$' + salt.toString('hex') + '$' + h.toString('hex');
}
async function checkPw(pw, stored) {
  if (typeof stored !== 'string') return false;
  const [v, s, h] = stored.split('$');
  if (v !== 's1' || !s || !h) return false;
  const d = await scrypt(String(pw), Buffer.from(s, 'hex'), 32);
  const e = Buffer.from(h, 'hex');
  return d.length === e.length && crypto.timingSafeEqual(d, e);
}
let SECRET = '';
function sign(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
}
function verify(token) {
  if (typeof token !== 'string') return null;
  const [b, s] = token.split('.');
  if (!b || !s) return null;
  const e = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  if (e.length !== s.length || !crypto.timingSafeEqual(Buffer.from(e), Buffer.from(s))) return null;
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch (e2) { return null; }
}
function auth(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? verify(h.slice(7)) : null;
}

/* slow down password guessing: 8 wrong tries per 15 minutes per address */
const fails = new Map();
const WINDOW = 15 * 60 * 1000;
function who(req, role) {
  return role + ':' + ((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress);
}
function blocked(k) { const r = fails.get(k); return !!r && r.n >= 8 && Date.now() - r.t < WINDOW; }
function noteFail(k) {
  const r = fails.get(k);
  if (!r || Date.now() - r.t > WINDOW) fails.set(k, { n: 1, t: Date.now() });
  else r.n += 1;
}

/* ---------- settings and cleaning of input ---------- */
const DEF = {
  name: 'SLBSTI', tagline: 'Welcome to our institute', about: '', address: '', phone: '', email: '', hours: '',
  regFee: '', upi: '', payNote: '', accent: '#1D4ED8', regPrefix: 'SLB', adminUser: 'admin', adminHash: '',
};
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const dt = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
const num = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0; };

function publicCfg(c) {
  return {
    name: c.name, tagline: c.tagline, about: c.about, address: c.address, phone: c.phone, email: c.email,
    hours: c.hours, regFee: c.regFee, upi: c.upi, payNote: c.payNote, accent: c.accent,
  };
}
function adminCfg(c) { return Object.assign(publicCfg(c), { adminUser: c.adminUser, regPrefix: c.regPrefix }); }
async function getCfg() { return Object.assign({}, DEF, (await store.get('site', 'config')) || {}); }
async function getImg(kind) { const d = await store.get('site', kind); return d && d.data ? d.data : ''; }

function stripStudent(s, forStudent) {
  const o = Object.assign({}, s);
  delete o.pw;
  if (forStudent) delete o.notes;
  return o;
}
function cleanStudent(b) {
  const pays = Array.isArray(b.payments) ? b.payments.slice(0, 200) : [];
  return {
    name: str(b.name, 120), father: str(b.father, 120), dob: dt(b.dob),
    gender: ['Male', 'Female', 'Other'].includes(b.gender) ? b.gender : '',
    phone: str(b.phone, 30), email: str(b.email, 120), address: str(b.address, 400),
    course: str(b.course, 160), batch: str(b.batch, 40), admDate: dt(b.admDate),
    status: b.status === 'Inactive' ? 'Inactive' : 'Active', notes: str(b.notes, 1000),
    feeTotal: num(b.feeTotal, 1e7), regPaid: !!b.regPaid, regRef: str(b.regRef, 80), regDate: dt(b.regDate),
    payments: pays.map((p) => ({ d: dt(p && p.d), amt: num(p && p.amt, 1e7), note: str(p && p.note, 80) })),
  };
}
function cleanListing(b) {
  return {
    cat: str(b.cat, 40) || 'Other', title: str(b.title, 160), meta: str(b.meta, 120), date: dt(b.date),
    desc: str(b.desc, 1500), pub: b.pub !== false, ts: Number(b.ts) || Date.now(),
  };
}
async function nextRegNo(cfg) {
  const p = (cfg.regPrefix || 'SLB').replace(/[^A-Za-z0-9]/g, '') || 'SLB';
  const y = new Date().getFullYear();
  const re = new RegExp('^' + p + '-' + y + '-(\\d+)$');
  let m = 0;
  (await store.all('students')).forEach((s) => { const x = re.exec(s.id); if (x) m = Math.max(m, Number(x[1])); });
  return p + '-' + y + '-' + String(m + 1).padStart(3, '0');
}
const ID_RE = /^[A-Za-z0-9_-]{2,60}$/;

/* ---------- http helpers ---------- */
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function send(res, code, obj) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, HEADERS));
  res.end(JSON.stringify(obj));
}
function fail(status, message) { return Object.assign(new Error(message), { status }); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (d) => {
      n += d.length;
      if (n > 1000000) { reject(fail(413, 'That upload is too large.')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { reject(fail(400, 'Invalid request.')); }
    });
    req.on('error', reject);
  });
}
function serveIndex(req, res) {
  fs.readFile(findIndex(), (err, buf) => {
    if (err) { console.error('No .html website file found in', __dirname); res.writeHead(500); res.end('Website file missing'); return; }
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, HEADERS));
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

/* ---------- routes ---------- */
async function route(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  const m = req.method;

  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (!p.startsWith('/api/')) {
    if (m !== 'GET' && m !== 'HEAD') return send(res, 405, { error: 'Not allowed.' });
    return serveIndex(req, res);
  }

  if (m === 'GET' && p === '/api/public') {
    const [cfg, logo, qr, ls] = await Promise.all([getCfg(), getImg('logo'), getImg('qr'), store.all('listings')]);
    return send(res, 200, { cfg: publicCfg(cfg), logo, qr, listings: ls.filter((l) => l.pub !== false) });
  }

  if (m === 'POST' && (p === '/api/login/admin' || p === '/api/login/student')) {
    const role = p.endsWith('admin') ? 'admin' : 'student';
    const key = who(req, role);
    if (blocked(key)) throw fail(429, 'Too many wrong attempts. Please wait 15 minutes and try again.');
    const b = await readBody(req);
    const u = str(b.u, 80), pw = String(b.p == null ? '' : b.p).slice(0, 200);
    if (role === 'admin') {
      const cfg = await getCfg();
      if (!cfg.adminHash) throw fail(503, 'Admin password is not set on the server yet.');
      const ok = u.toLowerCase() === String(cfg.adminUser).toLowerCase() && (await checkPw(pw, cfg.adminHash));
      if (!ok) { noteFail(key); throw fail(401, 'Wrong username or password.'); }
      return send(res, 200, { token: sign({ r: 'admin', exp: Date.now() + 12 * 3600e3 }) });
    }
    const s = (await store.all('students')).find((x) => x.id.toLowerCase() === u.toLowerCase());
    if (!s) { noteFail(key); throw fail(401, 'Wrong registration number or password.'); }
    if (!(await checkPw(pw, s.pw))) { noteFail(key); throw fail(401, 'Wrong registration number or password.'); }
    if (s.status === 'Inactive') throw fail(403, 'This account is inactive. Please contact the office.');
    return send(res, 200, { token: sign({ r: 'student', id: s.id, exp: Date.now() + 12 * 3600e3 }), id: s.id });
  }

  const a = auth(req);

  if (m === 'GET' && p === '/api/student/me') {
    if (!a || a.r !== 'student') throw fail(401, 'Please log in.');
    const s = await store.get('students', a.id);
    if (!s || s.status === 'Inactive') throw fail(401, 'Please log in again.');
    return send(res, 200, { student: stripStudent(s, true) });
  }

  if (p.startsWith('/api/admin/')) {
    if (!a || a.r !== 'admin') throw fail(401, 'Please log in as admin.');

    if (m === 'GET' && p === '/api/admin/data') {
      const [cfg, students, listings] = await Promise.all([getCfg(), store.all('students'), store.all('listings')]);
      return send(res, 200, { cfg: adminCfg(cfg), students: students.map((s) => stripStudent(s)), listings });
    }

    if (m === 'PUT' && p === '/api/admin/student') {
      const b = await readBody(req);
      const sb = b.student || {};
      const out = await locked(async () => {
        const cfg = await getCfg();
        let old = null, id = sb.id ? String(sb.id) : '';
        if (id) {
          if (!ID_RE.test(id)) throw fail(400, 'Invalid registration number.');
          old = await store.get('students', id);
          if (!old) throw fail(404, 'Student not found.');
        } else id = await nextRegNo(cfg);
        const c = cleanStudent(sb);
        if (!c.name) throw fail(400, 'Enter the student name.');
        const s = Object.assign({}, old || {}, c, { id });
        const pw = b.password == null ? '' : String(b.password);
        if (pw) {
          if (pw.length < 4 || pw.length > 100) throw fail(400, 'Password must be at least 4 characters.');
          s.pw = await hashPw(pw);
        } else if (!old) throw fail(400, 'Set a password for the student.');
        await store.put('students', id, s);
        return stripStudent(s);
      });
      return send(res, 200, { student: out });
    }

    if (m === 'DELETE' && p.startsWith('/api/admin/student/')) {
      const id = decodeURIComponent(p.slice('/api/admin/student/'.length));
      if (!ID_RE.test(id)) throw fail(400, 'Invalid registration number.');
      await locked(() => store.del('students', id));
      return send(res, 200, { ok: true });
    }

    if (m === 'PUT' && p === '/api/admin/listing') {
      const b = await readBody(req);
      const out = await locked(async () => {
        let id = b.id ? String(b.id) : '';
        if (id && !ID_RE.test(id)) throw fail(400, 'Invalid listing.');
        const old = id ? await store.get('listings', id) : null;
        if (!id) id = 'l' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
        const c = cleanListing(Object.assign({}, b, { ts: old ? old.ts : Date.now() }));
        if (!c.title) throw fail(400, 'Enter a title.');
        const l = Object.assign({}, c, { id });
        await store.put('listings', id, l);
        return l;
      });
      return send(res, 200, { listing: out });
    }

    if (m === 'DELETE' && p.startsWith('/api/admin/listing/')) {
      const id = decodeURIComponent(p.slice('/api/admin/listing/'.length));
      if (!ID_RE.test(id)) throw fail(400, 'Invalid listing.');
      await locked(() => store.del('listings', id));
      return send(res, 200, { ok: true });
    }

    if (m === 'PUT' && p === '/api/admin/config') {
      const b = await readBody(req);
      const out = await locked(async () => {
        const cfg = await getCfg();
        ['name', 'tagline', 'about', 'address', 'phone', 'email', 'hours', 'upi', 'payNote'].forEach((k) => {
          if (b[k] !== undefined) cfg[k] = str(b[k], k === 'about' || k === 'payNote' ? 800 : 200);
        });
        if (b.regFee !== undefined) cfg.regFee = String(b.regFee) === '' ? '' : String(num(b.regFee, 1e7));
        if (b.accent !== undefined && /^#[0-9a-fA-F]{6}$/.test(b.accent)) cfg.accent = b.accent;
        if (b.regPrefix !== undefined) cfg.regPrefix = str(b.regPrefix, 8).replace(/[^A-Za-z0-9]/g, '') || 'SLB';
        if (!cfg.name) cfg.name = 'SLBSTI';
        const user = b.adminUser !== undefined ? str(b.adminUser, 40) : cfg.adminUser;
        const pass = b.adminPass ? String(b.adminPass) : '';
        if (user && user.toLowerCase() !== String(cfg.adminUser).toLowerCase() && !pass) throw fail(400, 'Enter a new password when you change the username.');
        if (pass) {
          if (pass.length < 6 || pass.length > 100) throw fail(400, 'Admin password must be at least 6 characters.');
          cfg.adminHash = await hashPw(pass);
        }
        if (user) cfg.adminUser = user;
        await store.put('site', 'config', cfg);
        return adminCfg(cfg);
      });
      return send(res, 200, { cfg: out });
    }

    if (m === 'PUT' && /^\/api\/admin\/image\/(logo|qr)$/.test(p)) {
      const kind = p.split('/').pop();
      const b = await readBody(req);
      const d = b.data == null ? '' : String(b.data);
      if (d && (d.length > 700000 || !/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(d))) throw fail(400, 'Please choose a smaller PNG or JPG image.');
      await locked(() => store.put('site', kind, { data: d }));
      return send(res, 200, { ok: true });
    }
  }

  throw fail(404, 'Not found.');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong on the server.' : e.message });
  });
});

/* ---------- start ---------- */
async function start() {
  await store.init();
  if (process.env.SESSION_SECRET) SECRET = process.env.SESSION_SECRET;
  else {
    let s = await store.get('site', 'secret');
    if (!s) { s = { v: crypto.randomBytes(32).toString('hex') }; await store.put('site', 'secret', s); }
    SECRET = s.v;
  }
  const cfg = await getCfg();
  if (!(await store.get('site', 'config'))) cfg.adminUser = process.env.ADMIN_USER || 'admin';
  const reset = process.env.RESET_ADMIN_PASSWORD;
  if (reset) {
    cfg.adminHash = await hashPw(reset);
    if (process.env.ADMIN_USER) cfg.adminUser = process.env.ADMIN_USER;
    console.log('Admin password was reset from RESET_ADMIN_PASSWORD. Remove that setting now.');
  } else if (!cfg.adminHash && process.env.ADMIN_PASSWORD) {
    cfg.adminHash = await hashPw(process.env.ADMIN_PASSWORD);
  } else if (!cfg.adminHash && !PROD) {
    cfg.adminHash = await hashPw('admin123');
    console.log('Local test mode: admin login is  admin / admin123');
  } else if (!cfg.adminHash) {
    console.error('ADMIN_PASSWORD is not set. Admin login is disabled until you set it.');
  }
  await store.put('site', 'config', cfg);
  server.listen(PORT, '0.0.0.0', () => console.log('SLBSTI running on port ' + PORT + ' using ' + store.kind));
}
process.on('unhandledRejection', (e) => console.error('Unhandled error:', e));
start().catch((e) => { console.error('Could not start:', e); process.exit(1); });
