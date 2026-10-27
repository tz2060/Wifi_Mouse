/* 手势状态机单测（Node 直接跑，不需要浏览器）

   用 node --test tests/gesture.test.js 运行。
   这里断言的是"事件序列"而不是内部状态，因为 app.js 只依赖事件流。
*/
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Gesture = require(path.join(__dirname, '..', 'web', 'gesture.js'));

const CFG = Gesture.DEFAULTS;

function makeEngine(options) {
  const engine = new Gesture.GestureEngine(options);
  const events = [];
  engine.onEvent = function (type, payload) {
    events.push({ type: type, payload: payload });
  };
  return { engine: engine, events: events };
}

function types(events) {
  return events.map(function (e) { return e.type; });
}

function firstOf(events, type) {
  return events.filter(function (e) { return e.type === type; });
}

/* ---------- 单指移动 ---------- */

test('单指滑动产生 move 事件', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.pointerDown(1, 100, 100, 0);
  e.pointerMove(1, 120, 110, 16);
  e.tick(16);
  e.pointerUp(1, 120, 110, 32);

  const moves = firstOf(ctx.events, 'move');
  assert.strictEqual(moves.length, 1);
  assert.strictEqual(moves[0].payload.dx, 20);
  assert.strictEqual(moves[0].payload.dy, 10);
  assert.ok(!types(ctx.events).includes('button'), '滑动不应触发点击');
});

test('移动量小于半个像素不发送', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(1, 100, 100, 0);
  ctx.engine.pointerMove(1, 100.2, 100.1, 16);
  ctx.engine.tick(16);
  assert.strictEqual(firstOf(ctx.events, 'move').length, 0);
});

test('一帧内多次移动会被合并', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.pointerDown(1, 0, 0, 0);
  e.pointerMove(1, 10, 0, 4);
  e.pointerMove(1, 20, 0, 8);
  e.pointerMove(1, 30, 0, 12);
  e.tick(16);
  const moves = firstOf(ctx.events, 'move');
  assert.strictEqual(moves.length, 1);
  assert.strictEqual(moves[0].payload.dx, 30);
});

/* ---------- 轻点 ---------- */

test('位移小且时间短的抬起算左键单击', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.pointerDown(1, 100, 100, 0);
  e.pointerUp(1, 103, 102, 50);

  const clicks = firstOf(ctx.events, 'button').filter(function (b) {
    return b.payload.btn === 'l' && b.payload.action === 'c';
  });
  assert.strictEqual(clicks.length, 1);
});

test('按住超过 tapMaxDuration 不算轻点', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.pointerDown(1, 100, 100, 0);
  // 超过 220ms 但没有进入拖拽（未 tick 到 350ms）
  e.pointerUp(1, 100, 100, CFG.tapMaxDuration + 10);
  assert.strictEqual(firstOf(ctx.events, 'button').length, 0);
});

test('位移超过阈值不算轻点', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.pointerDown(1, 100, 100, 0);
  e.pointerUp(1, 100 + CFG.tapMaxMove + 5, 100, 40);
  assert.strictEqual(firstOf(ctx.events, 'button').length, 0);
});

test('快速双击同一点进入拖拽而不是两次单击', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.pointerDown(1, 100, 100, 0);
  e.pointerUp(1, 100, 100, 40);
  e.pointerDown(2, 101, 101, 120);
  e.pointerUp(2, 101, 101, 160);

  const btns = firstOf(ctx.events, 'button');
  const clicks = btns.filter(function (b) { return b.payload.action === 'c'; });
  const downs = btns.filter(function (b) { return b.payload.action === 'd'; });
  assert.strictEqual(clicks.length, 1, '第一次轻点算单击');
  assert.strictEqual(downs.length, 1, '第二次应进入拖拽按下');
  assert.strictEqual(downs[0].payload.btn, 'l');
});

test('间隔过长的两次轻点算两次单击', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.pointerDown(1, 100, 100, 0);
  e.pointerUp(1, 100, 100, 40);
  e.pointerDown(2, 100, 100, 40 + CFG.doubleTapGap + 50);
  e.pointerUp(2, 100, 100, 40 + CFG.doubleTapGap + 90);

  const clicks = firstOf(ctx.events, 'button').filter(function (b) {
    return b.payload.action === 'c';
  });
  assert.strictEqual(clicks.length, 2);
});

/* ---------- 长按拖拽 ---------- */

test('长按后进入拖拽并在抬起时释放', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.pointerDown(1, 100, 100, 0);
  e.tick(CFG.dragHoldDelay + 20);
  e.pointerMove(1, 150, 100, CFG.dragHoldDelay + 40);
  e.tick(CFG.dragHoldDelay + 40);
  e.pointerUp(1, 150, 100, CFG.dragHoldDelay + 60);

  const btns = firstOf(ctx.events, 'button');
  const actions = btns.map(function (b) { return b.payload.action; });
  assert.strictEqual(actions[0], 'd');
  assert.strictEqual(actions[actions.length - 1], 'u');
});

test('拖拽中的 move 带 drag 标记', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.pointerDown(1, 100, 100, 0);
  e.tick(CFG.dragHoldDelay + 20);
  e.pointerMove(1, 140, 100, CFG.dragHoldDelay + 30);
  e.tick(CFG.dragHoldDelay + 40);

  const moves = firstOf(ctx.events, 'move');
  assert.ok(moves.some(function (m) { return m.payload.drag === true; }));
});

test('拖拽中途加第二指会释放左键，不会粘住', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.pointerDown(1, 100, 100, 0);
  e.tick(CFG.dragHoldDelay + 20);
  e.pointerDown(2, 200, 200, CFG.dragHoldDelay + 30);

  const ups = firstOf(ctx.events, 'button').filter(function (b) {
    return b.payload.action === 'u';
  });
  assert.strictEqual(ups.length, 1);
});

/* ---------- 双指滚动 ---------- */

test('双指滑动产生滚动事件', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.pointerDown(1, 100, 200, 0);
  e.pointerDown(2, 200, 200, 2);
  // 两指一起向上移动 80px = 2 行（每行 40px）
  e.pointerMove(1, 100, 120, 16);
  e.pointerMove(2, 200, 120, 18);
  e.tick(32);
  e.pointerUp(1, 100, 120, 40);
  e.pointerUp(2, 200, 120, 42);

  const wheels = firstOf(ctx.events, 'wheel');
  assert.ok(wheels.length >= 1, '应产生滚动');
  const total = wheels.reduce(function (sum, w) { return sum + w.payload.dy; }, 0);
  assert.ok(Math.abs(total) >= 1, '滚动总量应至少 1 行, 实际 ' + total);
});

test('双指轻点产生右键单击', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.pointerDown(1, 100, 200, 0);
  e.pointerDown(2, 200, 200, 2);
  e.pointerUp(1, 100, 200, 60);
  e.pointerUp(2, 200, 200, 62);

  const rights = firstOf(ctx.events, 'button').filter(function (b) {
    return b.payload.btn === 'r' && b.payload.action === 'c';
  });
  assert.strictEqual(rights.length, 1);
});

test('双指滚动不产生左键点击', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.pointerDown(1, 100, 300, 0);
  e.pointerDown(2, 200, 300, 2);
  e.pointerMove(1, 100, 200, 16);
  e.pointerMove(2, 200, 200, 18);
  e.tick(32);
  e.pointerUp(1, 100, 200, 40);
  e.pointerUp(2, 200, 200, 42);

  const lefts = firstOf(ctx.events, 'button').filter(function (b) {
    return b.payload.btn === 'l';
  });
  assert.strictEqual(lefts.length, 0);
});

/* ---------- 三指手势（默认关闭） ---------- */

test('三指手势默认关闭：三指不应触发 swipe', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  assert.strictEqual(e.threeFinger, false);

  e.pointerDown(1, 100, 300, 0);
  e.pointerDown(2, 200, 300, 2);
  e.pointerDown(3, 300, 300, 4);
  e.pointerMove(1, 100, 200, 20);
  e.pointerMove(2, 200, 200, 22);
  e.pointerMove(3, 300, 200, 24);
  e.tick(30);
  e.pointerUp(1, 100, 200, 40);
  e.pointerUp(2, 200, 200, 42);
  e.pointerUp(3, 300, 200, 44);

  assert.strictEqual(firstOf(ctx.events, 'swipe').length, 0);
});

test('开启三指后上滑触发 swipe up', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.setThreeFinger(true);

  e.pointerDown(1, 100, 300, 0);
  e.pointerDown(2, 200, 300, 2);
  e.pointerDown(3, 300, 300, 4);
  e.pointerMove(1, 100, 200, 20);
  e.pointerMove(2, 200, 200, 22);
  e.pointerMove(3, 300, 200, 24);
  e.tick(30);
  e.pointerUp(1, 100, 200, 40);
  e.pointerUp(2, 200, 200, 42);
  e.pointerUp(3, 300, 200, 44);

  const swipes = firstOf(ctx.events, 'swipe');
  assert.strictEqual(swipes.length, 1);
  assert.strictEqual(swipes[0].payload.dir, 'up');
});

test('三指位移不足不触发 swipe', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.setThreeFinger(true);

  e.pointerDown(1, 100, 300, 0);
  e.pointerDown(2, 200, 300, 2);
  e.pointerDown(3, 300, 300, 4);
  e.pointerMove(1, 100, 290, 10);
  e.pointerMove(2, 200, 290, 12);
  e.pointerMove(3, 300, 290, 14);
  e.pointerUp(1, 100, 290, 20);
  e.pointerUp(2, 200, 290, 22);
  e.pointerUp(3, 300, 290, 24);

  assert.strictEqual(firstOf(ctx.events, 'swipe').length, 0);
});

/* ---------- 惯性 ---------- */

test('滚动抬手后产生惯性并最终停下', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.pointerDown(1, 100, 300, 0);
  e.pointerDown(2, 200, 300, 2);
  for (let i = 1; i <= 8; i += 1) {
    e.pointerMove(1, 100, 300 - i * 20, i * 16);
    e.pointerMove(2, 200, 300 - i * 20, i * 16 + 2);
    e.tick(i * 16);
  }
  e.pointerUp(1, 100, 140, 140);
  e.pointerUp(2, 200, 140, 142);

  const beforeInertia = firstOf(ctx.events, 'wheel').length;

  // 推进很多帧，惯性总共应产生有限次数后停止
  for (let t = 150; t < 3000; t += 16) {
    e.tick(t);
  }
  const afterInertia = firstOf(ctx.events, 'wheel').length;
  assert.ok(afterInertia > beforeInertia, '应有惯性滚动');
  assert.ok(afterInertia - beforeInertia < 200, '惯性应衰减停止，实际 ' + (afterInertia - beforeInertia));

  const tail = afterInertia;
  for (let t = 3000; t < 4000; t += 16) {
    e.tick(t);
  }
  assert.strictEqual(firstOf(ctx.events, 'wheel').length, tail, '惯性必须停住');
});

/* ---------- 指针加速 ---------- */

test('默认不做加速：位移原样输出', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  assert.strictEqual(e.acceleration, false);
  e.pointerDown(1, 0, 0, 0);
  e.pointerMove(1, 40, 0, 16);
  e.tick(16);
  const moves = firstOf(ctx.events, 'move');
  assert.strictEqual(moves[0].payload.dx, 40);
});

test('开启加速后快速滑动位移被放大', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.setAcceleration(true);
  e.pointerDown(1, 0, 0, 0);
  e.pointerMove(1, 200, 0, 16);   // 速度 12.5 px/ms，属于快速
  e.tick(16);
  const moves = firstOf(ctx.events, 'move');
  assert.ok(moves[0].payload.dx > 200, '快速滑动应放大，实际 ' + moves[0].payload.dx);
});

test('开启加速后慢速滑动位移被缩小（更精细）', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.setAcceleration(true);
  e.pointerDown(1, 0, 0, 0);
  e.pointerMove(1, 2, 0, 16);     // 速度 0.125 px/ms，属于慢速
  e.tick(16);
  const moves = firstOf(ctx.events, 'move');
  assert.ok(moves[0].payload.dx < 2, '慢速滑动应缩小，实际 ' + moves[0].payload.dx);
  assert.ok(moves[0].payload.dx > 0, '方向不能翻转');
});

test('加速不影响点击判定（阈值用原始像素）', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.setAcceleration(true);
  e.pointerDown(1, 100, 100, 0);
  e.pointerUp(1, 100 + CFG.tapMaxMove + 1, 100, 40);
  assert.strictEqual(firstOf(ctx.events, 'button').length, 0);
});

/* ---------- 复位 ---------- */

test('reset 清空所有状态，不在拖拽中残留按键', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.pointerDown(1, 100, 100, 0);
  e.tick(CFG.dragHoldDelay + 20);
  e.reset();

  assert.strictEqual(e.pointers.size, 0);
  assert.strictEqual(e.dragActive, false);
  assert.strictEqual(e.mode, 'idle');
});

test('pointerCancel 会解除拖拽', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.pointerDown(1, 100, 100, 0);
  e.tick(CFG.dragHoldDelay + 20);
  e.pointerCancel(1, CFG.dragHoldDelay + 30);

  const ups = firstOf(ctx.events, 'button').filter(function (b) {
    return b.payload.action === 'u';
  });
  assert.strictEqual(ups.length, 1);
});

test('多指抬起过程中剩余手指不会继续驱动光标', function () {
  const ctx = makeEngine();
  const e = ctx.engine;
  e.pointerDown(1, 100, 300, 0);
  e.pointerDown(2, 200, 300, 2);
  e.pointerMove(1, 100, 250, 16);
  e.pointerMove(2, 200, 250, 18);
  e.tick(20);
  e.pointerUp(1, 100, 250, 30);
  const before = firstOf(ctx.events, 'move').length;
  e.pointerMove(2, 400, 250, 34);
  e.tick(40);
  assert.strictEqual(firstOf(ctx.events, 'move').length, before, '剩余手指不应产生光标移动');
});
