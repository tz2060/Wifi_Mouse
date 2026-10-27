/* reMouse 体感映射：把手机角速度转换成光标速度
 *
 * 核心决定：不做姿态积分。
 *   对陀螺仪积分能得到"手机指向哪个方向"，但误差会累积，而且手腕
 *   转动角度有限（±90° 就到头了），很快就转不动也调不回来。
 *   直接把角速度当速度用，误差不累积，可以一直转，手感像激光笔，
 *   而且不需要"回中/校准"按钮。
 *
 * 纯逻辑，不碰 DOM、不碰传感器，靠外部喂数据。这样 Node 里能直接测。
 *
 * 输入的角速度单位是 deg/s，输出是这一帧应该移动的像素：
 *   { dx, dy }
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Gyro = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    deadzone: 4,            // deg/s，低于此值视为静止（手抖抑制）
    maxRate: 120,           // deg/s，到这里达到满速
    maxPxPerSec: 1600,      // 水平满速（px/s）
    // 垂直单独一档：屏幕是横向的，手指/手腕上下摆动的幅度本来就比左右小，
    // 用同一个速度会让上下移动明显偏慢，所以默认给得比水平高。
    maxPxPerSecY: 2600,
    exponent: 1.7,          // 响应曲线指数，>1 让慢速更精细
    smoothing: 0.25,        // 低通滤波系数，越小越平滑但越滞后
    maxDtMs: 50,            // 帧间隔上限，防止切后台回来一次跳飞
    minDtMs: 1,
    maxOrientationRate: 600 // 姿态角差分算出的角速度上限（deg/s）
  };

  function clamp(value, low, high) {
    if (value < low) return low;
    if (value > high) return high;
    return value;
  }

  function isNum(value) {
    return typeof value === 'number' && isFinite(value);
  }

  class GyroMapper {
    constructor(options) {
      this.cfg = Object.assign({}, DEFAULTS, options || {});
      this.invertX = false;
      this.invertY = false;
      this.reset();
    }

    reset() {
      this._smoothX = 0;
      this._smoothY = 0;
      this._lastT = 0;
      // 用独立标志表示"已收到过基准帧"。
      // 不能拿 _lastT 是否为零来判断——时间戳完全可能正好是 0，
      // 那样每一帧都会被当成首帧，永远不产生位移。
      this._primed = false;
      this._prevBeta = null;
      this._prevGamma = null;
      this._prevOrientT = 0;
      this.lastRate = null;      // 平滑后的角速度 {x, y} deg/s
      this.lastVelocity = null;  // 换算后的光标速度 {x, y} px/s
    }

    setInvert(invertX, invertY) {
      this.invertX = !!invertX;
      this.invertY = !!invertY;
    }

    /** 水平速度。传两个参数时可分别设置水平与垂直。 */
    setMaxSpeed(pxPerSec, pxPerSecY) {
      const x = Math.max(100, Number(pxPerSec) || DEFAULTS.maxPxPerSec);
      this.cfg.maxPxPerSec = x;
      if (pxPerSecY !== undefined) {
        this.cfg.maxPxPerSecY = Math.max(100, Number(pxPerSecY) || x);
      }
    }

    /** 单独设置垂直速度，不动水平。 */
    setMaxSpeedY(pxPerSecY) {
      this.cfg.maxPxPerSecY =
        Math.max(100, Number(pxPerSecY) || DEFAULTS.maxPxPerSecY);
    }

    setDeadzone(degPerSec) {
      this.cfg.deadzone = Math.max(0, Number(degPerSec) || 0);
    }

    /* ---------- 数据入口 ---------- */

    /** 主路径：直接用 DeviceMotionEvent.rotationRate（deg/s）。
     *  gamma = 绕 Y 轴（左右转手腕）-> 水平
     *  beta  = 绕 X 轴（前后压手腕）-> 垂直
     */
    feedRotationRate(gamma, beta, t) {
      if (!isNum(gamma) || !isNum(beta)) return null;
      return this._step(gamma, beta, t);
    }

    /** 回退路径：部分安卓机 rotationRate 全为 null，
     *  改用 deviceorientation 的姿态角做差分。精度差一些，但能动。
     *  返回 {dx, dy}；输入不合法返回 null。
     */
    feedOrientation(beta, gamma, t) {
      if (!isNum(beta) || !isNum(gamma)) return null;

      if (this._prevBeta === null) {
        this._prevBeta = beta;
        this._prevGamma = gamma;
        this._prevOrientT = t;
        return { dx: 0, dy: 0 };
      }

      const dt = clamp(t - this._prevOrientT, this.cfg.minDtMs, this.cfg.maxDtMs);
      const dGamma = gamma - this._prevGamma;
      const dBeta = beta - this._prevBeta;

      this._prevBeta = beta;
      this._prevGamma = gamma;
      this._prevOrientT = t;

      // 角度环绕：接近 ±180 的跳变是传感器翻面，不能当速度
      if (Math.abs(dGamma) > 180 || Math.abs(dBeta) > 180) {
        return { dx: 0, dy: 0 };
      }

      const limit = this.cfg.maxOrientationRate;
      const rateX = clamp(dGamma / (dt / 1000), -limit, limit);
      const rateY = clamp(dBeta / (dt / 1000), -limit, limit);
      return this._step(rateX, rateY, t);
    }

    /* ---------- 内部 ---------- */

    _step(rateX, rateY, t) {
      if (!this._primed) {
        // 第一帧只用来定基准，不产生位移
        this._primed = true;
        this._lastT = t;
        this._smoothX = rateX;
        this._smoothY = rateY;
        return { dx: 0, dy: 0 };
      }

      const dt = clamp(t - this._lastT, this.cfg.minDtMs, this.cfg.maxDtMs);
      this._lastT = t;

      const a = this.cfg.smoothing;
      this._smoothX += a * (rateX - this._smoothX);
      this._smoothY += a * (rateY - this._smoothY);
      this.lastRate = { x: this._smoothX, y: this._smoothY };

      const vx0 = this._rateToSpeed(this._smoothX, this.cfg.maxPxPerSec) *
        (this.invertX ? -1 : 1);
      const vy0 = this._rateToSpeed(this._smoothY, this.cfg.maxPxPerSecY) *
        (this.invertY ? -1 : 1);
      // `|| 0` 把 -0 归一成 0：反向 × 零速会产生 -0，
      // 它不影响计算，但会让日志和断言里出现难看的 -0。
      const vx = vx0 || 0;
      const vy = vy0 || 0;
      this.lastVelocity = { x: vx, y: vy };

      return { dx: vx * dt / 1000 || 0, dy: vy * dt / 1000 || 0 };
    }

    _rateToSpeed(rate, maxPxPerSec) {
      const dz = this.cfg.deadzone;
      const mag = Math.abs(rate);
      if (mag <= dz) return 0;

      const span = Math.max(1, this.cfg.maxRate - dz);
      const t = Math.min(1, (mag - dz) / span);
      return Math.sign(rate) * Math.pow(t, this.cfg.exponent) * maxPxPerSec;
    }
  }

  return { GyroMapper: GyroMapper, DEFAULTS: DEFAULTS };
});
