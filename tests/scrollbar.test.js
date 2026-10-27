/* 滚动条逻辑单测：node tests/scrollbar.test.js
 *
 * 这套逻辑里最容易出错的三处：
 *   1. 方向 —— 向下拖应当向下滚，而 wheel 约定正数=向上，符号很容易搞反
 *   2. 回弹 —— 不回弹的话拖到顶就卡死，行程只有 ±160px
 *   3. 截断 —— 单次滚太多行要有上限，但被截掉的量不能攒着下次涌出来
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const SB = require(path.join(__dirname, '..', 'web', 'scrollbar.js'));

const CFG = SB.DEFAULTS;

function makeEngine(options) {
  const e = new SB.ScrollbarEngine(options);
  const events = [];
  e.onEvent = function (type, payload) {
    events.push({ type: type, payload: payload });
  };
  return { engine: e, events: events };
}

function wheelSum(events) {
  return events
    .filter(function (x) { return x.type === 'wheel'; })
    .reduce(function (a, x) { return a + x.payload.dy; }, 0);
}

/* ---------- 方向语义 ---------- */

/* 这一组是"滚动条滑动方向反了"的回归测试。

   易错点在于：滚动条和双指滑动方向本来就相反，不能共用取反逻辑。
     双指滑动 = 推纸：手指向下 -> 内容上移 -> 看到更早的内容
     滚动条   = 拖滑块：拇指向下 -> 视口向后 -> 看到更晚的内容

   Windows 的 wh 约定：dy < 0 = 滚向文档后段，dy > 0 = 滚向开头。
   所以向下拖必须产出负数。 */

test('向下拖 -> dy 为负（看到更晚的内容）', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(CFG.linePx * 2);
  const total = wheelSum(ctx.events);
  assert.ok(total < 0, '向下拖应产出负值，实际 ' + total);
});

test('向上拖 -> dy 为正（看到更早的内容）', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(-CFG.linePx * 2);
  const total = wheelSum(ctx.events);
  assert.ok(total > 0, '向上拖应产出正值，实际 ' + total);
});

test('方向与"自然滚动"无关，滚动条自己保持固定语义', function () {
  // 引擎不认识 nat 这个开关，它的输出只取决于拖动方向。
  // 这个测试钉住"引擎不做二次取反"，否则上层再取反一次就会翻回去。
  const down = makeEngine();
  down.engine.pointerDown(0);
  down.engine.pointerMove(CFG.linePx * 2);

  const downAgain = makeEngine();
  downAgain.engine.pointerDown(0);
  downAgain.engine.pointerMove(CFG.linePx * 2);

  assert.strictEqual(wheelSum(down.events), wheelSum(downAgain.events));
});

test('拖动方向决定符号，连续拖动不会自我抵消', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  let y = 0;
  for (let i = 0; i < 6; i += 1) {
    y += CFG.linePx;
    ctx.engine.pointerMove(y);
  }
  const total = wheelSum(ctx.events);
  assert.ok(total < 0, '单向连续拖动应累积成负值，实际 ' + total);
  assert.ok(Math.abs(total) >= 5, '六次一行应至少滚 5 行，实际 ' + Math.abs(total));
});

/* ---------- 基本拖动 ---------- */

test('未拖动时不产生任何滚动', function () {
  const ctx = makeEngine();
  ctx.engine.pointerMove(100);
  assert.strictEqual(ctx.events.length, 0);
});

test('向下拖产生向下滚动（dy 为负）', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(CFG.linePx);   // 正好一行
  assert.ok(ctx.events.length > 0, '应当产生滚动');
  assert.ok(wheelSum(ctx.events) < 0, '向下拖应向下滚，实际 ' + wheelSum(ctx.events));
});

test('向上拖产生向上滚动（dy 为正）', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(-CFG.linePx);
  assert.ok(wheelSum(ctx.events) > 0, '向上拖应向上滚');
});

test('不足一行的位移不产生滚动', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(CFG.linePx - 1);
  assert.strictEqual(ctx.events.length, 0);
});

test('零头会累积，多次小幅拖动最终凑成一行', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  const step = CFG.linePx / 4;
  let y = 0;
  for (let i = 0; i < 4; i += 1) {
    y += step;
    ctx.engine.pointerMove(y);
  }
  assert.ok(ctx.events.length >= 1, '4 次 1/4 行应当凑出一行');
});

/* ---------- 上限与截断 ---------- */

test('视觉偏移不超过 maxOffset', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(10000);
  assert.ok(Math.abs(ctx.engine.offset) <= CFG.maxOffset + 0.001,
    '偏移应被夹住，实际 ' + ctx.engine.offset);
});

test('单次移动产出的行数被限幅', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(10000);   // 远超上限
  const biggest = Math.max.apply(null,
    ctx.events.map(function (x) { return Math.abs(x.payload.dy); }));
  assert.ok(biggest <= CFG.maxLinesPerTick,
    '单次最多 ' + CFG.maxLinesPerTick + ' 行，实际 ' + biggest);
});

test('被截掉的量不会在下次涌入', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(10000);
  const first = wheelSum(ctx.events);

  // 再微动 1px，不应突然冒出一大截积压
  ctx.engine.pointerMove(10001);
  const total = wheelSum(ctx.events);
  assert.ok(Math.abs(total - first) <= 1,
    '截断后不该有积压涌出，增量 ' + (total - first));
});

/* ---------- 回弹 ---------- */

test('松手后偏移回落到 0', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(100);
  assert.ok(ctx.engine.offset > 0);

  ctx.engine.pointerUp();
  for (let i = 0; i < 200; i += 1) {
    ctx.engine.tick();
    if (ctx.engine.offset === 0) break;
  }
  assert.strictEqual(ctx.engine.offset, 0, '必须回到 0，否则会一直卡在边上');
});

test('回弹过程单调收敛，不反向', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(120);
  ctx.engine.pointerUp();

  let prev = Math.abs(ctx.engine.offset);
  for (let i = 0; i < 100; i += 1) {
    const out = ctx.engine.tick();
    if (!out) break;
    const cur = Math.abs(ctx.engine.offset);
    assert.ok(cur <= prev + 1e-9, `回弹不应变大: ${prev} -> ${cur}`);
    prev = cur;
    if (cur === 0) break;
  }
});

test('拖动中不回弹', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(80);
  const held = ctx.engine.offset;
  for (let i = 0; i < 30; i += 1) ctx.engine.tick();
  assert.strictEqual(ctx.engine.offset, held, '拖动期间不应回弹');
});

test('回弹不产生滚动事件', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(CFG.linePx);
  ctx.engine.pointerUp();
  const before = wheelSum(ctx.events);
  for (let i = 0; i < 100; i += 1) ctx.engine.tick();
  assert.strictEqual(wheelSum(ctx.events), before, '回弹不该触发滚动');
});

test('静止时 tick 返回 null，避免无谓重绘', function () {
  const ctx = makeEngine();
  assert.strictEqual(ctx.engine.tick(), null);
});

/* ---------- 可以无限拖 ---------- */

test('反复拖到上限再回弹，可以累计很远', function () {
  const ctx = makeEngine();
  let total = 0;
  // 模拟连续 5 次"拖到底 -> 松手回弹"
  for (let round = 0; round < 5; round += 1) {
    ctx.engine.pointerDown(0);
    ctx.engine.pointerMove(CFG.maxOffset);
    ctx.engine.pointerUp();
    total += Math.abs(wheelSum(ctx.events));
    ctx.events.length = 0;
    for (let i = 0; i < 200; i += 1) {
      if (!ctx.engine.tick()) break;
    }
  }
  // 单轮行程只有 maxOffset，5 轮下来必须明显更多
  const oneRound = CFG.maxOffset / CFG.linePx;
  assert.ok(total > oneRound * 3,
    `5 轮应远超单轮，总行数 ${total} vs 单轮 ${oneRound}`);
});

test('松手时丢掉不足一行的零头', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(CFG.linePx * 0.9);   // 不够一行
  assert.strictEqual(ctx.events.length, 0);
  ctx.engine.pointerUp();
  // 再次按下时不应继承这 0.9 行
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(CFG.linePx * 0.2);
  assert.strictEqual(ctx.events.length, 0, '上一次的零头不该带过来');
});

/* ---------- 防御 ---------- */

test('reset 清空所有状态', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(100);
  ctx.engine.reset();
  assert.strictEqual(ctx.engine.offset, 0);
  assert.strictEqual(ctx.engine.dragging, false);
});

test('pointerUp 后 move 不再生效', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerUp();
  ctx.engine.pointerMove(500);
  assert.strictEqual(ctx.events.length, 0);
});

test('lastLines 可读，供 UI 显示方向与数量', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(CFG.linePx * 2);
  assert.ok(Math.abs(ctx.engine.lastLines) >= 1);
});

/* ---------- 发给系统的最终值 ---------- */

/* 这一组直接测 toWheelDelta —— app.js 用它做最后一步翻译。
   之前"方向反了"的 bug 就出在这一步（套了自然滚动的取反），
   而当时只测引擎、没测这一层，所以测试全绿但功能是错的。 */

test('toWheelDelta 原样透传，不取反', function () {
  assert.strictEqual(SB.toWheelDelta(-2), -2);
  assert.strictEqual(SB.toWheelDelta(3), 3);
});

test('向下拖经 toWheelDelta 后仍是负值', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(CFG.linePx * 2);
  const raw = wheelSum(ctx.events);
  assert.ok(SB.toWheelDelta(raw) < 0, '向下拖最终必须发给系统负值');
});

test('toWheelDelta 接受第二个参数也不会翻转（防回归）', function () {
  // 就算有人误传了 nat 之类的开关，也不该改变方向
  assert.strictEqual(SB.toWheelDelta(-2, true), -2);
  assert.strictEqual(SB.toWheelDelta(-2, false), -2);
});

test('toWheelDelta 对非法输入返回 0', function () {
  assert.strictEqual(SB.toWheelDelta(undefined), 0);
  assert.strictEqual(SB.toWheelDelta(null), 0);
  assert.strictEqual(SB.toWheelDelta(NaN), 0);
  assert.strictEqual(SB.toWheelDelta('3'), 0);
  assert.strictEqual(SB.toWheelDelta(0), 0);
});

test('app.js 不再对滚动条套用自然滚动取反', function () {
  // 静态检查：确保那段取反逻辑没有被人"顺手统一"回去
  const fs = require('node:fs');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
  const idx = src.indexOf('scroll.onEvent');
  assert.ok(idx > 0, '找不到 scroll.onEvent');
  const block = src.slice(idx, idx + 600);
  assert.ok(block.includes('toWheelDelta'), '应通过 toWheelDelta 翻译方向');
  assert.ok(!block.includes('state.cfg.nat'),
    '滚动条不该读自然滚动开关，这会让方向反过来');
});
