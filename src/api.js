// Soạn Đề Kiểm Tra Giáo Lý — API chạy trên Cloudflare Workers
// Ràng buộc cần có: D1 database tên biến "DB"; secret "ANTHROPIC_API_KEY".
// Biến tuỳ chọn: CLAUDE_MODEL (mặc định claude-sonnet-5-5), CLAUDE_DAILY_LIMIT (mặc định 60 lượt/người/ngày).

const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const FIELD = /^[A-Za-z0-9_]{1,64}$/;
const ROLES = ['admin', 'glv', 'viewer'];
const SESSION_DAYS = 30;
let ready = false;

async function init(db) {
  if (ready) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, pass TEXT NOT NULL, created INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS docs (coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (coll, id))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS usage (user_id TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (user_id, day))`),
  ]);
  ready = true;
}

/* ---------- helpers ---------- */
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const fail = (status, error) => json({ error }, status);
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function rid(prefix = '', n = 24) {
  const a = crypto.getRandomValues(new Uint8Array(n));
  return prefix + Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}
async function hashPass(pw, saltB64) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return b64(salt) + '.' + b64(bits);
}
async function checkPass(pw, stored) {
  const [salt] = stored.split('.');
  const h = await hashPass(pw, salt);
  if (h.length !== stored.length) return false;
  let d = 0;
  for (let i = 0; i < h.length; i++) d |= h.charCodeAt(i) ^ stored.charCodeAt(i);
  return d === 0;
}
const pub = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role });
function cookie(req, name) {
  const c = req.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
function sessionCookie(req, id, maxAge) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `sid=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
async function startSession(env, req, user) {
  const id = rid('s_', 40);
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires) VALUES (?, ?, ?)').bind(id, user.id, Date.now() + SESSION_DAYS * 864e5).run();
  return json({ user: pub(user) }, 200, { 'set-cookie': sessionCookie(req, id, SESSION_DAYS * 86400) });
}
async function currentUser(env, req) {
  const sid = cookie(req, 'sid');
  if (!sid) return null;
  return env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires > ?').bind(sid, Date.now()).first();
}
function splitPath(path, wantDoc) {
  if (typeof path !== 'string') return null;
  const segs = path.split('/');
  if (!segs.every((s) => SEG.test(s) && s !== '.' && s !== '..')) return null;
  if (wantDoc && segs.length % 2 !== 0) return null;
  if (!wantDoc && segs.length % 2 !== 1) return null;
  return wantDoc ? { coll: segs.slice(0, -1).join('/'), id: segs[segs.length - 1] } : { coll: path };
}
function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? merge(out[k], v) : v;
  }
  return out;
}
async function readBody(req) {
  try { const b = await req.json(); return b && typeof b === 'object' && !Array.isArray(b) ? b : null; } catch { return null; }
}

/* ---------- access rules ---------- */
// viewer: chỉ đọc. glv: ghi lớp, giáo trình, đề của mình. admin: ghi mọi thứ, duyệt đề, cài đặt.
function canWrite(u, coll, existing) {
  if (!u || u.role === 'viewer') return false;
  if (u.role === 'admin') return true;
  if (coll === 'settings' || coll === 'approvals') return false;
  if (coll === 'exams' && existing && existing.creatorId && existing.creatorId !== u.id) return false;
  return true;
}

/* ---------- handler ---------- */
export async function onRequest(ctx) {
  const { request: req, env, params } = ctx;
  try {
    if (!env.DB) return fail(500, 'Chưa gắn cơ sở dữ liệu D1 với tên biến DB.');
    await init(env.DB);
    const parts = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
    const route = '/' + parts.join('/');
    const m = req.method;
    const url = new URL(req.url);
    if (m !== 'GET' && !(req.headers.get('content-type') || '').includes('application/json')) return fail(415, 'Yêu cầu không hợp lệ.');

    /* ---- auth ---- */
    if (route === '/me' && m === 'GET') {
      const u = await currentUser(env, req);
      if (u) return json({ user: pub(u), claude: !!env.ANTHROPIC_API_KEY });
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
      return json({ needsSetup: c.n === 0, guest: c.n === 0 ? null : await guestPolicy(env) }, 401);
    }
    if (route === '/setup' && m === 'POST') {
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
      if (c.n > 0) return fail(403, 'Hệ thống đã có tài khoản quản trị.');
      const b = await readBody(req);
      const err = validateUser(b, true);
      if (err) return fail(400, err);
      const user = { id: rid('u_', 22), username: b.username.toLowerCase(), name: b.name.trim(), role: 'admin' };
      await env.DB.prepare('INSERT INTO users (id, username, name, role, pass, created) VALUES (?, ?, ?, ?, ?, ?)').bind(user.id, user.username, user.name, user.role, await hashPass(b.password), Date.now()).run();
      return startSession(env, req, user);
    }
    if (route === '/login' && m === 'POST') {
      const b = await readBody(req);
      if (!b?.username || !b?.password) return fail(400, 'Nhập tên đăng nhập và mật khẩu.');
      const u = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(String(b.username).toLowerCase().trim()).first();
      if (!u || !(await checkPass(String(b.password), u.pass))) {
        await new Promise((r) => setTimeout(r, 600));
        return fail(401, 'Sai tên đăng nhập hoặc mật khẩu.');
      }
      await env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(Date.now()).run();
      return startSession(env, req, u);
    }
    if (route === '/logout' && m === 'POST') {
      const sid = cookie(req, 'sid');
      if (sid) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, '', 0) });
    }

    const u = await currentUser(env, req);
    if (!u) {
      // Khách (không đăng nhập): chỉ đọc, theo chính sách trong Cài đặt
      const pol = await guestPolicy(env);
      if (pol.on && route === '/versions' && m === 'POST') {
        const b = await readBody(req);
        const colls = (Array.isArray(b?.colls) ? b.colls : []).filter((c) => splitPath(c, false)).slice(0, 30);
        const versions = Object.fromEntries(colls.map((c) => [c, '0:0']));
        const ok = colls.filter((c) => guestColl(c, pol));
        if (ok.length) {
          const r = await env.DB.prepare(`SELECT coll, COUNT(*) AS n, MAX(updated) AS u FROM docs WHERE coll IN (${ok.map(() => '?').join(',')}) GROUP BY coll`).bind(...ok).all();
          for (const row of r.results) versions[row.coll] = row.n + ':' + row.u;
          if (ok.includes('exams')) { const a = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(updated) AS u FROM docs WHERE coll='approvals'").first(); versions.exams += '|' + a.n + ':' + a.u; }
        }
        return json({ versions });
      }
      if (pol.on && route === '/docs' && m === 'GET') {
        const p = splitPath(url.searchParams.get('coll'), false);
        if (!p) return fail(400, 'Đường dẫn không hợp lệ.');
        if (!guestColl(p.coll, pol)) return json({ docs: [], version: '0:0' });
        const r = await env.DB.prepare('SELECT id, data FROM docs WHERE coll = ? ORDER BY updated DESC LIMIT 1000').bind(p.coll).all();
        let docs = r.results.map((x) => ({ id: x.id, data: JSON.parse(x.data) }));
        if (p.coll === 'exams') {
          const ap = await approvedMap(env);
          docs = docs.filter((d) => ap[d.id] === d.data.version).map((d) => ({ id: d.id, data: pol.answers ? d.data : stripAnswers(d.data) }));
        }
        return json({ docs, version: 'guest' });
      }
      if (pol.on && route === '/doc' && m === 'GET') {
        const p = splitPath(url.searchParams.get('path'), true);
        if (!p) return fail(400, 'Đường dẫn không hợp lệ.');
        if (!guestColl(p.coll, pol)) return json({ data: null });
        const row = await env.DB.prepare('SELECT data FROM docs WHERE coll = ? AND id = ?').bind(p.coll, p.id).first();
        let data = row ? JSON.parse(row.data) : null;
        if (data && p.coll === 'exams') { const ap = await approvedMap(env); data = ap[p.id] === data.version ? (pol.answers ? data : stripAnswers(data)) : null; }
        return json({ data });
      }
      return fail(401, 'Vui lòng đăng nhập để thực hiện thao tác này.');
    }

    if (route === '/password' && m === 'POST') {
      const b = await readBody(req);
      if (!b || !(await checkPass(String(b.old || ''), u.pass))) return fail(400, 'Mật khẩu hiện tại không đúng.');
      if (String(b.new || '').length < 8) return fail(400, 'Mật khẩu mới cần ít nhất 8 ký tự.');
      await env.DB.prepare('UPDATE users SET pass = ? WHERE id = ?').bind(await hashPass(String(b.new)), u.id).run();
      return json({ ok: true });
    }

    /* ---- user management (admin) ---- */
    if (route === '/users' || route.startsWith('/users/')) {
      if (u.role !== 'admin') return fail(403, 'Chỉ quản trị được quản lý tài khoản.');
      const id = parts[1];
      if (!id && m === 'GET') {
        const r = await env.DB.prepare('SELECT id, username, name, role, created FROM users ORDER BY name').all();
        return json({ users: r.results });
      }
      if (!id && m === 'POST') {
        const b = await readBody(req);
        const err = validateUser(b, true);
        if (err) return fail(400, err);
        if (!ROLES.includes(b.role)) return fail(400, 'Vai trò không hợp lệ.');
        const exists = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(b.username.toLowerCase()).first();
        if (exists) return fail(409, 'Tên đăng nhập đã có người dùng.');
        const nu = { id: rid('u_', 22), username: b.username.toLowerCase(), name: b.name.trim(), role: b.role };
        await env.DB.prepare('INSERT INTO users (id, username, name, role, pass, created) VALUES (?, ?, ?, ?, ?, ?)').bind(nu.id, nu.username, nu.name, nu.role, await hashPass(b.password), Date.now()).run();
        return json({ user: nu });
      }
      if (id && m === 'PATCH') {
        const b = await readBody(req);
        if (!b) return fail(400, 'Thiếu dữ liệu.');
        const t = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
        if (!t) return fail(404, 'Không tìm thấy tài khoản.');
        if (b.role !== undefined) {
          if (!ROLES.includes(b.role)) return fail(400, 'Vai trò không hợp lệ.');
          if (t.id === u.id && b.role !== 'admin') return fail(400, 'Không thể tự hạ quyền quản trị của chính mình.');
          await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(b.role, id).run();
        }
        if (b.name !== undefined && String(b.name).trim()) await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(String(b.name).trim(), id).run();
        if (b.password !== undefined) {
          if (String(b.password).length < 8) return fail(400, 'Mật khẩu cần ít nhất 8 ký tự.');
          await env.DB.batch([
            env.DB.prepare('UPDATE users SET pass = ? WHERE id = ?').bind(await hashPass(String(b.password)), id),
            env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
          ]);
        }
        return json({ ok: true });
      }
      if (id && m === 'DELETE') {
        if (id === u.id) return fail(400, 'Không thể xoá tài khoản của chính mình.');
        await env.DB.batch([
          env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
          env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
        ]);
        return json({ ok: true });
      }
      return fail(405, 'Không hỗ trợ.');
    }
    if (route === '/people' && m === 'GET') {
      const r = await env.DB.prepare('SELECT id, name FROM users').all();
      return json({ people: r.results });
    }

    /* ---- document store ---- */
    if (route === '/versions' && m === 'POST') {
      const b = await readBody(req);
      const colls = (Array.isArray(b?.colls) ? b.colls : []).filter((c) => splitPath(c, false)).slice(0, 30);
      if (!colls.length) return json({ versions: {} });
      const r = await env.DB.prepare(`SELECT coll, COUNT(*) AS n, MAX(updated) AS u FROM docs WHERE coll IN (${colls.map(() => '?').join(',')}) GROUP BY coll`).bind(...colls).all();
      const versions = Object.fromEntries(colls.map((c) => [c, '0:0']));
      for (const row of r.results) versions[row.coll] = row.n + ':' + row.u;
      return json({ versions });
    }
    if (route === '/docs' && m === 'GET') {
      const p = splitPath(url.searchParams.get('coll'), false);
      if (!p) return fail(400, 'Đường dẫn không hợp lệ.');
      const order = url.searchParams.get('orderBy');
      const dir = url.searchParams.get('dir') === 'desc' ? 'DESC' : 'ASC';
      const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '1000', 10)));
      let sql = 'SELECT id, data FROM docs WHERE coll = ?';
      if (order) {
        if (!FIELD.test(order)) return fail(400, 'Trường sắp xếp không hợp lệ.');
        sql += ` ORDER BY json_extract(data, '$.${order}') ${dir}`;
      } else sql += ' ORDER BY id';
      sql += ' LIMIT ?';
      const r = await env.DB.prepare(sql).bind(p.coll, limit).all();
      const v = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(updated) AS u FROM docs WHERE coll = ?').bind(p.coll).first();
      return json({ docs: r.results.map((x) => ({ id: x.id, data: JSON.parse(x.data) })), version: (v.n || 0) + ':' + (v.u || 0) });
    }
    if (route === '/doc') {
      const p = splitPath(url.searchParams.get('path'), true);
      if (!p) return fail(400, 'Đường dẫn không hợp lệ.');
      const row = await env.DB.prepare('SELECT data FROM docs WHERE coll = ? AND id = ?').bind(p.coll, p.id).first();
      const existing = row ? JSON.parse(row.data) : null;
      if (m === 'GET') return json({ data: existing });
      if (!canWrite(u, p.coll, existing)) return fail(403, 'Bạn không có quyền thực hiện thao tác này.');
      const now = Date.now();
      if (m === 'DELETE') {
        await env.DB.prepare('DELETE FROM docs WHERE coll = ? AND id = ?').bind(p.coll, p.id).run();
        return json({ ok: true });
      }
      const b = await readBody(req);
      if (!b) return fail(400, 'Dữ liệu phải là một đối tượng JSON.');
      let data;
      if (m === 'PUT') data = b;
      else if (m === 'PATCH') { if (!existing) return fail(404, 'Tài liệu không tồn tại.'); data = merge(existing, b); }
      else return fail(405, 'Không hỗ trợ.');
      if (p.coll === 'exams' && u.role !== 'admin') data.creatorId = existing?.creatorId || u.id;
      const text = JSON.stringify(data);
      if (text.length > 900000) return fail(413, 'Dữ liệu quá lớn.');
      await env.DB.prepare('INSERT INTO docs (coll, id, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT (coll, id) DO UPDATE SET data = excluded.data, updated = excluded.updated').bind(p.coll, p.id, text, now).run();
      return json({ ok: true });
    }

    /* ---- Claude ---- */
    if (route === '/claude' && m === 'POST') {
      if (u.role === 'viewer') return fail(403, 'Tài khoản chỉ xem không dùng được Claude.');
      if (!env.ANTHROPIC_API_KEY) return fail(503, 'Quản trị chưa cài khoá API Claude (ANTHROPIC_API_KEY).');
      const b = await readBody(req);
      const prompt = String(b?.prompt || '');
      if (!prompt) return fail(400, 'Thiếu nội dung yêu cầu.');
      if (prompt.length > 400000) return fail(413, 'Giáo trình quá dài.');
      const day = new Date().toISOString().slice(0, 10);
      const cap = parseInt(env.CLAUDE_DAILY_LIMIT || '60', 10);
      const used = await env.DB.prepare('INSERT INTO usage (user_id, day, n) VALUES (?, ?, 1) ON CONFLICT (user_id, day) DO UPDATE SET n = n + 1 RETURNING n').bind(u.id, day).first();
      if (used.n > cap) return fail(429, `Bạn đã dùng hết ${cap} lượt Claude hôm nay.`);
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: parseInt(env.CLAUDE_MAX_TOKENS || '16000', 10), stream: true, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!r.ok) {
        const t = await r.text();
        return json({ error: 'Claude báo lỗi ' + r.status, detail: t.slice(0, 400) }, r.status === 429 || r.status === 529 ? 429 : 502);
      }
      return new Response(r.body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } });
    }

    return fail(404, 'Không tìm thấy.');
  } catch (e) {
    return fail(500, 'Lỗi máy chủ: ' + (e?.message || e));
  }
}

/* ---------- chế độ khách ---------- */
async function guestPolicy(env) {
  const r = await env.DB.prepare("SELECT data FROM docs WHERE coll = 'settings' AND id = 'general'").first();
  const s = r ? JSON.parse(r.data) : {};
  return { on: s.guestView !== false, exams: s.guestExams !== false, answers: s.guestAnswers === true };
}
function guestColl(coll, pol) {
  if (!pol.on) return false;
  if (['classes', 'materials', 'settings', 'approvals'].includes(coll)) return true;
  if (/^materials\/[^/]+\/chunks$/.test(coll)) return true;
  if (coll === 'exams') return pol.exams;
  if (coll === 'bank') return pol.answers;
  return false;
}
async function approvedMap(env) {
  const r = await env.DB.prepare("SELECT id, data FROM docs WHERE coll = 'approvals'").all();
  const m = {};
  for (const x of r.results) { const d = JSON.parse(x.data); if (d.status === 'approved') m[x.id] = d.version; }
  return m;
}
function stripAnswers(d) {
  return { ...d, gradingNotes: [], answersHidden: true, questions: (d.questions || []).map((q) => { const c = { ...q }; delete c.answer; delete c.explain; delete c.rubric; return c; }) };
}

function validateUser(b, needPass) {
  if (!b) return 'Thiếu dữ liệu.';
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(String(b.username || ''))) return 'Tên đăng nhập 3–32 ký tự, chỉ gồm chữ không dấu, số, dấu chấm, gạch.';
  if (!String(b.name || '').trim()) return 'Nhập họ tên.';
  if (needPass && String(b.password || '').length < 8) return 'Mật khẩu cần ít nhất 8 ký tự.';
  return null;
}
