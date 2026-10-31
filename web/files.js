/* 文件柜前端。
 *
 * 为什么用 XMLHttpRequest 而不是 fetch：
 *   fetch 无法上报上传进度（没有 upload.onprogress）。
 *   手机上不知道传了多少是最影响体验的——尤其几百 MB 的文件。
 *
 * 为什么一次只传一个：
 *   服务端接口是"请求体即文件字节"，一次一个最简单也最省内存。
 *   串行上传还能让进度条有序推进，不会几个文件一起跳。
 */
(function () {
  'use strict';

  const TOKEN_KEY = 'remouse.token';
  const $ = function (id) { return document.getElementById(id); };

  /* ---------- 令牌 ---------- */

  function readToken() {
    const m = /[?&]k=([^&]+)/.exec(location.search);
    if (m) {
      const fromUrl = decodeURIComponent(m[1]);
      try { localStorage.setItem(TOKEN_KEY, fromUrl); } catch (e) { /* 隐私模式 */ }
      return fromUrl;
    }
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  const token = readToken();

  function api(path, withToken) {
    if (!withToken) return path;
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'k=' + encodeURIComponent(token);
  }

  /* ---------- 工具 ---------- */

  function formatSize(n) {
    if (!n && n !== 0) return '—';
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n;
    for (let i = 0; i < units.length; i += 1) {
      v /= 1024;
      if (v < 1024 || i === units.length - 1) {
        return v.toFixed(1) + ' ' + units[i];
      }
    }
    return v.toFixed(1) + ' TB';
  }

  function formatTime(ts) {
    const d = new Date(ts * 1000);
    const pad = function (x) { return String(x).padStart(2, '0'); };
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes());
    return (d.getMonth() + 1) + '/' + d.getDate() + ' '
      + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function showHint(text, isErr) {
    const el = $('hint');
    el.textContent = text;
    el.hidden = false;
    el.classList.toggle('err', !!isErr);
  }

  function hideHint() {
    $('hint').hidden = true;
  }

  /* ---------- 状态 ---------- */

  const state = {
    queue: [],       // {file, status, progress, error}
    uploading: false,
    maxBytes: 0,
  };

  /* ---------- 文件列表 ---------- */

  async function refresh() {
    const list = $('list');
    try {
      const res = await fetch(api('/api/files', true), { cache: 'no-store' });
      if (!res.ok) {
        if (res.status === 403) {
          showHint('令牌无效。请重新从电脑端的二维码或链接进入。', true);
          $('dot').classList.remove('on');
          list.innerHTML = '<div class="empty">无法访问</div>';
          return;
        }
        throw new Error('HTTP ' + res.status);
      }
      const data = await res.json();
      $('dot').classList.add('on');
      hideHint();

      state.maxBytes = data.maxBytes || 0;
      $('limit-hint').textContent = '单个文件最大 ' + formatSize(data.maxBytes);
      $('total').textContent = data.files.length + ' 个 · ' + data.totalText;

      render(data.files);
    } catch (err) {
      $('dot').classList.remove('on');
      list.innerHTML = '<div class="empty">加载失败，检查连接</div>';
      showHint('连接不上电脑。确认服务还在运行、手机和电脑在同一 WiFi。', true);
    }
  }

  function render(files) {
    const list = $('list');
    if (!files.length) {
      list.innerHTML = '<div class="empty">还没有文件。上传一个试试。</div>';
      return;
    }

    list.innerHTML = '';
    files.forEach(function (f) {
      const row = document.createElement('div');
      row.className = 'file';

      const main = document.createElement('div');
      main.className = 'file-main';

      const name = document.createElement('div');
      name.className = 'file-name';
      name.textContent = f.name;
      name.title = f.name;

      const meta = document.createElement('div');
      meta.className = 'file-meta';
      meta.textContent = formatSize(f.size) + ' · ' + formatTime(f.mtime);

      main.appendChild(name);
      main.appendChild(meta);

      const dl = document.createElement('a');
      dl.className = 'btn';
      dl.textContent = '下载';
      dl.href = api('/api/files/' + encodeURIComponent(f.name), true);
      dl.setAttribute('download', f.name);

      const del = document.createElement('button');
      del.className = 'btn danger';
      del.textContent = '删除';
      del.addEventListener('click', function () { removeFile(f.name); });

      row.appendChild(main);
      row.appendChild(dl);
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  async function removeFile(name) {
    if (!confirm('删除「' + name + '」？此操作不可撤销。')) return;
    try {
      const res = await fetch(
        api('/api/files/' + encodeURIComponent(name), true),
        { method: 'DELETE' }
      );
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || '删除失败');
      refresh();
    } catch (err) {
      showHint('删除失败：' + err.message, true);
    }
  }

  /* ---------- 上传 ---------- */

  function addFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;

    const oversized = [];
    incoming.forEach(function (f) {
      if (state.maxBytes && f.size > state.maxBytes) {
        oversized.push(f.name);
        return;
      }
      state.queue.push({ file: f, status: 'wait', progress: 0, error: '' });
    });

    if (oversized.length) {
      showHint('这些文件超过上限，已跳过：' + oversized.join('、'), true);
    } else {
      hideHint();
    }

    renderQueue();
  }

  function renderQueue() {
    const box = $('queue');
    const row = $('action-row');

    if (!state.queue.length) {
      box.hidden = true;
      row.hidden = true;
      box.innerHTML = '';
      return;
    }

    box.hidden = false;
    row.hidden = false;

    box.innerHTML = '';
    state.queue.forEach(function (item) {
      const el = document.createElement('div');
      el.className = 'item';
      if (item.status === 'done') el.classList.add('done');
      if (item.status === 'error') el.classList.add('failed');

      const top = document.createElement('div');
      top.className = 'item-top';

      const name = document.createElement('span');
      name.className = 'item-name';
      name.textContent = item.file.name;
      name.title = item.file.name;

      const size = document.createElement('span');
      size.className = 'item-size';
      size.textContent = formatSize(item.file.size);

      const status = document.createElement('span');
      status.className = 'item-status';
      if (item.status === 'done') {
        status.classList.add('ok');
        status.textContent = '完成';
      } else if (item.status === 'error') {
        status.classList.add('err');
        status.textContent = item.error || '失败';
      } else if (item.status === 'doing') {
        status.classList.add('doing');
        status.textContent = Math.round(item.progress) + '%';
      } else {
        status.textContent = '等待';
      }

      const bar = document.createElement('div');
      bar.className = 'progress';
      const fill = document.createElement('i');
      fill.style.width = (item.status === 'done' ? 100 : item.progress) + '%';
      bar.appendChild(fill);

      top.appendChild(name);
      top.appendChild(size);
      top.appendChild(status);
      el.appendChild(top);
      el.appendChild(bar);
      box.appendChild(el);
    });

    const pending = state.queue.filter(function (x) {
      return x.status === 'wait' || x.status === 'error';
    });
    $('btn-upload').disabled = state.uploading || pending.length === 0;
    $('btn-upload').textContent = state.uploading ? '上传中…' : '开始上传';
  }

  /** 单个文件上传，返回 Promise。用 XHR 才有进度。 */
  function uploadOne(item) {
    return new Promise(function (resolve) {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', api('/api/files?name=' + encodeURIComponent(item.file.name), true));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');

      item.status = 'doing';
      item.progress = 0;
      renderQueue();

      xhr.upload.onprogress = function (e) {
        if (!e.lengthComputable) return;
        item.progress = (e.loaded / e.total) * 100;
        renderQueue();
      };

      xhr.onload = function () {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* 非 JSON */ }
        if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) {
          item.status = 'done';
          item.progress = 100;
          // 服务端可能改名（同名追加序号），这里同步显示实际名字
          if (data.name) item.file = { name: data.name, size: item.file.size };
        } else {
          item.status = 'error';
          item.error = (data && data.error) || ('HTTP ' + xhr.status);
        }
        renderQueue();
        resolve();
      };

      xhr.onerror = function () {
        item.status = 'error';
        item.error = '网络中断';
        renderQueue();
        resolve();
      };

      xhr.onabort = function () {
        item.status = 'error';
        item.error = '已取消';
        renderQueue();
        resolve();
      };

      xhr.send(item.file);
    });
  }

  async function startUpload() {
    if (state.uploading) return;
    const pending = state.queue.filter(function (x) {
      return x.status === 'wait' || x.status === 'error';
    });
    if (!pending.length) return;

    state.uploading = true;
    renderQueue();

    // 串行：一次一个，进度清晰，也不会撑爆手机内存
    for (const item of pending) {
      await uploadOne(item);
    }

    state.uploading = false;

    const failed = state.queue.filter(function (x) { return x.status === 'error'; });
    if (failed.length) {
      showHint(failed.length + ' 个文件上传失败，可重试。', true);
    } else {
      hideHint();
    }

    renderQueue();
    refresh();
  }

  /* ---------- 事件绑定 ---------- */

  function bind() {
    const picker = $('picker');
    const drop = $('drop');

    picker.addEventListener('change', function () {
      addFiles(picker.files);
      picker.value = '';   // 允许重复选同一个文件
    });

    // 拖拽（桌面浏览器）
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault();
        drop.classList.add('hover');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault();
        drop.classList.remove('hover');
      });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) {
        addFiles(e.dataTransfer.files);
      }
    });

    $('btn-upload').addEventListener('click', startUpload);

    $('btn-clear').addEventListener('click', function () {
      if (state.uploading) return;
      state.queue = state.queue.filter(function (x) { return x.status === 'done'; });
      renderQueue();
      hideHint();
    });

    $('btn-refresh').addEventListener('click', refresh);

    // 把令牌带到返回链接，回触摸板不用重新扫码
    const back = $('back-link');
    back.href = '/?k=' + encodeURIComponent(token);
  }

  /* ---------- 启动 ---------- */

  if (!token) {
    showHint('缺少令牌。请从电脑端显示的链接或二维码进入。', true);
    $('list').innerHTML = '<div class="empty">无法访问</div>';
  } else {
    bind();
    refresh();
  }
})();
