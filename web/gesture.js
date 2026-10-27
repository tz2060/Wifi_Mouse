/* reMouse 手势状态机
 *
 * 设计约束：
 *  - 纯逻辑，不碰 DOM、不用定时器，靠外部每帧调 tick() 推进。
 *    这样 Node 里可以直接喂坐标序列做单测，不用真的触摸。
 *  - 所有阈值都是 CSS 像素。
 *  - 事件通过 onEvent(type, payload) 往外抛，由 app.js 转成 WebSocket 消息。
 *
 * 输出的 type：
 *   move      {dx, dy, drag}      单指移动（已按帧合并）
 *   button    {btn, action}       d/u/c
 *   wheel     {dy, dx}            行
 *   swipe     {dir}               up/down/left/right（三指，默认关闭）
 *   tap       {kind}              用于触觉反馈/涟漪
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Gesture = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    tapMaxMove: 10,        // 超过就算移动，不算轻点
    tapMaxDuration: 220,   // ms
    doubleTapGap: 280,     // 两次轻点的最大间隔
    doubleTapSlop: 40,     // 两次轻点的位置容差
    dragHoldDelay: 350,    // 按住多久进入拖拽
    scrollLinePx: 40,      // 多少像素算一行滚动
    inertiaDecay: 0.92,    // 惯性衰减系数
    inertiaStop: 0.4,      // 低于此速度（行/帧）停止
    inertiaSmooth: 0.45,   // 速度平滑系数
    swipeMin: 60,          // 三指滑动的最小位移
    scrollMaxLinesPerTick: 6,
    accelLow: 0.85,        // 慢速时的倍率（更精细）
    accelHigh: 2.1,        // 快速时的倍率（更快覆盖远距离）
    accelSlowSpeed: 0.25,  // px/ms，低于此速度用 accelLow
    accelFastSpeed: 2.5,   // px/ms，高于此速度用 accelHigh
  };

  const MODE_IDLE = 'idle';
  const MODE_SINGLE = 'single';
  const MODE_SCROLL = 'scroll';
  const MODE_THREE = 'three';
  const MODE_DRAG = 'drag';

  function dist(ax, ay, bx, by) {
    return Math.hypot(ax - bx, ay - by);
  }

  class GestureEngine {
    constructor(options) {
      this.cfg = Object.assign({}, DEFAULTS, options || {});
      this.threeFinger = false;
      this.acceleration = false;   // 默认关，app.js 按用户设置打开
      this.onEvent = function () {};
      this.reset();
    }

    reset() {
      this.mode = MODE_IDLE;
      this.pointers = new Map();
      this.locked = false;        // 多指手势未完全结束前，禁止剩余手指驱动光标
      this.accumX = 0;
      this.accumY = 0;
      this.scrollAccumPx = 0;     // 待结算的滚动像素
      this.scrollPendingLines = 0;// 不足一行的余量
      this.scrollVelocity = 0;    // 行/帧，平滑后的滚动速度
      this.lastTapTime = -1e9;
      this.lastTapX = 0;
      this.lastTapY = 0;
      this.dragActive = false;
      this.downTime = 0;
      this.startX = 0;
      this.startY = 0;
      this.maxTravel = 0;
      this.inertia = 0;
      this.threeStart = null;
      this.threeEnd = null;
    }

    setThreeFinger(enabled) {
      this.threeFinger = !!enabled;
    }

    setAcceleration(enabled) {
      this.acceleration = !!enabled;
    }

    emit(type, payload) {
      this.onEvent(type, payload || {});
    }

    /* ---------- 指针输入 ---------- */

    pointerDown(id, x, y, t) {
      this.pointers.set(id, { x: x, y: y, x0: x, y0: y });
      const count = this.pointers.size;

      if (count === 1) {
        this.mode = MODE_SINGLE;
        this.locked = false;
        this.dragActive = false;
        this.downTime = t;
        this.startX = x;
        this.startY = y;
        this.maxTravel = 0;
        this.accumX = 0;
        this.accumY = 0;
        this.inertia = 0;
        this.scrollVelocity = 0;
        this.threeStart = null;
        this.threeEnd = null;
        return;
      }

      if (count === 2) {
        // 第二指落下：若正在拖拽先放掉，避免左键粘住
        this.cancelDrag();
        this.mode = MODE_SCROLL;
        this.locked = false;
        this.scrollAccumPx = 0;
        this.scrollPendingLines = 0;
        this.scrollVelocity = 0;
        this.maxTravel = 0;
        this.downTime = t;
        this.startX = x;
        this.startY = y;
        this.inertia = 0;
        this.threeStart = null;
        this.threeEnd = null;
        return;
      }

      // 三指及以上
      this.cancelDrag();
      this.scrollVelocity = 0;
      if (this.threeFinger) {
        this.mode = MODE_THREE;
        const avg = this.averagePoint();
        this.threeStart = { x: avg.x, y: avg.y };
        this.threeEnd = { x: avg.x, y: avg.y };
        this.maxTravel = 0;
      } else {
        // 未开启三指：多余手指忽略，按滚动处理
        this.mode = MODE_SCROLL;
      }
    }

    pointerMove(id, x, y, t) {
      const p = this.pointers.get(id);
      if (!p) return;
      const dx = x - p.x;
      const dy = y - p.y;
      p.x = x;
      p.y = y;

      if (this.locked) return;

      if (this.mode === MODE_SINGLE || this.mode === MODE_DRAG) {
        this.accumX += dx;
        this.accumY += dy;
        this.maxTravel = Math.max(this.maxTravel, dist(x, y, this.startX, this.startY));
        return;
      }

      if (this.mode === MODE_SCROLL) {
        // 两指各贡献一半，累加后即"平均位移"
        this.scrollAccumPx -= dy / 2;
        // 判定"双指轻点"时，每根手指相对自己的落点算位移
        this.maxTravel = Math.max(this.maxTravel, dist(x, y, p.x0, p.y0));
        return;
      }

      if (this.mode === MODE_THREE) {
        const avg = this.averagePoint();
        this.threeEnd = { x: avg.x, y: avg.y };
        if (this.threeStart) {
          this.maxTravel = Math.max(
            this.maxTravel,
            dist(avg.x, avg.y, this.threeStart.x, this.threeStart.y)
          );
        }
        void t;
      }
    }

    pointerUp(id, x, y, t) {
      const p = this.pointers.get(id);
      if (!p) return;
      // 抬手位置可能一跳就结束（没有中间的 move），必须在这里补算位移
      if (typeof x === 'number') {
        p.x = x;
        p.y = y;
      }

      if (this.mode === MODE_SINGLE || this.mode === MODE_DRAG) {
        if (!this.locked) {
          this.maxTravel = Math.max(this.maxTravel, dist(x, y, this.startX, this.startY));
        }
      }
      if (this.mode === MODE_SCROLL && !this.locked) {
        // 每根手指都相对自己的落点算，否则双指轻点会被误判成"大幅移动"
        this.maxTravel = Math.max(this.maxTravel, dist(x, y, p.x0, p.y0));
      }

      this.pointers.delete(id);
      const remaining = this.pointers.size;

      if (this.mode === MODE_DRAG) {
        this.endDrag();
        this.mode = MODE_IDLE;
        this.locked = remaining > 0;
        return;
      }

      if (this.mode === MODE_SINGLE) {
        if (!this.locked &&
            this.maxTravel <= this.cfg.tapMaxMove &&
            t - this.downTime <= this.cfg.tapMaxDuration) {
          this.handleTap(this.startX, this.startY, t);
        }
        this.mode = MODE_IDLE;
        this.locked = remaining > 0;
        return;
      }

      if (this.mode === MODE_SCROLL) {
        if (remaining > 0) {
          // 还有手指没抬：停住内容，但保持 SCROLL 模式以便最后一指结算
          this.locked = true;
          this.scrollAccumPx = 0;
          return;
        }
        // 最后一指抬起：结算
        this.flushScroll(t);
        if (this.maxTravel <= this.cfg.tapMaxMove &&
            t - this.downTime <= this.cfg.tapMaxDuration) {
          this.emit('button', { btn: 'r', action: 'c' });
          this.emit('tap', { kind: 'right' });
        } else {
          this.startInertia();
        }
        this.mode = MODE_IDLE;
        this.locked = false;
        return;
      }

      if (this.mode === MODE_THREE) {
        if (remaining > 0) {
          this.locked = true;
          return;
        }
        if (this.maxTravel >= this.cfg.swipeMin && this.threeStart && this.threeEnd) {
          const dx = this.threeEnd.x - this.threeStart.x;
          const dy = this.threeEnd.y - this.threeStart.y;
          const dir = Math.abs(dx) > Math.abs(dy)
            ? (dx > 0 ? 'right' : 'left')
            : (dy > 0 ? 'down' : 'up');
          this.emit('swipe', { dir: dir });
        }
        this.mode = MODE_IDLE;
        this.locked = false;
        this.threeStart = null;
        this.threeEnd = null;
        return;
      }

      this.mode = MODE_IDLE;
      this.locked = remaining > 0;
    }

    pointerCancel(id, t) {
      this.pointers.delete(id);
      this.cancelDrag();
      this.mode = MODE_IDLE;
      this.locked = this.pointers.size > 0;
      this.scrollAccumPx = 0;
      this.scrollVelocity = 0;
      this.inertia = 0;
      void t;
    }

    /* ---------- 每帧推进 ---------- */

    tick(t) {
      if (this.mode === MODE_SINGLE || this.mode === MODE_DRAG) {
        if (this.mode === MODE_SINGLE && !this.dragActive &&
            t - this.downTime >= this.cfg.dragHoldDelay &&
            this.maxTravel <= this.cfg.tapMaxMove) {
          this.beginDrag();
        }
        this.flushMove();
        return;
      }

      if (this.mode === MODE_SCROLL) {
        this.flushScroll(t);
        return;
      }

      this.tickInertia(t);
    }

    flushMove() {
      const dx = this.accumX;
      const dy = this.accumY;
      this.accumX = 0;
      this.accumY = 0;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

      let scale = 1;
      if (this.acceleration) {
        // 指针加速：慢速滑动更精细，快速滑动覆盖更远
        const speed = Math.hypot(dx, dy) / 16;  // 近似 px/ms（按 60fps 估算）
        const lo = this.cfg.accelSlowSpeed;
        const hi = this.cfg.accelFastSpeed;
        const t = Math.max(0, Math.min(1, (speed - lo) / Math.max(0.001, hi - lo)));
        scale = this.cfg.accelLow + (this.cfg.accelHigh - this.cfg.accelLow) * t;
      }

      this.emit('move', { dx: dx * scale, dy: dy * scale, drag: this.dragActive });
    }

    flushScroll(t) {
      if (!this.scrollAccumPx) return;
      const lines = this.scrollAccumPx / this.cfg.scrollLinePx;
      this.scrollAccumPx = 0;

      // 平滑速度估计，供抬手后的惯性使用
      this.scrollVelocity =
        this.scrollVelocity * (1 - this.cfg.inertiaSmooth) +
        lines * this.cfg.inertiaSmooth;

      this.scrollPendingLines += lines;
      const whole = Math.trunc(this.scrollPendingLines);
      if (whole === 0) return;
      this.scrollPendingLines -= whole;

      const capped = Math.max(
        -this.cfg.scrollMaxLinesPerTick,
        Math.min(this.cfg.scrollMaxLinesPerTick, whole)
      );
      this.emit('wheel', { dy: capped, dx: 0 });
      void t;
    }

    startInertia() {
      const v = this.scrollVelocity;
      this.inertia = Math.abs(v) > this.cfg.inertiaStop ? v : 0;
      this.scrollPendingLines = 0;
    }

    tickInertia(t) {
      if (!this.inertia) return;
      void t;
      this.inertia *= this.cfg.inertiaDecay;
      if (Math.abs(this.inertia) < this.cfg.inertiaStop) {
        this.inertia = 0;
        return;
      }
      this.emit('wheel', { dy: this.inertia > 0 ? 1 : -1, dx: 0 });
    }

    /* ---------- 拖拽 ---------- */

    beginDrag() {
      this.dragActive = true;
      this.mode = MODE_DRAG;
      this.emit('button', { btn: 'l', action: 'd' });
      this.emit('tap', { kind: 'drag' });
    }

    endDrag() {
      if (!this.dragActive) return;
      this.dragActive = false;
      this.flushMove();
      this.emit('button', { btn: 'l', action: 'u' });
    }

    cancelDrag() {
      if (!this.dragActive) return;
      this.dragActive = false;
      this.emit('button', { btn: 'l', action: 'u' });
    }

    /* ---------- 轻点 ---------- */

    handleTap(x, y, t) {
      const withinGap = t - this.lastTapTime <= this.cfg.doubleTapGap;
      const withinSlop = dist(x, y, this.lastTapX, this.lastTapY) <= this.cfg.doubleTapSlop;

      if (withinGap && withinSlop) {
        // 双击不抬 = 直接进入拖拽锁
        this.lastTapTime = -1e9;
        this.beginDrag();
        return;
      }

      this.lastTapTime = t;
      this.lastTapX = x;
      this.lastTapY = y;
      this.emit('button', { btn: 'l', action: 'c' });
      this.emit('tap', { kind: 'left' });
    }

    /* ---------- 辅助 ---------- */

    averagePoint() {
      let sx = 0;
      let sy = 0;
      let n = 0;
      this.pointers.forEach(function (p) {
        sx += p.x;
        sy += p.y;
        n += 1;
      });
      if (n === 0) return { x: 0, y: 0 };
      return { x: sx / n, y: sy / n };
    }

    isBusy() {
      return this.pointers.size > 0 || this.dragActive;
    }
  }

  return { GestureEngine: GestureEngine, DEFAULTS: DEFAULTS };
});
