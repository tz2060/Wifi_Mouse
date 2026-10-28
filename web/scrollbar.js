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
    linePx: 24,            // 拖动多少像素算滚一行（1 倍速时）
    maxOffset: 160,        // 拇指相对中心的视觉行程上限
    maxLinesPerTick: 16,   // 单次结算最多滚几行，防止一次跳太远
    springDecay: 0.78,     // 回弹每帧衰减，越小回得越快
    springStop: 0.5,       // 低于此偏移直接归零
    minFactor: 1,          // 居中时的滚动倍率
    maxFactor: 3,          // 拖到最远处时的滚动倍率

    // ---- 按住不停（巡航）----
    // 手指停住但没松开时，按最后的滑动速度持续滚动。
    cruiseDelay: 80,           // ms，静止多久后进入巡航
    // 手指静止的判定阈值（px/帧）。
    //
    // 触摸屏不会真正静止：按住不动时触摸层仍持续上报亚像素抖动，
    // 而且不同屏幕、不同手指压力下抖动幅度差别很大
    // （实测有的屏 ±0.4px，有的能达到 ±3px）。
    // 阈值偏小的话，按住后每帧抖动都被当成"真实滑动"，
    // 巡航刚启动就被取消，表现为"按住别松但页面不滚"。
    // 取 4px：正常滑动单帧通常 8px 以上，仍能准确区分。
    jitterPx: 4,
    // 巡航速度上限（行/秒）。手滑得越快滚得越多，这里封顶 80 行/秒。
    maxCruiseLinesPerSec: 80,
    // 巡航速度下限（行/秒）。手指停下前往往已经自然减速到很低的速度，
    // 直接沿用那个速度几乎等于不滚。给个下限，保证"按住"必定有可感知的滚动。
    minCruiseLinesPerSec: 8,
    velocitySmooth: 0.4,       // 速度估计的平滑系数
    maxDtMs: 50,               // 单帧时间上限，防止切后台回来跳一大截
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
      this.factor = this.cfg.minFactor;  // 当前倍率，供 UI 显示

      // ---- 巡航状态 ----
      this.cruising = false;        // 手指没动但仍在滚
      this.velocity = 0;            // px/ms，手指的瞬时速度（向下为正）
      this._lastMoveT = 0;          // 上一次"有效移动"的时间
      this._lastTickT = 0;          // 上一次 tick 的时间，用于算 dt
      // 静止判定不逐帧看，而是累积：慢速拖动单帧位移很小，
      // 若逐帧按阈值丢弃，手指慢慢移动就完全失效了（一行都不滚）。
      // 这里把位移累积起来，超过阈值才认为是"真的动了"。
      this._accumDy = 0;
    }

    emit(type, payload) {
      this.onEvent(type, payload || {});
    }

    /* ---------- 输入 ---------- */

    pointerDown(y, t) {
      this.dragging = true;
      this.cruising = false;
      this.velocity = 0;
      this._lastY = y;
      this._pendingPx = 0;
      this._accumDy = 0;
      this._lastMoveT = typeof t === 'number' ? t : 0;
      this._lastTickT = this._lastMoveT;
    }

    pointerMove(y, t) {
      if (!this.dragging) return;
      const dy = y - this._lastY;
      const now = typeof t === 'number' ? t : 0;
      this._lastY = y;

      // 触摸屏按住不动时会持续上报亚像素抖动。
      // 用"累积位移"判定，而不是逐帧看 dy：
      //   逐帧看 -> 慢速拖动（每帧 3px）会被当抖动全部丢弃，慢挪就失效
      //   累积看 -> 慢速拖动攒几帧后超过阈值，正常滚动；而原地抖动正负抵消，攒不起来
      this._accumDy += dy;
      if (Math.abs(this._accumDy) < this.cfg.jitterPx) return;

      // 累积量达到阈值，用累积值作为这次的真实位移
      const step = this._accumDy;
      this._accumDy = 0;

      // 用手指标的真实帧间隔估速度，而不是假设 16ms。
      // 不同手机的触摸采样率差别很大（60~240Hz）。
      let dt = now - this._lastMoveT;
      if (dt > 0) {
        dt = Math.min(dt, this.cfg.maxDtMs);
        const instant = step / dt;   // px/ms
        const a = this.cfg.velocitySmooth;
        this.velocity += a * (instant - this.velocity);
      }
      this._lastMoveT = now;

      // 真的动了才退出巡航，回到直接跟手
      this.cruising = false;
      this._drag(step);
    }

    pointerUp() {
      this.dragging = false;
      this.cruising = false;
      this.velocity = 0;
      this._pendingPx = 0;   // 剩余的零头丢掉，避免回弹时补滚一下
      this._accumDy = 0;
      this.factor = this.cfg.minFactor;
    }

    /* ---------- 每帧推进 ---------- */

    /** 返回当前应该渲染的偏移；没有变化返回 null。
     *
     *  按住不放时：手指静止超过 cruiseDelay 后，按最后的速度持续滚动。
     *              这正是"不松开就一直滚下去"。
     *  松手后：    回弹归零。 */
    tick(t) {
      const now = typeof t === 'number' ? t : 0;

      if (this.dragging) {
        // 进入/维持巡航：手指停住但没松开
        const idle = now - this._lastMoveT;
        if (idle >= this.cfg.cruiseDelay && this.velocity !== 0) {
          if (!this.cruising) {
            this.cruising = true;
            this._lastTickT = now || this._lastMoveT;
          }
          this._cruiseStep(now);
        } else {
          this.cruising = false;
          this._lastTickT = now;
        }
        return { offset: this.offset, cruising: this.cruising };
      }

      if (!this.offset) return null;

      this.offset *= this.cfg.springDecay;
      if (Math.abs(this.offset) < this.cfg.springStop) {
        this.offset = 0;
        return { offset: 0 };
      }
      return { offset: this.offset };
    }

    /* 巡航时按"行/秒"推进，与帧率无关。
       如果按每帧固定行数推进，60Hz 和 120Hz 手机上滚动手感会差一倍。 */
    _cruiseStep(now) {
      if (!this._lastTickT) {
        this._lastTickT = now;
        return;
      }
      let dt = now - this._lastTickT;
      this._lastTickT = now;
      if (dt <= 0) return;
      dt = Math.min(dt, this.cfg.maxDtMs);
      const secs = dt / 1000;

      // 手指速度（px/ms）换算成巡航的滚动量：
      // 滑得快 -> 每毫秒滚更多行。再乘当前倍率。
      let perSec = (this.velocity * 1000 / this.cfg.linePx) * this.factor;

      // 下限只对"已经开始巡航且方向明确"生效。
      // 用速度的符号决定方向，大小提到下限，
      // 这样即使手指停下前已经减速到很低，按住仍有可感知的滚动。
      const sign = perSec < 0 ? -1 : 1;
      const mag = Math.abs(perSec);
      if (mag < this.cfg.minCruiseLinesPerSec) {
        perSec = sign * this.cfg.minCruiseLinesPerSec;
      }

      // 上限：避免顺手一甩就飞到底
      perSec = clamp(perSec, -this.cfg.maxCruiseLinesPerSec, this.cfg.maxCruiseLinesPerSec);

      let lines = perSec * secs;
      this._pendingPx += -lines * this.cfg.linePx;
      this._flush();

      // 巡航时拇指停在原处不动 —— 位置代表"速度档位"，不是滚动进度。
      // 所以这里不再改 offset。
    }

    /* ---------- 内部 ---------- */

    _drag(dy) {
      const before = this.offset;
      const next = clamp(before + dy, -this.cfg.maxOffset, this.cfg.maxOffset);
      const actual = next - before;
      this.offset = next;

      // 倍率随离中心的距离增大：中心 1 倍，拖到最远 4 倍。
      // 用拖动后的偏移来算，这样手感是连续渐进的，
      // 不会在某个临界点上突然跳一档。
      this.factor = this._factorFor(this.offset);

      // 向下拖（actual > 0）应当往后翻内容，而 Windows 的 wh 约定是
      // dy < 0 表示滚向文档后段，所以这里取负。
      //
      // 注意：这个方向是固定的，不跟随「自然滚动」开关。
      // 双指滑动是"推纸"隐喻，滚动条是"拖滑块"隐喻，两者方向本来就相反。
      // 真实系统里自然滚动也只影响手势，不影响拖滚动条。
      this._pendingPx += -actual * this.factor;
      this._flush();
    }

    /* 离中心越远滚得越快。
       线性插值就够：拖到一半是 2.5 倍，符合直觉且没有突变感。 */
    _factorFor(offset) {
      const lo = this.cfg.minFactor;
      const hi = this.cfg.maxFactor;
      const ratio = Math.min(1, Math.abs(offset) / Math.max(1, this.cfg.maxOffset));
      return lo + (hi - lo) * ratio;
    }

    _flush() {
      const lines = this._pendingPx / this.cfg.linePx;
      const whole = Math.trunc(lines);
      if (whole === 0) return;

      const cap = this.cfg.maxLinesPerTick;
      const capped = clamp(whole, -cap, cap);

      if (whole !== capped) {
        // 触到上限：多出来的量必须丢掉，不能留着。
        //
        // 加速度让一次大拖能积累很高的倍率，如果按"实际发出"扣减、
        // 余额留着，那么手指之后只需微动 1px 就会把积压一口气吐出来，
        // 表现为"轻轻一碰光标又滚了十几行"。
        // 上限的语义是"这一帧最多滚这么多"，超出的部分本来就该作废。
        this._pendingPx = 0;
      } else {
        // 没触顶：只扣掉已发出的整行，零头留给下一帧凑。
        this._pendingPx -= capped * this.cfg.linePx;
      }

      this.lastLines = capped;
      this.emit('wheel', { dy: capped, factor: this.factor });
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
