/* 体感映射单测：node tests/gyro.test.js
 *
 * 重点是那几个容易被忽略的边界：
 * 死区、满速、帧间隔跳变、角度环绕、以及"第一帧不产生位移"。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Gyro = require(path.join(__dirname, '..', 'web', 'gyro.js'));

const CFG = Gyro.DEFAULTS;

function makeMapper(options) {
  return new Gyro.GyroMapper(options);
}

/* 接口约定：
 *   返回 null          = 输入不可用（传感器没数据 / 非法值）
 *   返回 {dx:0, dy:0}  = 有数据但这一帧不该动（首帧定基准、死区、翻面跳变）
 * 这样调用方只有"数据有没有"一种情况需要判断，位移直接累加即可。
 */

/* ---------- 基础映射 ---------- */

test('第一帧只定基准，不产生位移', function () {
  const m = makeMapper();
  const out = m.feedRotationRate(50, 0, 1000);
  assert.deepStrictEqual(out, { dx: 0, dy: 0 });
});

test('静止时输出为零', function () {
  const m = makeMapper();
  m.feedRotationRate(0, 0, 0);
  for (let t = 16; t < 500; t += 16) {
    const out = m.feedRotationRate(0, 0, t);
    assert.strictEqual(out.dx, 0);
    assert.strictEqual(out.dy, 0);
  }
});

test('gamma 正值让光标向右', function () {
  const m = makeMapper();
  m.feedRotationRate(0, 0, 0);
  let total = 0;
  for (let t = 16; t < 600; t += 16) {
    total += m.feedRotationRate(60, 0, t).dx;
  }
  assert.ok(total > 0, '应该向右移动，实际 ' + total);
});

test('beta 正值让光标向下', function () {
  const m = makeMapper();
  m.feedRotationRate(0, 0, 0);
  let total = 0;
  for (let t = 16; t < 600; t += 16) {
    total += m.feedRotationRate(0, 60, t).dy;
  }
  assert.ok(total > 0, '应该向下移动，实际 ' + total);
});

test('负角速度产生负位移', function () {
  const m = makeMapper();
  m.feedRotationRate(0, 0, 0);
  let total = 0;
  for (let t = 16; t < 600; t += 16) {
    total += m.feedRotationRate(-60, 0, t).dx;
  }
  assert.ok(total < 0, '应该向左移动，实际 ' + total);
});

/* ---------- 死区 ---------- */

test('死区内不动，抑制手抖', function () {
  const m = makeMapper({ deadzone: 4, smoothing: 1 });
  m.feedRotationRate(0, 0, 0);
  for (let t = 16; t < 1000; t += 16) {
    const out = m.feedRotationRate(3.5, -3.5, t);
    assert.strictEqual(out.dx, 0);
    assert.strictEqual(out.dy, 0);
  }
});

test('刚过死区有位移', function () {
  const m = makeMapper({ deadzone: 4, smoothing: 1 });
  m.feedRotationRate(0, 0, 0);
  let total = 0;
  for (let t = 16; t < 600; t += 16) {
    total += m.feedRotationRate(10, 0, t).dx;
  }
  assert.ok(total > 0, '过死区应有位移，实际 ' + total);
});

test('死区可调为 0', function () {
  const m = makeMapper({ deadzone: 0, smoothing: 1 });
  m.feedRotationRate(0, 0, 0);
  let total = 0;
  for (let t = 16; t < 300; t += 16) {
    total += m.feedRotationRate(1, 0, t).dx;
  }
  assert.ok(total > 0);
});

/* ---------- 速度上限 ---------- */

test('超过 maxRate 后速度封顶', function () {
  const m = makeMapper({ smoothing: 1 });
  m.feedRotationRate(0, 0, 0);
  let slow = 0;
  let fast = 0;
  for (let t = 16; t < 400; t += 16) {
    slow += m.feedRotationRate(CFG.maxRate, 0, t).dx;
  }
  const m2 = makeMapper({ smoothing: 1 });
  m2.feedRotationRate(0, 0, 0);
  for (let t = 16; t < 400; t += 16) {
    fast += m2.feedRotationRate(CFG.maxRate * 5, 0, t).dx;
  }
  assert.ok(Math.abs(fast - slow) < 1e-6, `封顶失效: ${slow} vs ${fast}`);
});

test('设置最大速度生效', function () {
  const m = makeMapper({ smoothing: 1, maxPxPerSec: 800 });
  m.feedRotationRate(0, 0, 0);
  let total = 0;
  for (let t = 16; t < 1016; t += 16) {
    total += m.feedRotationRate(CFG.maxRate, 0, t).dx;
  }
  // 约 1 秒满速 ~= 800px（首帧无位移，差一帧）
  assert.ok(total > 600 && total < 900, '实际 ' + total);
});

test('setMaxSpeed 在运行中生效', function () {
  const m = makeMapper({ smoothing: 1 });
  m.feedRotationRate(0, 0, 0);
  m.setMaxSpeed(400);
  let total = 0;
  for (let t = 16; t < 1016; t += 16) {
    total += m.feedRotationRate(CFG.maxRate, 0, t).dx;
  }
  assert.ok(total < 500, '实际 ' + total);
});

/* ---------- 垂直独立速度 ---------- */

/* 屏幕是横向的，手腕上下摆动幅度小于左右，所以垂直需要单独一档速度。
   这里验两件事：两轴互不影响，以及默认值确实 Y 比 X 大。 */
test('垂直默认速度高于水平', function () {
  assert.ok(CFG.maxPxPerSecY > CFG.maxPxPerSec,
    `默认垂直(${CFG.maxPxPerSecY}) 应高于水平(${CFG.maxPxPerSec})`);
});

test('两轴速度互不影响', function () {
  const m = makeMapper({ smoothing: 1, maxPxPerSec: 1000, maxPxPerSecY: 3000 });
  m.feedRotationRate(0, 0, 0);
  let x = 0;
  let y = 0;
  for (let t = 16; t < 1016; t += 16) {
    const out = m.feedRotationRate(CFG.maxRate, CFG.maxRate, t);
    x += out.dx;
    y += out.dy;
  }
  // 同样的角速度输入，垂直位移应约为水平的 3 倍
  const ratio = y / x;
  assert.ok(Math.abs(ratio - 3) < 0.05, `比例异常: ${ratio}`);
});

test('setMaxSpeedY 只改垂直', function () {
  const m = makeMapper({ smoothing: 1, maxPxPerSec: 1000, maxPxPerSecY: 1000 });
  m.feedRotationRate(0, 0, 0);
  m.setMaxSpeedY(2000);
  assert.strictEqual(m.cfg.maxPxPerSec, 1000, '水平不该被改');
  assert.strictEqual(m.cfg.maxPxPerSecY, 2000);

  let x = 0;
  let y = 0;
  for (let t = 16; t < 1016; t += 16) {
    const out = m.feedRotationRate(CFG.maxRate, CFG.maxRate, t);
    x += out.dx;
    y += out.dy;
  }
  assert.ok(y > x * 1.8, `垂直应更快: x=${x} y=${y}`);
});

test('setMaxSpeed 双参数同时设置', function () {
  const m = makeMapper({ smoothing: 1 });
  m.setMaxSpeed(800, 2400);
  assert.strictEqual(m.cfg.maxPxPerSec, 800);
  assert.strictEqual(m.cfg.maxPxPerSecY, 2400);
});

test('setMaxSpeed 单参数不动垂直', function () {
  const m = makeMapper({ smoothing: 1, maxPxPerSec: 1000, maxPxPerSecY: 2000 });
  m.setMaxSpeed(1500);
  assert.strictEqual(m.cfg.maxPxPerSec, 1500);
  assert.strictEqual(m.cfg.maxPxPerSecY, 2000, '单参数调用不该动垂直');
});

test('垂直速度有下限保护', function () {
  const m = makeMapper();
  m.setMaxSpeedY(0);
  assert.ok(m.cfg.maxPxPerSecY >= 100, '不该变成 0 或负数');
  m.setMaxSpeedY(-500);
  assert.ok(m.cfg.maxPxPerSecY >= 100);
  m.setMaxSpeedY('abc');
  assert.ok(isFinite(m.cfg.maxPxPerSecY) && m.cfg.maxPxPerSecY >= 100);
});

test('垂直封顶同样生效', function () {
  const m = makeMapper({ smoothing: 1, maxPxPerSecY: 500 });
  m.feedRotationRate(0, 0, 0);
  let total = 0;
  for (let t = 16; t < 1016; t += 16) {
    total += m.feedRotationRate(0, CFG.maxRate, t).dy;
  }
  assert.ok(total < 600, '实际 ' + total);
});

/* ---------- 帧间隔 ---------- */

test('超大帧间隔被截断，不会一次跳飞', function () {
  const m = makeMapper({ smoothing: 1 });
  m.feedRotationRate(0, 0, 0);
  // 模拟切后台 3 秒后回来
  const out = m.feedRotationRate(CFG.maxRate, 0, 3000);
  const maxStep = CFG.maxPxPerSec * CFG.maxDtMs / 1000;
  assert.ok(out.dx <= maxStep + 0.001, `单帧位移过大: ${out.dx} > ${maxStep}`);
});

test('零帧间隔不会产生 NaN 或 Infinity', function () {
  const m = makeMapper();
  m.feedRotationRate(0, 0, 0);
  const out = m.feedRotationRate(50, 50, 0);
  assert.ok(isFinite(out.dx) && isFinite(out.dy));
});

/* ---------- 反向 ---------- */

test('水平反转生效', function () {
  const m = makeMapper({ smoothing: 1 });
  m.setInvert(true, false);
  m.feedRotationRate(0, 0, 0);
  let total = 0;
  for (let t = 16; t < 600; t += 16) {
    total += m.feedRotationRate(60, 0, t).dx;
  }
  assert.ok(total < 0, '反转后应向左，实际 ' + total);
});

test('垂直反转生效', function () {
  const m = makeMapper({ smoothing: 1 });
  m.setInvert(false, true);
  m.feedRotationRate(0, 0, 0);
  let total = 0;
  for (let t = 16; t < 600; t += 16) {
    total += m.feedRotationRate(0, 60, t).dy;
  }
  assert.ok(total < 0, '反转后应向上，实际 ' + total);
});

test('反向不影响死区', function () {
  const m = makeMapper({ deadzone: 10, smoothing: 1 });
  m.setInvert(true, true);
  m.feedRotationRate(0, 0, 0);
  // deadzone=10，输入 5 应被吃掉
  const out = m.feedRotationRate(5, 5, 16);
  // smoothing=1 时平滑值直接等于输入，但死区判定用的是平滑后的值
  assert.strictEqual(out.dx, 0);
  assert.strictEqual(out.dy, 0);
});

/* ---------- 平滑 ---------- */

test('平滑让突变变缓', function () {
  const m = makeMapper({ smoothing: 0.25 });
  m.feedRotationRate(0, 0, 0);
  const out = m.feedRotationRate(100, 0, 16);
  // 一帧只走到 1/4
  assert.ok(out.dx < CFG.maxPxPerSec * 0.05, '平滑不足: ' + out.dx);
});

test('持续输入后收敛到满速', function () {
  const m = makeMapper({ smoothing: 0.25 });
  m.feedRotationRate(0, 0, 0);
  let out;
  for (let t = 16; t < 2000; t += 16) {
    out = m.feedRotationRate(CFG.maxRate, 0, t);
  }
  const perSec = out.dx * 1000 / 16;
  assert.ok(Math.abs(perSec - CFG.maxPxPerSec) < CFG.maxPxPerSec * 0.1, '实际 ' + perSec);
});

/* ---------- 姿态角回退路径 ---------- */

test('姿态角模式首帧只记基准', function () {
  const m = makeMapper();
  assert.deepStrictEqual(m.feedOrientation(0, 0, 0), { dx: 0, dy: 0 });
});

test('姿态角差分产生位移', function () {
  const m = makeMapper({ smoothing: 1 });
  m.feedOrientation(0, 0, 0);
  let total = 0;
  for (let i = 1; i <= 30; i += 1) {
    total += m.feedOrientation(0, i * 2, i * 16).dx;
  }
  assert.ok(total > 0, '实际 ' + total);
});

test('姿态角接近 ±180 的跳变被忽略', function () {
  const m = makeMapper({ smoothing: 1 });
  m.feedOrientation(0, 179, 0);
  // 翻面导致 179 -> -179
  const out = m.feedOrientation(0, -179, 16);
  assert.deepStrictEqual(out, { dx: 0, dy: 0 });
});

test('姿态角速度被限幅', function () {
  const m = makeMapper({ smoothing: 1 });
  m.feedOrientation(0, 0, 0);
  const out = m.feedOrientation(0, 90, 16); // 16ms 转 90 度 = 5625 deg/s
  const maxStep = CFG.maxPxPerSec * 0.016 * 1.5;
  assert.ok(Math.abs(out.dx) <= maxStep, '未限幅: ' + out.dx);
});

/* ---------- 输入防御 ---------- */

test('null / NaN / 字符串不会崩', function () {
  const m = makeMapper();
  assert.strictEqual(m.feedRotationRate(null, 0, 0), null);
  assert.strictEqual(m.feedRotationRate(NaN, 0, 0), null);
  assert.strictEqual(m.feedRotationRate('5', 0, 0), null);
  assert.strictEqual(m.feedOrientation(undefined, 0, 0), null);
});

test('reset 清空状态', function () {
  const m = makeMapper();
  m.feedRotationRate(50, 50, 0);
  m.feedRotationRate(50, 50, 16);
  assert.ok(m.lastRate);
  m.reset();
  assert.strictEqual(m.lastRate, null);
  // reset 后重新进入"首帧定基准"状态
  assert.deepStrictEqual(m.feedRotationRate(50, 50, 100), { dx: 0, dy: 0 });
});

/* ---------- 状态可读 ---------- */

test('lastRate / lastVelocity 可读，供诊断面板显示', function () {
  const m = makeMapper({ smoothing: 1 });
  m.feedRotationRate(0, 0, 0);
  m.feedRotationRate(60, 30, 16);
  assert.ok(Math.abs(m.lastRate.x - 60) < 1e-6);
  assert.ok(Math.abs(m.lastRate.y - 30) < 1e-6);
  assert.ok(m.lastVelocity.x > 0);
  assert.ok(m.lastVelocity.y > 0);
});
