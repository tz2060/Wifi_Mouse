/* reMouse 右侧滚动条：拖动模拟鼠标滚轮
 *
 * 为什么要有它：
 *   双指滑动也能滚动，但那是"手势"，手感和滚轮完全不同 ——
 *   手指会滑到屏幕边缘就没地方了。滚动条给了一个固定的、
 *   可以无限循环拖动的着力点，接近真实滚轮的体感。
 *
 * 关键设计：松手回弹（弹簧）
 *   不做回弹的话，滑条拖到顶端就卡住了，只能松手再拖，
 *   拖到底最多也就 ±160px 的行程。做了回弹，位置永远从中心出发，
 *   可以无限拖，和真实滚轮一样。
 *
 * 纯逻辑，不碰 DOM、不用定时器：
 *   靠外部每帧调 tick() 推进，Node 里可以直接喂坐标序列做单测。
 *
 * 输出事件：
 *   wheel { dy }   dy 为正 = 向上滚（负号由调用方按"自然滚动"设置再决定）
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Scrollbar = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    linePx: 24,            // 拖动多少像素算滚一行
    maxOffset: 160,        // 拇指相对中心的视觉行程上限
    maxLinesPerTick: 6,    // 单次结算最多滚几行，防止一次跳太远
    springDecay: 0.78,     // 回弹每帧衰减，越小回得越快
    springStop: 0.5,       // 低于此偏移直接归零
  };

  function clamp(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  class ScrollbarEngine {
    constructor(options) {
      this.cfg = Object.assign({}, DEFAULTS, options || {});
      this.onEvent = function () {};
      this.reset();
    }

    reset() {
      this.offset = 0;        // 拇指相对中心的偏移（px，向下为正）
      this.dragging = false;
      this._lastY = 0;
      this._pendingPx = 0;    // 还没结算成一整行的像素
      this.lastLines = 0;     // 最近一次结算滚了几行，供 UI 显示
    }

    emit(type, payload) {
      this.onEvent(type, payload || {});
    }

    /* ---------- 输入 ---------- */

    pointerDown(y) {
      this.dragging = true;
      this._lastY = y;
      this._pendingPx = 0;
    }

    pointerMove(y) {
      if (!this.dragging) return;
      const dy = y - this._lastY;
      this._lastY = y;
      if (!dy) return;
      this._drag(dy);
    }

    pointerUp() {
      this.dragging = false;
      this._pendingPx = 0;   // 剩余的零头丢掉，避免回弹时补滚一下
    }

    /* ---------- 每帧推进 ---------- */

    /** 返回当前应该渲染的偏移；没有变化返回 null。 */
    tick() {
      if (this.dragging) return { offset: this.offset };
      if (!this.offset) return null;

      this.offset *= this.cfg.springDecay;
      if (Math.abs(this.offset) < this.cfg.springStop) {
        this.offset = 0;
        return { offset: 0 };
      }
      return { offset: this.offset };
    }

    /* ---------- 内部 ---------- */

    _drag(dy) {
      const before = this.offset;
      const next = clamp(before + dy, -this.cfg.maxOffset, this.cfg.maxOffset);
      const actual = next - before;
      this.offset = next;

      // 向下拖（actual > 0）应当往后翻内容，而 Windows 的 wh 约定是
      // dy < 0 表示滚向文档后段，所以这里取负。
      //
      // 注意：这个方向是固定的，不跟随「自然滚动」开关。
      // 双指滑动是"推纸"隐喻，滚动条是"拖滑块"隐喻，两者方向本来就相反。
      // 真实系统里自然滚动也只影响手势，不影响拖滚动条。
      this._pendingPx += -actual;
      this._flush();
    }

    _flush() {
      const lines = this._pendingPx / this.cfg.linePx;
      const whole = Math.trunc(lines);
      if (whole === 0) return;

      const cap = this.cfg.maxLinesPerTick;
      const capped = clamp(whole, -cap, cap);

      // 按"实际发出"的量扣减。若按 whole 扣减，
      // 被上限截掉的那部分会一直攒着，下一帧再涌出来。
      this._pendingPx -= capped * this.cfg.linePx;
      this.lastLines = capped;
      this.emit('wheel', { dy: capped });
    }
  }

  /* 把引擎输出的 dy 翻译成发给系统的 wh dy。
   *
   * 单独抽成函数是因为这里曾经出过 bug：最初让滚动条复用双指滑动的
   * 「自然滚动」取反逻辑，结果方向整个反了。
   *
   * 两者是不同的物理隐喻，不能共用：
   *   双指滑动 = 推纸：手指向下 -> 内容上移 -> 看到更早的内容
   *   滚动条   = 拖滑块：拇指向下 -> 视口向后 -> 看到更晚的内容
   *
   * 真实系统里「自然滚动」也只影响手势，不影响拖动滚动条。
   * 所以这个函数刻意不接收 nat 参数——传进来就意味着又会有人把它取反。
   *
   * 引擎的 dy 已经是"向上为正"，与 Windows wh 约定一致，原样返回。
   */
  function toWheelDelta(dy) {
    if (typeof dy !== 'number' || !isFinite(dy)) return 0;
    if (!dy) return 0;
    return dy;
  }

  return {
    ScrollbarEngine: ScrollbarEngine,
    toWheelDelta: toWheelDelta,
    DEFAULTS: DEFAULTS,
  };
});
