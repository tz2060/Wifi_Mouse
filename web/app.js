/* reMouse 前端主逻辑：连接、协议、UI 绑定 */
(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };

  /* ---------- 令牌 ---------- */

  const TOKEN_KEY = 'remouse.token';

  function readToken() {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('k');
    if (fromUrl) {
      try { localStorage.setItem(TOKEN_KEY, fromUrl); } catch (e) { /* 隐私模式 */ }
      return fromUrl;
    }
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  const token = readToken();

  /* 本机是否存过设置。
     存过就以本地为准——用户调过的手感不该被服务端默认值覆盖。 */
  const store = { hasSavedConfig: false };

  /* 设置结构版本。
     默认值改动时必须递增，否则老用户手机里存着旧值，
     新默认值永远不会生效——他们在面板里看到的还是旧值，
     会以为改动没生效。

     v2：体感两轴翻转、垂直速度独立
     v3：灵敏度默认 1.6 -> 3.2 */
  const CFG_VERSION = 3;
  const CFG_VER_KEY = 'remouse.cfg.ver';

  /* ---------- 状态 ---------- */

  const state = {
    ws: null,
    connected: false,
    retry: 0,
    retryTimer: null,
    pingTimer: null,
    lastPongAt: 0,
    pingSeq: 0,
    rtt: 0,
    cfg: {
      sens: 3.2,
      acc: true,
      nat: false,
      three: false,
      haptic: true,
      gyroMax: 1600,
      gyroMaxY: 2600,
      gyroDz: 4,
      gyroHold: true,
      // 手机竖持正对屏幕时，两轴方向都是反的，所以默认都翻转。
      // 换握姿（比如横持）手感会反过来，在面板里改这两个开关即可。
      gyroInvertX: true,
      gyroInvertY: true,
      showScroll: true,
      scrollLeft: false,
    },
    modLocks: new Set(),
    wakeLock: null,
    host: '',
  };

  /* ---------- 触觉 ---------- */

  function buzz(ms) {
    if (!state.cfg.haptic) return;
    if (navigator.vibrate) {
      try { navigator.vibrate(ms || 10); } catch (e) { /* 忽略 */ }
    }
  }

  /* ---------- 连接 ---------- */

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws?k=' + encodeURIComponent(token);
  }

  function connect() {
    if (!token) {
      setStatus('err', '缺少访问令牌');
      showTokenHint();
      return;
    }

    clearTimeout(state.retryTimer);
    setStatus('wait', '连接中…');

    let ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      scheduleReconnect();
      return;
    }
    state.ws = ws;

    ws.onopen = function () {
      state.retry = 0;
      state.lastPongAt = Date.now();
      startPing();
    };

    ws.onmessage = function (ev) {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleServerMessage(msg);
    };

    ws.onclose = function (ev) {
      state.connected = false;
      stopPing();
      releaseWakeLock();
      if (ev.code === 4401) {
        setStatus('err', '令牌无效');
        showTokenHint();
        return;
      }
      // 断线可能留下按住的键，尽量让服务端兜底：这里无需额外动作
      scheduleReconnect();
    };

    ws.onerror = function () { /* onclose 会接手 */ };
  }

  function scheduleReconnect() {
    state.connected = false;
    setStatus('wait', '重连中…');
    if (state.retry > 8) {
      setStatus('err', '连接失败，点击重试');
      return;
    }
    const delay = Math.min(5000, 300 * Math.pow(2, state.retry));
    state.retry += 1;
    clearTimeout(state.retryTimer);
    state.retryTimer = setTimeout(connect, delay);
  }

  function handleServerMessage(msg) {
    if (msg.t === 'hi') {
      state.connected = true;
      state.host = msg.host || '已连接';
      $('hostname').textContent = state.host;
      setStatus('on', state.host);
      if (msg.cfg) {
        applyServerDefaults(msg.cfg);
        if (msg.cfg.backend) $('backend').textContent = msg.cfg.backend;
      }
      syncSettingsUI();
      engine.setThreeFinger(state.cfg.three);
      engine.setAcceleration(state.cfg.acc);
      applyGyroConfig();
      applyScrollbarConfig();
      requestWakeLock();
      return;
    }

    if (msg.t === 'po') {
      state.lastPongAt = Date.now();
      if (typeof msg.n === 'number') {
        state.rtt = Math.round(performance.now() - msg.n);
        $('rtt').textContent = state.rtt + ' ms';
        if (state.rtt > 400) $('rtt').style.color = 'var(--warn)';
        else $('rtt').style.color = '';
      }
      return;
    }

    if (msg.t === 'er') {
      if (msg.code === 4401) {
        setStatus('err', '令牌无效');
        showTokenHint();
        return;
      }
      // 其余错误（文本超限、注入失败等）显示出来。
      // 之前这里直接 return，用户完全看不到服务端说了什么，
      // 只能看到"已发送"的假象。
      const why = msg.m || msg.message || msg.msg || '发送失败';
      if (typeof showTypeHint === 'function') {
        showTypeHint(String(why), true);
      }
      return;
    }
  }

  /* 服务端下发的默认值：只在"本机对这个键没有自己的设置"时生效。

     为什么不能无条件覆盖：
       用户调过灵敏度，每次重连时服务端又把默认值推下来盖掉，
       调好的手感会一直被打回原形。体感那边之前踩过这个坑，
       这次把灵敏度也一并收进来统一处理。

     判定依据：
       配置版本过旧时，加载阶段已经把这些键从 state.cfg 里删掉了
       （表示"这个键没有用户设置"），此时正好由服务端补上。
       版本是新的，说明本地值就是用户的真实意图，不覆盖。 */
  function applyServerDefaults(cfg) {
    if (store.hasSavedConfig) return;

    if (typeof cfg.sens === 'number') state.cfg.sens = cfg.sens;
    if (typeof cfg.acc === 'boolean') state.cfg.acc = cfg.acc;
    if (typeof cfg.nat === 'boolean') state.cfg.nat = cfg.nat;
    if (typeof cfg.three === 'boolean') state.cfg.three = cfg.three;
    if (typeof cfg.gyroMax === 'number') state.cfg.gyroMax = cfg.gyroMax;
    if (typeof cfg.gyroMaxY === 'number') state.cfg.gyroMaxY = cfg.gyroMaxY;
    if (typeof cfg.gyroDz === 'number') state.cfg.gyroDz = cfg.gyroDz;
    if (typeof cfg.gyroInvX === 'boolean') state.cfg.gyroInvertX = cfg.gyroInvX;
    if (typeof cfg.gyroInvY === 'boolean') state.cfg.gyroInvertY = cfg.gyroInvY;
  }

  function setStatus(kind, text) {
    const dot = $('dot');
    dot.className = 'dot' + (kind === 'on' ? ' on' : kind === 'wait' ? ' wait' : '');
    if (text) $('hostname').textContent = text;
  }

  function showTokenHint() {
    alert(
      '连接被拒绝：令牌无效或不匹配。\n\n' +
      '请重新扫描电脑终端上打印的地址（形如 http://10.x.x.x:8765/?k=...），' +
      '或在浏览器地址栏里补上 ?k=令牌。\n\n' +
      '如果电脑端刚执行过 --new-token，旧令牌已失效。'
    );
  }

  /* ---------- 心跳 ---------- */

  function startPing() {
    stopPing();
    state.lastPongAt = Date.now();
    state.pingTimer = setInterval(function () {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - state.lastPongAt > 20000) {
        // 假死：主动断开触发重连
        try { state.ws.close(); } catch (e) { /* 忽略 */ }
        return;
      }
      state.pingSeq += 1;
      const t = performance.now();
      send({ t: 'pg', n: t });
      // 服务端回 po 时带原始 n
      setTimeout(function () {
        if (state.ws && state.ws.readyState === WebSocket.OPEN && state.lastPongAt < Date.now() - 19000) {
          // 顺带兜底，避免长时间假死不被发现
        }
      }, 0);
      void t;
    }, 5000);
    requestWakeLock();
  }

  function stopPing() {
    clearInterval(state.pingTimer);
    state.pingTimer = null;
  }

  function send(obj) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    try {
      state.ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------- 按住状态记账 ---------- */

  /* 记录本地认为"仍按着"的鼠标键。
     锁屏时不能盲目补发抬起——实测只发一个 RIGHTUP，目标窗口照样
     收到 WM_RBUTTONUP，而应用就是靠这条消息弹右键菜单的。
     没按过就绝不能发抬起，否则会凭空冒出一个右键菜单。 */
  const held = new Set();

  function pressButton(btn) {
    held.add(btn);
    send({ t: 'bt', b: btn, a: 'd' });
  }

  function releaseButton(btn) {
    if (!held.has(btn)) return;   // 没按过，不发
    held.delete(btn);
    send({ t: 'bt', b: btn, a: 'u' });
  }

  function releaseAllButtons() {
    Array.from(held).forEach(releaseButton);
  }

  /* ---------- 屏幕常亮 ---------- */

  async function requestWakeLock() {
    if (state.wakeLock) return;
    if (!('wakeLock' in navigator)) return;   // HTTP 下不可用，静默降级
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', function () {
        state.wakeLock = null;
      });
    } catch (e) {
      state.wakeLock = null;
    }
  }

  function releaseWakeLock() {
    if (state.wakeLock) {
      try { state.wakeLock.release(); } catch (e) { /* 忽略 */ }
      state.wakeLock = null;
    }
  }

  /* ---------- 手势 ---------- */

  const engine = new window.Gesture.GestureEngine();

  engine.onEvent = function (type, payload) {
    if (type === 'move') {
      const dx = payload.dx * state.cfg.sens;
      const dy = payload.dy * state.cfg.sens;
      send({ t: 'mv', dx: round2(dx), dy: round2(dy) });
      return;
    }
    if (type === 'button') {
      if (payload.action === 'd') {
        pressButton(payload.btn);
      } else if (payload.action === 'u') {
        releaseButton(payload.btn);
      } else {
        // 单击 / 双击：完整一次按下抬起，不需要记账
        send({ t: 'bt', b: payload.btn, a: payload.action });
      }
      return;
    }
    if (type === 'wheel') {
      const dy = state.cfg.nat ? payload.dy : -payload.dy;
      send({ t: 'wh', dy: dy, dx: payload.dx || 0 });
      return;
    }
    if (type === 'swipe') {
      const map = {
        up: 'win+tab',
        down: 'win+d',
        left: 'alt+shift+tab',
        right: 'alt+tab',
      };
      const combo = map[payload.dir];
      if (combo) send({ t: 'ky', k: combo });
      buzz(18);
      return;
    }
    if (type === 'tap') {
      const strong = payload.kind === 'drag' || payload.kind === 'right';
      buzz(strong ? 18 : 10);
      ripple(payload.kind);
    }
  };

  function round2(v) { return Math.round(v * 100) / 100; }

  const pad = $('pad');
  const hint = $('hint');
  let hinted = false;

  function hideHint() {
    if (hinted) return;
    hinted = true;
    hint.classList.add('hide');
  }

  function ripple(kind) {
    const el = $('ripple');
    const rect = pad.getBoundingClientRect();
    // 用最后一次触点位置；没有就用中心
    const cx = lastTouch ? lastTouch.x - rect.left : rect.width / 2;
    const cy = lastTouch ? lastTouch.y - rect.top : rect.height / 2;
    el.style.left = cx + 'px';
    el.style.top = cy + 'px';
    el.style.borderColor = kind === 'right' ? 'var(--warn)'
      : kind === 'drag' ? 'var(--ok)' : 'var(--accent)';
    el.classList.remove('go');
    void el.offsetWidth;   // 强制重排，让动画重新播放
    el.classList.add('go');
  }

  let lastTouch = null;

  pad.addEventListener('pointerdown', function (e) {
    if (e.target.closest('.hint')) { /* 提示层本身不阻挡 */ }
    hideHint();
    // 体感模式的"按住移动"：按下才响应陀螺仪，不参与触摸板手势
    if (gyroState.enabled && state.cfg.gyroHold) {
      gyroState.armed = true;
      gyro.reset();          // 重新定基准，避免抬手期间角度漂移累积
      updateGyroBadge();
      buzz(8);
      e.preventDefault();
      return;
    }
    pad.setPointerCapture && pad.setPointerCapture(e.pointerId);
    lastTouch = { x: e.clientX, y: e.clientY };
    engine.pointerDown(e.pointerId, e.clientX, e.clientY, performance.now());
    e.preventDefault();
  }, { passive: false });

  pad.addEventListener('pointermove', function (e) {
    if (gyroState.enabled && state.cfg.gyroHold) {
      e.preventDefault();
      return;
    }
    lastTouch = { x: e.clientX, y: e.clientY };
    engine.pointerMove(e.pointerId, e.clientX, e.clientY, performance.now());
    e.preventDefault();
  }, { passive: false });

  pad.addEventListener('pointerup', function (e) {
    if (gyroState.enabled && state.cfg.gyroHold) {
      gyroState.armed = false;
      updateGyroBadge();
      e.preventDefault();
      return;
    }
    lastTouch = { x: e.clientX, y: e.clientY };
    engine.pointerUp(e.pointerId, e.clientX, e.clientY, performance.now());
    e.preventDefault();
  }, { passive: false });

  pad.addEventListener('pointercancel', function (e) {
    if (gyroState.enabled && state.cfg.gyroHold) {
      gyroState.armed = false;
      updateGyroBadge();
      return;
    }
    engine.pointerCancel(e.pointerId, performance.now());
  });

  // 挡掉 iOS 的缩放与橡皮筋
  pad.addEventListener('touchstart', function (e) {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  document.addEventListener('dblclick', function (e) { e.preventDefault(); });

  function frame(now) {
    engine.tick(now);
    tickScrollbar(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ---------- 右侧滚动条 ---------- */

  const scroll = new window.Scrollbar.ScrollbarEngine();
  const scrollbarEl = $('scrollbar');
  const scrollThumb = $('scrollbar-thumb');
  const scrollHintEl = $('scroll-hint');
  let scrollHintTimer = null;

  scroll.onEvent = function (type, payload) {
    if (type !== 'wheel') return;
    // 方向由 scrollbar.js 的 toWheelDelta 统一决定，
    // 这里不要再套「自然滚动」的取反 —— 那会让滚动条方向反过来。
    const dy = window.Scrollbar.toWheelDelta(payload.dy);
    if (!dy) return;
    send({ t: 'wh', dy: dy, dx: 0 });
    showScrollHint(payload.dy, payload.factor);
    buzz(payload.factor && payload.factor > 2.5 ? 10 : 6);
  };

  function showScrollHint(dir, factor) {
    if (!scrollHintEl) return;
    const arrow = dir > 0 ? '↑ ' : '↓ ';
    const speed = factor ? '  ×' + factor.toFixed(1) : '';
    scrollHintEl.textContent = arrow + Math.abs(dir) + speed;
    scrollHintEl.hidden = false;
    // 先强制重排再加 class，否则连续的两次提示不会有过渡动画
    void scrollHintEl.offsetWidth;
    scrollHintEl.classList.add('show');
    clearTimeout(scrollHintTimer);
    scrollHintTimer = setTimeout(function () {
      scrollHintEl.classList.remove('show');
      scrollHintEl.hidden = true;
    }, 450);
  }

  /* 每帧只更新拇指位置，不碰其它属性 —— 拖动时这会是
     每秒 60 次以上的调用，任何多余读写都会让手感变黏。

     倍率超过 2.5 时给滚动条挂上 .fast，光晕扩大一圈。
     巡航时挂 .cruising，让滑块有个"持续滚动中"的呼吸动画。 */
  let scrollFast = false;
  let scrollCruising = false;

  function tickScrollbar(now) {
    const out = scroll.tick(now);
    if (out && scrollThumb) {
      scrollThumb.style.transform = 'translateY(' + out.offset.toFixed(1) + 'px)';
    }

    const fast = scroll.dragging && scroll.factor > 2.5;
    if (fast !== scrollFast) {
      scrollFast = fast;
      scrollbarEl.classList.toggle('fast', fast);
    }

    const cruising = !!scroll.cruising;
    if (cruising !== scrollCruising) {
      scrollCruising = cruising;
      scrollbarEl.classList.toggle('cruising', cruising);
      // 巡航开始时给一次触觉确认，让人知道"松手前它会一直滚"
      if (cruising) buzz(14);
    }
  }

  (function bindScrollbar() {
    if (!scrollbarEl) return;
    const track = scrollbarEl.querySelector('.scrollbar-track');
    if (!track) return;

    track.addEventListener('pointerdown', function (e) {
      // 只响应轨道本身。手指落在两侧留白处时不拦截，
      // 那里仍然属于触摸板，可以正常移动光标。
      scrollbarEl.classList.add('active');
      track.setPointerCapture && track.setPointerCapture(e.pointerId);
      scroll.pointerDown(e.clientY, performance.now());
      hideHint();
      buzz(8);
      e.preventDefault();
      e.stopPropagation();
    }, { passive: false });

    track.addEventListener('pointermove', function (e) {
      if (!scroll.dragging) return;
      scroll.pointerMove(e.clientY, performance.now());
      e.preventDefault();
      e.stopPropagation();
    }, { passive: false });

    function endDrag(e) {
      if (!scroll.dragging) return;
      scroll.pointerUp();
      scrollbarEl.classList.remove('active');
      // 松手时一并清掉快速档与巡航态，否则光晕会残留到下次拖动
      scrollbarEl.classList.remove('fast');
      scrollbarEl.classList.remove('cruising');
      scrollFast = false;
      scrollCruising = false;
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
    }

    track.addEventListener('pointerup', endDrag, { passive: false });
    track.addEventListener('pointercancel', endDrag);
    track.addEventListener('lostpointercapture', function () {
      if (scroll.dragging) {
        scroll.pointerUp();
        scrollbarEl.classList.remove('active');
      }
    });
  })();

  function applyScrollbarConfig() {
    if (!scrollbarEl) return;
    scrollbarEl.classList.toggle('hidden', !state.cfg.showScroll);
    scrollbarEl.classList.toggle('left', !!state.cfg.scrollLeft);
    if (scrollHintEl) {
      scrollHintEl.classList.toggle('at-left', !!state.cfg.scrollLeft);
    }
  }

  /* ---------- 体感控制 ---------- */

  const gyro = new window.Gyro.GyroMapper();
  const HINT = window.Hint;

  /* 把 state.cfg 里的体感参数同步给映射器。
     集中成一个函数是因为有四个地方要调它（启动、握手、面板开关、
     连上后重连），散着写很容易漏掉某一处导致设置不生效。 */
  function applyGyroConfig() {
    gyro.setInvert(state.cfg.gyroInvertX, state.cfg.gyroInvertY);
    gyro.setMaxSpeed(state.cfg.gyroMax, state.cfg.gyroMaxY);
    gyro.setDeadzone(state.cfg.gyroDz);
  }

  const gyroState = {
    supported: typeof window.DeviceMotionEvent !== 'undefined',
    secure: window.isSecureContext === true,
    permission: 'unknown',    // unknown | granted | denied | not-required
    enabled: false,
    armed: false,             // 按住才移动模式下，手指是否在屏幕上
    listening: false,
    source: '—',              // rotationRate | orientation | —
    lastEventAt: 0,
    watching: false,
    fallbackTried: false,
  };

  function refreshGyroDiag() {
    const supportEl = $('gyro-support');
    const secureEl = $('gyro-secure');
    const sourceEl = $('gyro-source');
    const hintEl = $('gyro-hint');

    if (!gyroState.supported) {
      setDiag(supportEl, 'bad', '不支持');
    } else if (gyroState.permission === 'denied') {
      setDiag(supportEl, 'bad', '已拒绝');
    } else if (gyroState.permission === 'granted' || gyroState.permission === 'not-required') {
      setDiag(supportEl, 'ok', '可用');
    } else {
      setDiag(supportEl, 'warn', '待授权');
    }

    if (gyroState.secure) {
      setDiag(secureEl, 'ok', '是（HTTPS）');
    } else {
      setDiag(secureEl, 'bad', '否（HTTP）');
    }

    if (gyroState.source === '—') {
      setDiag(sourceEl, '', '—');
    } else {
      setDiag(sourceEl, 'ok', gyroState.source === 'rotationRate' ? '角速度（直接）' : '姿态角（差分）');
    }

    // 分情况给出可操作的提示，而不是一句"不支持"
    let hint = '';
    if (!gyroState.supported) {
      hint = HINT.buildUnsupportedHint();
    } else if (!gyroState.secure) {
      hint = HINT.buildInsecureHint(location.origin);
    } else if (gyroState.permission === 'denied') {
      hint = HINT.buildDeniedHint();
    } else if (gyroState.permission === 'unknown' && typeof window.DeviceMotionEvent.requestPermission === 'function') {
      hint = HINT.buildPermissionHint();
    }

    if (hint) {
      hintEl.innerHTML = hint;
      hintEl.hidden = false;
      wireCopyButton(hintEl);
    } else {
      hintEl.hidden = true;
    }

    $('btn-gyro-perm').hidden = typeof window.DeviceMotionEvent?.requestPermission !== 'function';
  }

  /* HTTP 下 navigator.clipboard 不存在，必须留一条 execCommand 的回退路径，
     否则点"复制"按钮会静默失败——而那正是用户最需要它工作的时候。 */
  function wireCopyButton(root) {
    const btn = root.querySelector('button.copy');
    if (!btn) return;
    btn.addEventListener('click', function () {
      copyText(btn.dataset.copy, btn);
    });
  }

  function copyText(text, btn) {
    function done() {
      if (!btn) return;
      btn.textContent = '已复制';
      btn.classList.add('done');
      setTimeout(function () {
        btn.textContent = '复制';
        btn.classList.remove('done');
      }, 1500);
    }

    function fallback() {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch (e) {
        if (btn) btn.textContent = '复制失败';
      }
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  function setDiag(el, cls, text) {
    if (!el) return;
    el.textContent = text;
    const row = el.parentElement;
    row.classList.remove('ok', 'bad', 'warn');
    if (cls) row.classList.add(cls);
  }

  async function requestGyroPermission() {
    if (!gyroState.supported) return false;
    const DME = window.DeviceMotionEvent;
    if (typeof DME.requestPermission !== 'function') {
      // 安卓 Chrome 一般不需要授权，直接算通过
      gyroState.permission = 'not-required';
      refreshGyroDiag();
      return true;
    }
    try {
      const result = await DME.requestPermission();
      gyroState.permission = result === 'granted' ? 'granted' : 'denied';
    } catch (e) {
      gyroState.permission = 'denied';
    }
    refreshGyroDiag();
    return gyroState.permission === 'granted';
  }

  /* 传感器事件：优先用 rotationRate（角速度直接映射，无累积误差），
     拿不到就退回 deviceorientation（姿态角差分）。 */
  function onDeviceMotion(e) {
    if (!gyroState.enabled) return;
    gyroState.lastEventAt = performance.now();

    const rr = e.rotationRate;
    let out = null;
    if (rr && typeof rr.gamma === 'number' && typeof rr.beta === 'number') {
      gyroState.source = 'rotationRate';
      out = gyro.feedRotationRate(rr.gamma, rr.beta, e.timeStamp || performance.now());
    } else if (!gyroState.fallbackTried) {
      // rotationRate 为 null 的安卓机不少，启动姿态角回退
      gyroState.fallbackTried = true;
      startOrientationFallback();
    }

    if (out) applyGyroDelta(out);
  }

  function onDeviceOrientation(e) {
    if (!gyroState.enabled) return;
    if (gyroState.source === 'rotationRate') return;  // 主路径已经在工作
    gyroState.source = 'orientation';
    const t = e.timeStamp || performance.now();
    gyroState.lastEventAt = performance.now();
    const out = gyro.feedOrientation(e.beta, e.gamma, t);
    if (out) applyGyroDelta(out);
  }

  function startOrientationFallback() {
    if (gyroState.watching) return;
    window.addEventListener('deviceorientation', onDeviceOrientation, { passive: true });
    gyroState.watching = true;
  }

  function applyGyroDelta(out) {
    if (!gyroState.enabled) return;
    if (gyroState.armed === false && state.cfg.gyroHold) return;

    const dx = out.dx;
    const dy = out.dy;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;

    send({ t: 'mv', dx: round2(dx), dy: round2(dy) });
  }

  async function enableGyro() {
    if (gyroState.enabled) {
      disableGyro();
      return;
    }
    if (!gyroState.supported) {
      alert('这台设备的浏览器不支持运动传感器。');
      return;
    }
    const ok = await requestGyroPermission();
    if (!ok) {
      alert('传感器授权失败。请检查浏览器权限设置，或确认连接的是 HTTPS 地址。');
      return;
    }

    applyGyroConfig();
    gyro.reset();

    gyroState.enabled = true;
    gyroState.fallbackTried = false;
    gyroState.source = '—';
    gyroState.armed = !state.cfg.gyroHold;
    gyroState.lastEventAt = performance.now();

    window.addEventListener('devicemotion', onDeviceMotion, { passive: true });
    gyroState.watching = true;

    updateGyroBadge();
    $('btn-gyro-toggle').textContent = '关闭体感';
    $('btn-gyro-toggle').classList.add('locked');
    pad.classList.add('gyro-active');
    hideHint();
    refreshGyroDiag();

    // 3 秒内没收到任何事件，基本可以断定拿不到数据
    setTimeout(function () {
      if (!gyroState.enabled) return;
      if (performance.now() - gyroState.lastEventAt > 2500 && gyroState.source === '—') {
        gyroState.source = '—';
        refreshGyroDiag();
        const hintEl = $('gyro-hint');
        hintEl.innerHTML = HINT.buildNoDataHint(gyroState.secure);
        hintEl.hidden = false;
      }
    }, 3000);
  }

  function disableGyro() {
    gyroState.enabled = false;
    gyroState.armed = false;
    gyroState.source = '—';
    window.removeEventListener('devicemotion', onDeviceMotion);
    window.removeEventListener('deviceorientation', onDeviceOrientation);
    gyroState.watching = false;
    gyro.reset();
    updateGyroBadge();
    const btn = $('btn-gyro-toggle');
    btn.textContent = '开启体感';
    btn.classList.remove('locked');
    pad.classList.remove('gyro-active', 'gyro-armed');
    setDiag($('gyro-live'), '', '—');
  }

  function updateGyroBadge() {
    let badge = document.getElementById('gyro-badge');
    if (!gyroState.enabled) {
      if (badge) badge.classList.remove('show');
      pad.classList.remove('gyro-armed');
      return;
    }
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'gyro-badge';
      badge.className = 'gyro-badge';
      pad.appendChild(badge);
    }
    const holdMode = state.cfg.gyroHold;
    badge.textContent = holdMode ? (gyroState.armed ? '体感 · 松开即停' : '体感 · 按住移动') : '体感运行中';
    badge.classList.add('show');
    pad.classList.toggle('gyro-armed', holdMode && gyroState.armed);
  }

  // 面板打开时刷新实时读数
  setInterval(function () {
    if (openPanel !== 'gyro') return;
    const liveEl = $('gyro-live');
    if (!liveEl) return;
    if (!gyroState.enabled) {
      liveEl.textContent = '—';
      return;
    }
    const rate = gyro.lastRate;
    if (!rate) {
      liveEl.textContent = '等待数据…';
      return;
    }
    liveEl.textContent = 'γ ' + rate.x.toFixed(1) + '   β ' + rate.y.toFixed(1) + ' °/s';
  }, 120);

  /* ---------- 工具条按键 ---------- */

  document.querySelectorAll('[data-btn]').forEach(function (btn) {
    const name = btn.dataset.btn;
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      pressButton(name);
      buzz(8);
    });
    btn.addEventListener('pointerup', function (e) {
      e.preventDefault();
      releaseButton(name);
    });
    btn.addEventListener('pointercancel', function () {
      releaseButton(name);
    });
    btn.addEventListener('pointerleave', function () {
      // 手指滑出按钮也要放掉，否则会粘住
      releaseButton(name);
    });
  });

  /* ---------- 面板切换 ---------- */

  const panels = {
    type: $('panel-type'),
    files: $('panel-files'),
    media: $('panel-media'),
    keys: $('panel-keys'),
    gyro: $('panel-gyro'),
    settings: $('panel-settings'),
  };

  let openPanel = null;

  const filePanel = new window.FilePanel({ $: $, buzz: buzz });

  function togglePanel(name) {
    // 原本点同一个 tab 会收起面板（toggle 语义）。
    // 但手机上手指点按容易触发两次事件（pointerdown 后又 click），
    // 面板会开了立刻关，看起来像"点了没反应"。
    // 改成幂等：点同一个 tab 保持打开，收起统一用面板里的关闭按钮。
    Object.keys(panels).forEach(function (key) {
      panels[key].hidden = key !== name;
    });
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.panel === name);
    });
    openPanel = name;

    if (name === 'files') {
      filePanel.onShow();
    }
    if (name === 'type') {
      // 稍等一拍再聚焦，否则面板还在过渡时聚焦会被浏览器丢掉
      setTimeout(function () {
        const input = $('type-input');
        if (input && openPanel === 'type') input.focus();
      }, 60);
    }
    if (name === 'gyro') {
      refreshGyroDiag();
    }
  }

  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () { togglePanel(tab.dataset.panel); });
  });

  $('btn-settings').addEventListener('click', function () { togglePanel('settings'); });

  document.querySelectorAll('[data-close]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      Object.keys(panels).forEach(function (k) { panels[k].hidden = true; });
      openPanel = null;
      document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
    });
  });

  /* ---------- 特殊键（原键盘面板，现并入快捷键面板） ---------- */

  const SPECIAL_KEYS = ['up', 'down', 'left', 'right', 'home', 'end',
    'pageup', 'pagedown', 'delete', 'f5', 'f11', 'printscreen'];

  const gridSpecial = $('grid-special');
  SPECIAL_KEYS.forEach(function (key) {
    const btn = document.createElement('button');
    btn.className = 'key';
    btn.textContent = key === 'pageup' ? 'PgUp'
      : key === 'pagedown' ? 'PgDn'
      : key === 'printscreen' ? 'PrtSc'
      : key.toUpperCase();
    btn.addEventListener('click', function () {
      send({ t: 'ky', k: key });
      buzz(8);
    });
    gridSpecial.appendChild(btn);
  });

  document.querySelectorAll('[data-key]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      send({ t: 'ky', k: btn.dataset.key });
      buzz(8);
    });
  });

  /* ---------- 媒体面板 ---------- */

  document.querySelectorAll('[data-media]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      send({ t: 'md', a: btn.dataset.media });
      buzz(8);
    });
  });

  /* ---------- 快捷键面板 ---------- */

  const COMBO_LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

  const gridCombo = $('grid-combo');
  COMBO_LETTERS.forEach(function (ch) {
    const btn = document.createElement('button');
    btn.className = 'key';
    btn.textContent = ch.toUpperCase();
    btn.addEventListener('click', function () {
      const mods = Array.from(state.modLocks);
      send({ t: 'ky', k: mods.concat([ch]).join('+') });
      if (mods.length) clearMods();
      buzz(8);
    });
    gridCombo.appendChild(btn);
  });

  document.querySelectorAll('[data-mod]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const mod = btn.dataset.mod;
      if (state.modLocks.has(mod)) {
        state.modLocks.delete(mod);
        btn.classList.remove('locked');
      } else {
        state.modLocks.add(mod);
        btn.classList.add('locked');
      }
      buzz(8);
    });
  });

  function clearMods() {
    state.modLocks.clear();
    document.querySelectorAll('[data-mod]').forEach(function (b) {
      b.classList.remove('locked');
    });
  }

  /* ---------- 打字面板 ---------- */

  /* 回车发送。两个必须处理好的细节：
   *
   * 1. 输入法组合中不能发送。
   *    中文输入法选词时按回车是"确认候选词"，不是"提交"。
   *    如果不判断 isComposing，用户打"你好"按回车确认候选，
   *    会直接把半截内容发到电脑上，非常烦。
   *    除了 isComposing，keyCode 229 是部分安卓输入法的兼容标记。
   *
   * 2. 换行要单独给按钮。
   *    回车被占用后，想发多行只能靠"换行"按钮插入 \n。
   */

  /* 与服务端 protocol.py 保持一致的上限。
     前端先查一遍，是为了在"点发送之前"就给出准确原因，
     而不是让消息发出去后被服务端丢掉、用户还以为是发成功了。

     两个数字的关系：字符数管普通文本长度，码元数管表情放大注入量。
     表情每个占 2 码元，所以 4096 个表情就会撞到码元上限。 */
  const MAX_TEXT_CHARS = 8192;
  const MAX_TEXT_UNITS = 8192;

  /* JS 的 string.length 就是 UTF-16 码元数，正好等于服务端的
     len(text.encode('utf-16-le')) // 2。emoji 在 JS 里 length 为 2，
     与服务端一致，所以直接比较即可。 */
  function textUnits(s) {
    return s.length;
  }

  /** 返回 null 表示可以发送，否则返回给用户看的原因。 */
  function checkText(s) {
    if (!s.trim()) return '没有内容可发送';

    const units = textUnits(s);
    // 先判码元：表情让 length 翻倍，用户看到的"字数"其实没那么多。
    // 先报"字符超限"会让人困惑——他数了数发现没到 8192。
    if (units > MAX_TEXT_UNITS) {
      return '内容过长（' + units + ' / ' + MAX_TEXT_UNITS
        + '），表情等符号占位较多，请分段发送';
    }
    if (s.length > MAX_TEXT_CHARS) {
      return '文本太长（' + s.length + ' / ' + MAX_TEXT_CHARS + ' 字符），请分段发送';
    }
    return null;
  }

  function typeSubmit() {
    const input = $('type-input');
    const text = input.value;

    const problem = checkText(text);
    if (problem) {
      // 超限时保留输入框内容，不清空 —— 否则用户辛苦打的一段就没了
      showTypeHint(problem, true);
      return;
    }

    if (send({ t: 'tx', s: text })) {
      input.value = '';
      showTypeHint('已发送 ' + text.length + ' 个字符', false);
      buzz(14);
    } else {
      showTypeHint('还没连上电脑，等连接恢复后再发', true);
    }
  }

  function showTypeHint(msg, isErr) {
    const el = $('type-hint');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    el.classList.toggle('err', !!isErr);
    if (el._timer) clearTimeout(el._timer);
    // 成功的提示自动消失，失败的留着让人看见
    if (!isErr) {
      el._timer = setTimeout(function () { el.hidden = true; }, 1800);
    }
  }

  (function bindTypePanel() {
    const input = $('type-input');
    if (!input) return;

    input.addEventListener('keydown', function (e) {
      // isComposing: 输入法正在组合中
      // keyCode 229: 部分安卓输入法在组合期统一报这个键码
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        typeSubmit();
      }
    });

    $('type-send').addEventListener('click', typeSubmit);

    $('type-newline').addEventListener('click', function () {
      // 在光标处插入换行，而不是简单追加到末尾
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const v = input.value;
      input.value = v.slice(0, start) + '\n' + v.slice(end);
      input.selectionStart = input.selectionEnd = start + 1;
      input.focus();
    });

    $('type-clear').addEventListener('click', function () {
      input.value = '';
      input.focus();
      $('type-hint').hidden = true;
    });
  })();

  /* ---------- 设置面板 ---------- */

  function syncSettingsUI() {
    $('sens').value = state.cfg.sens;
    $('sens-val').textContent = Number(state.cfg.sens).toFixed(1);
    $('acc').checked = state.cfg.acc;
    $('nat').checked = state.cfg.nat;
    $('three').checked = state.cfg.three;
    $('haptic').checked = state.cfg.haptic;
    $('token-shown').textContent = token ? token.slice(0, 4) + '…' : '未设置';

    $('gyro-hold').checked = state.cfg.gyroHold;
    $('gyro-invx').checked = state.cfg.gyroInvertX;
    $('gyro-invy').checked = state.cfg.gyroInvertY;
    $('showscroll').checked = state.cfg.showScroll;
    $('scrollleft').checked = state.cfg.scrollLeft;
    $('gyro-speed').value = state.cfg.gyroMax;
    $('gyro-speed-val').textContent = state.cfg.gyroMax;
    $('gyro-speed-y').value = state.cfg.gyroMaxY;
    $('gyro-speed-y-val').textContent = state.cfg.gyroMaxY;
    $('gyro-dz').value = state.cfg.gyroDz;
    $('gyro-dz-val').textContent = Number(state.cfg.gyroDz).toFixed(1);
  }

  function pushConfig() {
    send({
      t: 'cf',
      sens: state.cfg.sens,
      acc: state.cfg.acc,
      nat: state.cfg.nat,
      three: state.cfg.three,
    });
    store.hasSavedConfig = true;
    try {
      localStorage.setItem('remouse.cfg', JSON.stringify(state.cfg));
      localStorage.setItem(CFG_VER_KEY, String(CFG_VERSION));
    } catch (e) { /* 忽略 */ }
  }

  $('sens').addEventListener('input', function (e) {
    state.cfg.sens = parseFloat(e.target.value);
    $('sens-val').textContent = state.cfg.sens.toFixed(1);
    pushConfig();
  });

  $('acc').addEventListener('change', function (e) {
    state.cfg.acc = e.target.checked;
    engine.setAcceleration(state.cfg.acc);
    pushConfig();
  });

  $('nat').addEventListener('change', function (e) {
    state.cfg.nat = e.target.checked;
    pushConfig();
  });

  $('three').addEventListener('change', function (e) {
    state.cfg.three = e.target.checked;
    engine.setThreeFinger(state.cfg.three);
    pushConfig();
  });

  $('haptic').addEventListener('change', function (e) {
    state.cfg.haptic = e.target.checked;
    pushConfig();
  });

  /* ---------- 体感面板交互 ---------- */

  $('btn-gyro-perm').addEventListener('click', async function () {
    const ok = await requestGyroPermission();
    if (ok) buzz(12);
  });

  $('btn-gyro-toggle').addEventListener('click', enableGyro);

  $('gyro-hold').addEventListener('change', function (e) {
    state.cfg.gyroHold = e.target.checked;
    gyroState.armed = !state.cfg.gyroHold;
    updateGyroBadge();
    pushConfig();
  });

  $('gyro-invx').addEventListener('change', function (e) {
    state.cfg.gyroInvertX = e.target.checked;
    gyro.setInvert(state.cfg.gyroInvertX, state.cfg.gyroInvertY);
    pushConfig();
  });

  $('gyro-invy').addEventListener('change', function (e) {
    state.cfg.gyroInvertY = e.target.checked;
    gyro.setInvert(state.cfg.gyroInvertX, state.cfg.gyroInvertY);
    pushConfig();
  });

  $('showscroll').addEventListener('change', function (e) {
    state.cfg.showScroll = e.target.checked;
    applyScrollbarConfig();
    pushConfig();
  });

  $('scrollleft').addEventListener('change', function (e) {
    state.cfg.scrollLeft = e.target.checked;
    applyScrollbarConfig();
    pushConfig();
  });

  $('gyro-speed').addEventListener('input', function (e) {
    state.cfg.gyroMax = parseInt(e.target.value, 10);
    $('gyro-speed-val').textContent = state.cfg.gyroMax;
    gyro.setMaxSpeed(state.cfg.gyroMax, state.cfg.gyroMaxY);
    pushConfig();
  });

  $('gyro-speed-y').addEventListener('input', function (e) {
    state.cfg.gyroMaxY = parseInt(e.target.value, 10);
    $('gyro-speed-y-val').textContent = state.cfg.gyroMaxY;
    gyro.setMaxSpeedY(state.cfg.gyroMaxY);
    pushConfig();
  });

  $('gyro-dz').addEventListener('input', function (e) {
    state.cfg.gyroDz = parseFloat(e.target.value);
    $('gyro-dz-val').textContent = state.cfg.gyroDz.toFixed(1);
    gyro.setDeadzone(state.cfg.gyroDz);
    pushConfig();
  });

  $('btn-forget').addEventListener('click', function () {
    if (!confirm('清除本机保存的令牌？之后需要重新扫码。')) return;
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* 忽略 */ }
    location.reload();
  });

  /* ---------- 生命周期 ---------- */

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      if (!state.connected) {
        state.retry = 0;
        connect();
      }
      requestWakeLock();
      if (gyroState.enabled) {
        gyro.reset();          // 后台期间时间戳跳变，重新定基准
        gyroState.lastEventAt = performance.now();
      }
    } else {
      // 后台先放掉可能按住的键，避免切回来时"粘住"。
      // 必须走 releaseAllButtons：它只发送真正按下过的键。
      // 原来这里无条件发 l/u 和 r/u —— 而锁屏时页面失焦会触发本分支，
      // 于是每次锁屏都凭空补发一个 RIGHTUP，目标窗口收到 WM_RBUTTONUP
      // 就弹出了右键菜单。这就是"锁屏就右键"的根因。
      releaseAllButtons();
      engine.reset();
      gyroState.armed = false;
      updateGyroBadge();
    }
  });

  window.addEventListener('pagehide', function () {
    releaseWakeLock();
    if (gyroState.enabled) disableGyro();
  });

  window.addEventListener('online', function () {
    if (!state.connected) {
      state.retry = 0;
      connect();
    }
  });

  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  document.addEventListener('keydown', function (e) {
    // 桌面上测试时用方向键，手机端不影响
    const map = {
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
      Enter: 'enter', Escape: 'esc', Backspace: 'backspace', Tab: 'tab',
    };
    if (map[e.key] && document.activeElement === document.body) {
      e.preventDefault();
      send({ t: 'ky', k: map[e.key] });
    }
  });

  /* ---------- 启动 ---------- */

  try {
    const saved = JSON.parse(localStorage.getItem('remouse.cfg') || 'null');
    if (saved) {
      Object.assign(state.cfg, saved);
      store.hasSavedConfig = true;

      // 旧版本存下的值要按项丢弃，让新的默认值生效。
      // 只丢这次真正改过的项——用户自己调过的其它设置照旧保留，
      // 不能因为升了个默认值就把人家的手感全抹掉。
      const savedVer = parseInt(localStorage.getItem(CFG_VER_KEY) || '0', 10);
      if (savedVer < CFG_VERSION) {
        delete state.cfg.sens;          // v3：默认 1.6 -> 3.2
        delete state.cfg.gyroMax;       // v2：体感默认值调整
        delete state.cfg.gyroMaxY;
        delete state.cfg.gyroDz;
        delete state.cfg.gyroInvertX;
        delete state.cfg.gyroInvertY;
        // 让服务端下发的默认值能补上被删掉的项
        store.hasSavedConfig = false;
      }
    }
  } catch (e) { /* 忽略 */ }

  syncSettingsUI();
  engine.setThreeFinger(state.cfg.three);
  engine.setAcceleration(state.cfg.acc);
  applyGyroConfig();
  applyScrollbarConfig();
  refreshGyroDiag();
  connect();

  // 手机上把地址栏藏起来；已加主屏幕则直接全屏
  window.addEventListener('load', function () {
    setTimeout(function () { window.scrollTo(0, 1); }, 120);
  });
})();
