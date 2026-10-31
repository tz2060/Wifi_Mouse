/* 触摸板页面里的「传文件」面板。
 *
 * 为什么不直接 iframe 嵌入 /files 页面：
 *   面板是覆盖在触摸板上的浮层，iframe 会带来滚动嵌套、
 *   返回手势冲突、以及令牌传递的额外复杂度。
 *   这里直接调同一套 REST 接口，交互更可控。
 *
 * 上传用 XMLHttpRequest 而不是 fetch：fetch 没有 upload.onprogress，
 * 手机上不知道传了多少是最影响体验的。
 */
(function (global) {
  'use strict';

  const TOKEN_KEY = 'remouse.token';

  function token() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function withToken(path) {
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'k=' + encodeURIComponent(token());
  }

  function formatSize(n) {
    if (n === 0) return '0 B';
    if (!n) return '—';
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n;
    for (let i = 0; i < units.length; i += 1) {
      v /= 1024;
      if (v < 1024 || i === units.length - 1) return v.toFixed(1) + ' ' + units[i];
    }
    return v.toFixed(1) + ' TB';
  }

  function formatTime(ts) {
    const d = new Date(ts * 1000);
    const pad = function (x) { return String(x).padStart(2, '0'); };
    if (d.toDateString() === new Date().toDateString()) {
      return pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    return (d.getMonth() + 1) + '/' + d.getDate() + ' '
      + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function FilePanel(opts) {
    this.$ = opts.$;
    this.buzz = opts.buzz || function () {};
    this.queue = [];
    this.uploading = false;
    this.maxBytes = 0;
    this.loaded = false;
    this.bound = false;
  }

  FilePanel.prototype.bind = function () {
    if (this.bound) return;
    this.bound = true;

    const self = this;
    const $ = this.$;

    const picker = $('fp-picker');
    if (picker) {
      picker.addEventListener('change', function () {
        self.addFiles(picker.files);
        picker.value = '';
      });
    }

    const drop = $('fp-drop');
    if (drop) {
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
          self.addFiles(e.dataTransfer.files);
        }
      });
    }

    const up = $('fp-upload');
    if (up) up.addEventListener('click', function () { self.startUpload(); });

    const clear = $('fp-clear');
    if (clear) {
      clear.addEventListener('click', function () {
        if (self.uploading) return;
        self.queue = self.queue.filter(function (x) { return x.status === 'done'; });
        self.renderQueue();
        self.hideHint();
      });
    }

    const refresh = $('fp-refresh');
    if (refresh) refresh.addEventListener('click', function () { self.refresh(); });
  };

  /** 面板首次打开时才拉列表，避免每次进页面都打接口。 */
  FilePanel.prototype.onShow = function () {
    this.bind();
    if (!this.loaded) {
      this.loaded = true;
      this.refresh();
    }
  };

  FilePanel.prototype.showHint = function (text, isErr) {
    const el = this.$('fp-hint');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    el.classList.toggle('err', !!isErr);
  };

  FilePanel.prototype.hideHint = function () {
    const el = this.$('fp-hint');
    if (el) el.hidden = true;
  };

  /* ---------- 列表 ---------- */

  FilePanel.prototype.refresh = function () {
    const self = this;
    const list = this.$('fp-list');
    if (!list) return;

    fetch(withToken('/api/files'), { cache: 'no-store' })
      .then(function (res) {
        if (res.status === 403) {
          throw new Error('令牌无效，请重新扫码进入');
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        self.maxBytes = data.maxBytes || 0;
        const limit = self.$('fp-limit');
        if (limit) limit.textContent = '单个文件最大 ' + formatSize(data.maxBytes);
        self.hideHint();
        self.renderList(data.files || []);
      })
      .catch(function (err) {
        list.innerHTML = '<div class="fp-empty">加载失败</div>';
        self.showHint('连不上电脑：' + err.message, true);
      });
  };

  FilePanel.prototype.renderList = function (files) {
    const self = this;
    const list = this.$('fp-list');
    list.innerHTML = '';

    if (!files.length) {
      const empty = document.createElement('div');
      empty.className = 'fp-empty';
      empty.textContent = '还没有文件，传一个试试';
      list.appendChild(empty);
      return;
    }

    files.forEach(function (f) {
      const row = document.createElement('div');
      row.className = 'fp-file';

      const main = document.createElement('div');
      main.className = 'fp-file-main';

      const name = document.createElement('div');
      name.className = 'fp-file-name';
      name.textContent = f.name;
      name.title = f.name;

      const meta = document.createElement('div');
      meta.className = 'fp-file-meta';
      meta.textContent = formatSize(f.size) + ' · ' + formatTime(f.mtime);

      main.appendChild(name);
      main.appendChild(meta);

      const dl = document.createElement('a');
      dl.className = 'fp-mini';
      dl.textContent = '下载';
      dl.href = withToken('/api/files/' + encodeURIComponent(f.name));
      dl.setAttribute('download', f.name);

      const del = document.createElement('button');
      del.className = 'fp-mini danger';
      del.textContent = '删除';
      del.addEventListener('click', function () { self.remove(f.name); });

      row.appendChild(main);
      row.appendChild(dl);
      row.appendChild(del);
      list.appendChild(row);
    });
  };

  FilePanel.prototype.remove = function (name) {
    const self = this;
    if (!confirm('删除「' + name + '」？不可撤销。')) return;

    fetch(withToken('/api/files/' + encodeURIComponent(name)), { method: 'DELETE' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || '删除失败');
        self.refresh();
      })
      .catch(function (err) { self.showHint('删除失败：' + err.message, true); });
  };

  /* ---------- 上传 ---------- */

  FilePanel.prototype.addFiles = function (fileList) {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;

    const self = this;
    const skipped = [];

    incoming.forEach(function (f) {
      if (self.maxBytes && f.size > self.maxBytes) {
        skipped.push(f.name);
        return;
      }
      self.queue.push({ file: f, status: 'wait', progress: 0, error: '' });
    });

    if (skipped.length) {
      this.showHint('超过上限已跳过：' + skipped.join('、'), true);
    } else {
      this.hideHint();
    }
    this.renderQueue();
  };

  FilePanel.prototype.renderQueue = function () {
    const self = this;
    const box = this.$('fp-queue');
    const actions = this.$('fp-actions');
    if (!box || !actions) return;

    if (!this.queue.length) {
      box.hidden = true;
      actions.hidden = true;
      box.innerHTML = '';
      return;
    }

    box.hidden = false;
    actions.hidden = false;
    box.innerHTML = '';

    this.queue.forEach(function (item) {
      const el = document.createElement('div');
      el.className = 'fp-item';
      if (item.status === 'done') el.classList.add('done');
      if (item.status === 'error') el.classList.add('failed');

      const top = document.createElement('div');
      top.className = 'fp-item-top';

      const name = document.createElement('span');
      name.className = 'fp-item-name';
      name.textContent = item.file.name;
      name.title = item.file.name;

      const size = document.createElement('span');
      size.className = 'fp-item-size';
      size.textContent = formatSize(item.file.size);

      const status = document.createElement('span');
      status.className = 'fp-item-status';
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
      bar.className = 'fp-progress';
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

    const pending = this.queue.filter(function (x) {
      return x.status === 'wait' || x.status === 'error';
    });
    const up = this.$('fp-upload');
    up.disabled = this.uploading || pending.length === 0;
    up.textContent = this.uploading ? '上传中…' : '开始上传';
  };

  FilePanel.prototype.uploadOne = function (item) {
    const self = this;
    return new Promise(function (resolve) {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', withToken('/api/files?name=' + encodeURIComponent(item.file.name)));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');

      item.status = 'doing';
      item.progress = 0;
      self.renderQueue();

      xhr.upload.onprogress = function (e) {
        if (!e.lengthComputable) return;
        item.progress = (e.loaded / e.total) * 100;
        self.renderQueue();
      };

      xhr.onload = function () {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* 非 JSON */ }
        if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) {
          item.status = 'done';
          item.progress = 100;
          if (data.name) item.file = { name: data.name, size: item.file.size };
        } else {
          item.status = 'error';
          item.error = (data && data.error) || ('HTTP ' + xhr.status);
        }
        self.renderQueue();
        resolve();
      };

      xhr.onerror = function () {
        item.status = 'error';
        item.error = '网络中断';
        self.renderQueue();
        resolve();
      };

      xhr.send(item.file);
    });
  };

  FilePanel.prototype.startUpload = function () {
    if (this.uploading) return;
    const self = this;

    const pending = this.queue.filter(function (x) {
      return x.status === 'wait' || x.status === 'error';
    });
    if (!pending.length) return;

    this.uploading = true;
    this.renderQueue();

    // 串行：接口是"一次一个文件"，串行进度清晰也不会撑爆内存
    let chain = Promise.resolve();
    pending.forEach(function (item) {
      chain = chain.then(function () {
        return self.uploadOne(item);
      });
    });

    chain.then(function () {
      self.uploading = false;
      const failed = self.queue.filter(function (x) { return x.status === 'error'; });
      if (failed.length) {
        self.showHint(failed.length + ' 个文件失败，可重试', true);
      } else {
        self.hideHint();
        self.buzz(16);
      }
      self.renderQueue();
      self.refresh();
    });
  };

  global.FilePanel = FilePanel;
})(typeof self !== 'undefined' ? self : this);
