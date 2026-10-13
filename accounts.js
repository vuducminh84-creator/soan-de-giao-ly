/* Quản lý tài khoản và nút đăng xuất cho bản chạy độc lập */
(function () {
  const ROLE = { admin: 'Quản trị / Ban Giám Hiệu', glv: 'Giáo lý viên', viewer: 'Chỉ xem' };
  const ROLE_HINT = {
    admin: 'Duyệt đề, sửa cài đặt, quản lý tài khoản, sửa và xoá mọi đề.',
    glv: 'Tạo lớp, nhập giáo trình, soạn đề, sửa đề của mình, xem toàn bộ kho đề.',
    viewer: 'Chỉ xem kho đề và xuất Word.',
  };

  const _renderWho = renderWho;
  renderWho = function () {
    _renderWho();
    const me = window.__me && window.__me();
    if (!me) return;
    const w = document.getElementById('who');
    const b = document.createElement('button');
    b.className = 'logout'; b.type = 'button'; b.textContent = 'Đăng xuất'; b.onclick = window.__logout;
    w.appendChild(b);
  };

  const _renderCD = renderCD;
  renderCD = function () { _renderCD(); renderAccounts(); };

  let users = [];
  async function loadUsers() {
    try { users = (await __api('/users')).users; } catch (e) { users = []; toast(e.message); }
    drawUsers();
  }
  function drawUsers() {
    const box = document.getElementById('ulist');
    if (!box) return;
    const me = __me();
    box.innerHTML = users.length ? `<div class="exlist">${users.map((u) => `<div class="mrow urow" data-id="${u.id}">
        <div style="min-width:0"><div style="font-weight:600">${esc(u.name)}${u.id === me.id ? ' <span class="chip st-approved">bạn</span>' : ''}</div><div class="small muted">${esc(u.username)}</div></div>
        <div class="row" style="gap:6px;justify-content:flex-end">
          <select data-u="role" aria-label="Vai trò" ${u.id === me.id ? 'disabled' : ''} style="width:auto">${Object.entries(ROLE).map(([k, l]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <button class="btn sm" data-u="reset">Đặt lại mật khẩu</button>
          ${u.id === me.id ? '' : '<button class="btn sm ghost danger" data-u="del">Xoá</button>'}
        </div></div>`).join('')}</div>` : '<div class="empty">Chưa có tài khoản nào.</div>';
  }

  function renderAccounts() {
    const el = document.getElementById('acct-panel');
    const me = window.__me && window.__me();
    if (!el || !me) return;
    el.innerHTML = `<h2>Tài khoản</h2><div class="stack">
      <p style="margin:0">Bạn đăng nhập là <b>${esc(me.name)}</b> (${esc(me.username)}) · ${ROLE[me.role]}.</p>
      <details><summary class="btn sm" style="display:inline-flex">Đổi mật khẩu</summary>
        <form id="pw-form" class="stack" style="margin-top:10px">
          <label class="f">Mật khẩu hiện tại<input type="password" id="pw-old" autocomplete="current-password" required></label>
          <label class="f">Mật khẩu mới (ít nhất 8 ký tự)<input type="password" id="pw-new" autocomplete="new-password" required></label>
          <div><button class="btn primary sm" type="submit">Lưu mật khẩu mới</button></div></form></details>
      ${me.role === 'admin' ? `<h3 style="font-size:15px;margin-top:8px">Tài khoản trong hệ thống</h3>
        <div id="ulist"><div class="empty">Đang tải…</div></div>
        <form id="nu-form" class="stack" style="border-top:1px solid var(--line);padding-top:12px">
          <b style="font-size:13.5px">Thêm tài khoản</b>
          <div class="grid2"><label class="f">Tên Thánh, họ và tên<input type="text" id="nu-name" required></label>
          <label class="f">Tên đăng nhập<input type="text" id="nu-user" required autocapitalize="off" spellcheck="false" placeholder="vd: giuse.an"></label>
          <label class="f">Mật khẩu ban đầu<input type="text" id="nu-pass" required placeholder="ít nhất 8 ký tự"></label>
          <label class="f">Vai trò<select id="nu-role">${Object.entries(ROLE).map(([k, l]) => `<option value="${k}" ${k === 'glv' ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
          <div class="hint">${Object.entries(ROLE_HINT).map(([k, h]) => `<b>${ROLE[k]}:</b> ${h}`).join('<br>')}</div>
          <div><button class="btn primary" type="submit">Tạo tài khoản</button></div></form>` : ''}
      <div><button class="btn ghost danger" type="button" id="logout-btn">Đăng xuất</button></div></div>`;
    document.getElementById('logout-btn').onclick = window.__logout;
    document.getElementById('pw-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await __api('/password', { method: 'POST', body: JSON.stringify({ old: document.getElementById('pw-old').value, new: document.getElementById('pw-new').value }) });
        toast('Đã đổi mật khẩu.'); e.target.reset(); e.target.closest('details').open = false;
      } catch (err) { toast(err.message); }
    };
    if (me.role !== 'admin') return;
    loadUsers();
    document.getElementById('nu-form').onsubmit = async (e) => {
      e.preventDefault();
      const body = { name: document.getElementById('nu-name').value.trim(), username: document.getElementById('nu-user').value.trim(), password: document.getElementById('nu-pass').value, role: document.getElementById('nu-role').value };
      try { await __api('/users', { method: 'POST', body: JSON.stringify(body) }); toast('Đã tạo tài khoản ' + body.username + '. Gửi tên đăng nhập và mật khẩu cho người dùng.'); e.target.reset(); document.getElementById('nu-role').value = 'glv'; loadUsers(); }
      catch (err) { toast(err.message); }
    };
    const box = document.getElementById('ulist');
    box.addEventListener('change', async (e) => {
      if (e.target.dataset.u !== 'role') return;
      const id = e.target.closest('[data-id]').dataset.id;
      try { await __api('/users/' + id, { method: 'PATCH', body: JSON.stringify({ role: e.target.value }) }); toast('Đã đổi vai trò. Người dùng cần tải lại trang.'); loadUsers(); }
      catch (err) { toast(err.message); loadUsers(); }
    });
    box.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-u]'); if (!b || b.tagName === 'SELECT') return;
      const row = b.closest('[data-id]'); const id = row.dataset.id; const u = users.find((x) => x.id === id);
      if (b.dataset.u === 'reset') {
        if (row.querySelector('.reset-form')) return;
        const f = document.createElement('form'); f.className = 'reset-form row'; f.style.cssText = 'grid-column:1/-1;gap:6px';
        f.innerHTML = '<input type="text" placeholder="Mật khẩu mới cho ' + esc(u.name) + '" style="flex:1;min-width:160px"><button class="btn sm primary" type="submit">Lưu</button>';
        row.appendChild(f); f.querySelector('input').focus();
        f.onsubmit = async (ev) => { ev.preventDefault();
          try { await __api('/users/' + id, { method: 'PATCH', body: JSON.stringify({ password: f.querySelector('input').value }) }); toast('Đã đặt lại mật khẩu cho ' + u.username + '.'); f.remove(); }
          catch (err) { toast(err.message); } };
      }
      if (b.dataset.u === 'del') {
        if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Bấm lần nữa để xoá'; setTimeout(() => { if (b.isConnected) { b.dataset.confirm = ''; b.textContent = 'Xoá'; } }, 4000); return; }
        try { await __api('/users/' + id, { method: 'DELETE', body: '{}' }); toast('Đã xoá tài khoản ' + u.username + '.'); loadUsers(); }
        catch (err) { toast(err.message); }
      }
    });
  }
})();
