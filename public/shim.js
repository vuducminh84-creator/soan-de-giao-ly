/* Lớp kết nối: cung cấp window.claude.use(db|user|sample|downloads) dựa trên API riêng /api/* */
(function () {
  const api = async (path, opt = {}) => {
    const r = await fetch('/api' + path, { credentials: 'same-origin', ...opt, headers: { 'content-type': 'application/json', ...(opt.headers || {}) } });
    let body = null;
    try { body = await r.json(); } catch {}
    if (!r.ok) { const e = new Error((body && body.error) || ('HTTP ' + r.status)); e.status = r.status; e.body = body; throw e; }
    return body;
  };
  window.__api = api;
  let ME = null, CLAUDE_ON = false, GUEST = null, authResolve;
  const authReady = new Promise((r) => (authResolve = r));
  window.__me = () => ME;
  window.__guest = () => GUEST;

  /* ---------- đăng nhập ---------- */
  const authEl = () => document.getElementById('auth');
  function showLogin(setup, msg) {
    const el = authEl();
    el.hidden = false;
    el.innerHTML = `<form class="auth-card" id="auth-form" autocomplete="on">
      <div class="auth-brand"><span class="mark" aria-hidden="true">☧</span><div><b>SOẠN ĐỀ KIỂM TRA GIÁO LÝ</b><small>${setup ? 'Thiết lập lần đầu' : 'Đăng nhập'}</small></div></div>
      ${setup ? '<p class="auth-note">Chưa có tài khoản nào. Tạo tài khoản <b>quản trị</b> đầu tiên (thường là Trưởng Ban Giáo Lý hoặc người phụ trách kỹ thuật).</p>' : ''}
      ${setup ? '<label class="f">Tên Thánh, họ và tên<input type="text" id="au-name" required autocomplete="name"></label>' : ''}
      <label class="f">Tên đăng nhập<input type="text" id="au-user" required autocomplete="username" autocapitalize="off" spellcheck="false"></label>
      <label class="f">Mật khẩu${setup ? ' (ít nhất 8 ký tự)' : ''}<input type="password" id="au-pass" required autocomplete="${setup ? 'new-password' : 'current-password'}"></label>
      <div class="auth-err" id="au-err">${msg ? msg : ''}</div>
      <button class="btn primary" type="submit">${setup ? 'Tạo tài khoản quản trị' : 'Đăng nhập'}</button>
      ${setup ? '' : '<p class="auth-note">Quên mật khẩu? Liên hệ quản trị để được đặt lại.</p>'}
      ${GUEST && !setup ? '<button type="button" class="btn ghost" id="au-close">Tiếp tục xem với tư cách khách</button>' : ''}
    </form>`;
    const cl = document.getElementById('au-close');
    if (cl) cl.onclick = () => { el.hidden = true; el.innerHTML = ''; };
    document.getElementById('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button'); btn.disabled = true;
      const body = { username: document.getElementById('au-user').value.trim(), password: document.getElementById('au-pass').value };
      if (setup) body.name = document.getElementById('au-name').value.trim();
      try {
        await api(setup ? '/setup' : '/login', { method: 'POST', body: JSON.stringify(body) });
        location.reload();
      } catch (err) { document.getElementById('au-err').textContent = err.message; btn.disabled = false; }
    });
    (document.getElementById(setup ? 'au-name' : 'au-user')).focus();
  }
  async function check() {
    try {
      const r = await api('/me');
      ME = r.user; CLAUDE_ON = !!r.claude;
      authEl().hidden = true; authEl().innerHTML = '';
      authResolve();
    } catch (e) {
      const b = e.body || {};
      if (e.status === 401 && !b.needsSetup && b.guest && b.guest.on) {
        GUEST = b.guest; ME = { id: null, name: 'Khách', username: '', role: 'guest' };
        authEl().hidden = true; authEl().innerHTML = ''; authResolve(); return;
      }
      if (e.status === 401) showLogin(!!b.needsSetup);
      else showLogin(false, 'Không kết nối được máy chủ: ' + e.message);
    }
  }
  window.__showLogin = (msg) => showLogin(false, msg || '');
  window.__logout = async () => { try { await api('/logout', { method: 'POST', body: '{}' }); } catch {} location.reload(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check); else check();

  /* ---------- kho dữ liệu (giống API db của Artifact) ---------- */
  const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  const toErr = (e) => ({ code: e.status === 403 || e.status === 400 || e.status === 413 ? 'invalid_argument' : e.status === 401 ? 'revoked' : 'unavailable', message: e.message });
  const meta = { fromCache: false, hasPendingWrites: false };
  const docSnap = (id, data) => ({ id, exists: data != null, data: () => (data == null ? undefined : data), metadata: meta });
  function checkSegs(path, even) {
    const s = path.split('/');
    if (!s.every((x) => SEG.test(x))) throw new TypeError('Đường dẫn không hợp lệ: ' + path);
    if ((s.length % 2 === 0) !== even) throw new TypeError((even ? 'Tài liệu' : 'Bộ sưu tập') + ' sai số đoạn: ' + path);
    return s;
  }
  const enc = encodeURIComponent;
  function docRef(path) {
    const s = checkSegs(path, true);
    const coll = s.slice(0, -1).join('/');
    const ref = {
      id: s[s.length - 1], path,
      async get() { try { const r = await api('/doc?path=' + enc(path)); return docSnap(ref.id, r.data); } catch (e) { throw toErr(e); } },
      async set(data) { try { await api('/doc?path=' + enc(path), { method: 'PUT', body: JSON.stringify(data) }); poke(); } catch (e) { throw toErr(e); } },
      async update(data) { try { await api('/doc?path=' + enc(path), { method: 'PATCH', body: JSON.stringify(data) }); poke(); } catch (e) { throw toErr(e); } },
      async delete() { try { await api('/doc?path=' + enc(path), { method: 'DELETE', body: '{}' }); poke(); } catch (e) { throw toErr(e); } },
      onSnapshot(next, onError) { return listen(coll, () => ref.get(), next, onError); },
      collection(p) { return colRef(path + '/' + p); },
    };
    return ref;
  }
  function query(coll, opts) {
    const q = {
      where() { throw new TypeError('where() không được hỗ trợ trong bản độc lập'); },
      orderBy(f, dir = 'asc') { return query(coll, { ...opts, orderBy: f, dir }); },
      limit(n) { return query(coll, { ...opts, limit: n }); },
      async get() {
        const p = new URLSearchParams({ coll });
        if (opts.orderBy) { p.set('orderBy', opts.orderBy); p.set('dir', opts.dir); }
        if (opts.limit) p.set('limit', opts.limit);
        try {
          const r = await api('/docs?' + p);
          const docs = r.docs.map((d) => docSnap(d.id, d.data));
          return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta };
        } catch (e) { throw toErr(e); }
      },
      onSnapshot(next, onError) { return listen(coll, () => q.get(), next, onError); },
    };
    return q;
  }
  function colRef(path) {
    checkSegs(path, false);
    const q = query(path, {});
    return Object.assign(q, {
      path,
      doc(id) { return docRef(path + '/' + (id || rid())); },
      async add(data) { const r = docRef(path + '/' + rid()); await r.set(data); return r; },
    });
  }
  // Theo dõi thay đổi: hỏi máy chủ phiên bản của từng bộ sưu tập mỗi 20 giây, chỉ tải lại khi có thay đổi.
  const listeners = new Set();
  const versions = {};
  function listen(coll, fetcher, next, onError) {
    const L = { coll, fetcher, next, onError, last: null, alive: true };
    listeners.add(L); run(L);
    return () => { L.alive = false; listeners.delete(L); };
  }
  async function run(L) {
    try {
      const snap = await L.fetcher();
      if (!L.alive) return;
      const key = JSON.stringify(snap.docs ? snap.docs.map((d) => [d.id, d.data()]) : [snap.exists, snap.data()]);
      if (key !== L.last) { L.last = key; L.next(snap); }
    } catch (e) { if (e.code === 'revoked' && L.onError) { L.alive = false; L.onError(e); } }
  }
  async function poll(force) {
    if (!ME || !listeners.size) return;
    const colls = [...new Set([...listeners].map((l) => l.coll))];
    try {
      const r = await api('/versions', { method: 'POST', body: JSON.stringify({ colls }) });
      const changed = new Set(colls.filter((c) => force || versions[c] !== r.versions[c]));
      Object.assign(versions, r.versions);
      listeners.forEach((L) => { if (changed.has(L.coll)) run(L); });
    } catch (e) { if (e.status === 401) location.reload(); }
  }
  let pokeT;
  function poke() { clearTimeout(pokeT); pokeT = setTimeout(() => poll(false), 120); }
  setInterval(() => { if (document.visibilityState === 'visible') poll(false); }, 20000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(false); });
  const db = { doc: docRef, collection: colRef };

  /* ---------- người dùng ---------- */
  function avatar(name) {
    const ini = String(name || '?').trim().split(/\s+/).slice(-2).map((w) => w[0] || '').join('').toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="24" fill="#0B63B6"/><text x="24" y="30" font-family="sans-serif" font-size="18" font-weight="700" fill="#fff" text-anchor="middle">${ini.replace(/[<&>"]/g, '')}</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  const user = {
    async me() { return { id: ME.id, name: ME.name, role: ME.role, avatarUrl: avatar(ME.name), color: '#0B63B6', email: null, isOwner: ME.role === 'admin', canEdit: ME.role === 'admin', role: ME.role }; },
    async id() { return ME.id; },
    async name() { return ME.name; },
    async isOwner() { return ME.role === 'admin'; },
    async canEdit() { return ME.role === 'admin'; },
    async can(n) { return n === 'data.write' ? (ME.role !== 'viewer' && ME.role !== 'guest') : false; },
    async profiles(ids) { return Object.fromEntries([].concat(ids).map((id) => [id, { id, name: '', avatarUrl: avatar('?'), color: '#888', email: null, isMe: id === ME.id, guest: false }])); },
    async search() { return []; },
  };

  /* ---------- Claude (qua máy chủ) ---------- */
  async function sample(input, opts = {}) {
    const prompt = typeof input === 'string' ? input : input.map((m) => m.content).join('\n\n');
    let r;
    try {
      r = await fetch('/api/claude', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }), signal: opts.signal });
    } catch (e) { throw { code: e.name === 'AbortError' ? 'cancelled' : 'unavailable', message: String(e) }; }
    if (!r.ok) {
      let b = {}; try { b = await r.json(); } catch {}
      throw { code: r.status === 429 ? 'rate_limited' : r.status === 403 ? 'not_granted' : r.status === 413 ? 'prompt_too_large' : 'unavailable', message: b.error || ('HTTP ' + r.status) };
    }
    const rd = r.body.getReader(); const dec = new TextDecoder();
    let buf = '', text = '', stop = '';
    try {
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = ev.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let j; try { j = JSON.parse(line.slice(5)); } catch { continue; }
          if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') { text += j.delta.text; opts.onText && opts.onText({ text, delta: j.delta.text }); }
          else if (j.type === 'message_delta' && j.delta && j.delta.stop_reason) stop = j.delta.stop_reason;
          else if (j.type === 'error') throw { code: j.error && j.error.type === 'overloaded_error' ? 'rate_limited' : 'unavailable', message: (j.error && j.error.message) || 'Claude báo lỗi', text };
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') throw { code: 'cancelled', text };
      throw e && e.code ? e : { code: 'unavailable', message: String(e), text };
    }
    return { text, truncated: stop === 'max_tokens', modelTierApplied: 'default' };
  }
  sample.json = async (input, opts) => {
    const { text } = await sample(input, opts);
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    try { return JSON.parse(text.slice(a, b + 1)); } catch { throw { code: 'invalid_json', message: 'JSON không hợp lệ', text }; }
  };
  sample.limits = async () => ({});

  /* ---------- tải tệp ---------- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return { status: 'saved' };
    },
  };

  window.claude = {
    async use(name) {
      await authReady;
      if (name === 'sample') return CLAUDE_ON && ME.role !== 'viewer' && ME.role !== 'guest' ? sample : null;
      if (name === 'downloads' && ME.role === 'guest') return null;
      return { db, user, downloads }[name] || null;
    },
  };
})();
