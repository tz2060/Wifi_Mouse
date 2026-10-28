/* 滚动条逻辑单测：node tests/scrollbar.test.js
 *
 * 这套逻辑里最容易出错的三处：
 *   1. 方向 —— 向下拖应当向下滚，而 wheel 约定正数=向上，符号很容易搞反
 *   2. 回弹 —— 不回弹的话拖到顶就卡死，行程只有 ±160px
 *   3. 加速度 —— 倍率应随拖动距离从 1 平滑升到 4，不是跳档
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

/* ---------- 按住不停（巡航） ---------- */

/* 需求：滑到某个速度后手指停住但不松开，就按那个速度一直滚下去。

   这套逻辑最容易错的三处：
     1. 进入时机 —— 手指停太久才动 vs 一动就退出
     2. 速度上限 —— 顺手一甩不能变成 100 行/秒飞到底
     3. 松手即停 —— 松开后必须立刻停，不能继续滚 */

function cruiseEngine(speedPxPerMs) {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0, 0);
  // 两帧建立速度
  ctx.engine.pointerMove(speedPxPerMs * 16, 16);
  ctx.engine.pointerMove(speedPxPerMs * 32, 32);
  return ctx;
}

function runTicks(ctx, fromT, count, step) {
  let t = fromT;
  for (let i = 0; i < count; i += 1) {
    t += step;
    ctx.engine.tick(t);
  }
  return t;
}

test('按住不动会持续滚动', function () {
  const ctx = cruiseEngine(0.6);
  const before = Math.abs(wheelSum(ctx.events));
  runTicks(ctx, 32, 40, 16);            // 约 0.64 秒
  const after = Math.abs(wheelSum(ctx.events));
  assert.ok(after > before + 3,
    `停住后应继续滚，之前 ${before} 之后 ${after}`);
});

test('停住后进入巡航态', function () {
  const ctx = cruiseEngine(0.6);
  runTicks(ctx, 32, 20, 16);
  assert.strictEqual(ctx.engine.cruising, true);
});

test('松手立即停止', function () {
  const ctx = cruiseEngine(0.6);
  runTicks(ctx, 32, 20, 16);
  assert.strictEqual(ctx.engine.cruising, true);

  ctx.engine.pointerUp();
  const afterUp = Math.abs(wheelSum(ctx.events));
  runTicks(ctx, 352, 40, 16);
  assert.strictEqual(Math.abs(wheelSum(ctx.events)), afterUp,
    '松手后不该再滚');
});

test('停住时间不足 cruiseDelay 不巡航', function () {
  const ctx = cruiseEngine(0.6);
  // 只推进一帧（16ms < 80ms），不应进入巡航
  ctx.engine.tick(48);
  assert.strictEqual(ctx.engine.cruising, false);
});

test('重新动起来会退出巡航', function () {
  const ctx = cruiseEngine(0.6);
  runTicks(ctx, 32, 20, 16);
  assert.strictEqual(ctx.engine.cruising, true);

  ctx.engine.pointerMove(120, 400);
  assert.strictEqual(ctx.engine.cruising, false, '再次移动应立即退出巡航');
});

test('巡航速度有上限，甩一下不会飞到底', function () {
  const fast = cruiseEngine(10);      // 极快
  const slow = cruiseEngine(1.2);
  const fastLines = (function () {
    const b = Math.abs(wheelSum(fast.events));
    runTicks(fast, 32, 63, 16);
    return Math.abs(wheelSum(fast.events)) - b;
  })();
  const slowLines = (function () {
    const b = Math.abs(wheelSum(slow.events));
    runTicks(slow, 32, 63, 16);
    return Math.abs(wheelSum(slow.events)) - b;
  })();
  const cap = CFG.maxCruiseLinesPerSec;
  assert.ok(fastLines <= cap + 2,
    `1 秒最多约 ${cap} 行，实际 ${fastLines}`);
  assert.ok(fastLines >= slowLines - 1,
    '更快的手速不该滚得更少');
});

test('慢速巡航也能滚动，不会因阈值太小而卡住', function () {
  const ctx = cruiseEngine(0.15);
  const before = Math.abs(wheelSum(ctx.events));
  runTicks(ctx, 32, 63, 16);
  const after = Math.abs(wheelSum(ctx.events));
  assert.ok(after > before, `慢速也应持续滚，之前 ${before} 之后 ${after}`);
});

test('巡航方向与手指最后移动方向一致', function () {
  // 向上滑 -> 向上滚
  const ctx = makeEngine();
  ctx.engine.pointerDown(0, 0);
  ctx.engine.pointerMove(-10, 16);
  ctx.engine.pointerMove(-20, 32);
  const before = wheelSum(ctx.events);
  runTicks(ctx, 32, 40, 16);
  const delta = wheelSum(ctx.events) - before;
  assert.ok(delta > 0, '向上滑后巡航应继续向上滚，实际增量 ' + delta);
});

test('巡航与帧率无关：30fps 和 120fps 结果接近', function () {
  function oneSec(fps) {
    const step = 1000 / fps;
    const ctx = makeEngine();
    ctx.engine.pointerDown(0, 0);
    ctx.engine.pointerMove(0.6 * step, step);
    ctx.engine.pointerMove(0.6 * step * 2, step * 2);
    const before = Math.abs(wheelSum(ctx.events));
    let t = step * 2;
    for (let i = 0; i < fps; i += 1) {
      t += step;
      ctx.engine.tick(t);
    }
    return Math.abs(wheelSum(ctx.events)) - before;
  }
  const a = oneSec(30);
  const b = oneSec(120);
  const diff = Math.abs(a - b);
  assert.ok(diff <= Math.max(4, Math.max(a, b) * 0.35),
    `不同帧率结果应接近，30fps=${a} 120fps=${b}`);
});

test('巡航速度存在 velocity 里，供 UI 参考', function () {
  const ctx = cruiseEngine(0.6);
  runTicks(ctx, 32, 20, 16);
  assert.ok(Math.abs(ctx.engine.velocity) > 0.1);
});

/* 需求：滑得越快滚得越多，最快可到 80 行/秒。

   注意要测「稳态」而不是「1 秒窗口」：
   从手指停住到达到目标速度有一个爬升过程，
   如果把起步阶段也算进 1 秒，测出来会偏低（约 74）。
   所以先跑够爬升帧数，再单独量一段稳定区间。 */
test('稳态巡航能达到 80 行/秒上限', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0, 0);
  let t = 0;
  let y = 0;
  // 快速滑出高速度
  for (let i = 0; i < 5; i += 1) {
    t += 16;
    y += 30;
    ctx.engine.pointerMove(y, t);
  }
  // 爬升期：让速度估计和倍率到位
  for (let i = 0; i < 30; i += 1) {
    t += 16;
    y += (i % 2 ? 0.4 : -0.4);
    ctx.engine.pointerMove(y, t);
    ctx.engine.tick(t);
  }

  const base = Math.abs(wheelSum(ctx.events));
  const t0 = t;
  // 稳定区间：2 秒
  for (let i = 0; i < 125; i += 1) {
    t += 16;
    y += (i % 2 ? 0.4 : -0.4);
    ctx.engine.pointerMove(y, t);
    ctx.engine.tick(t);
  }
  const lines = Math.abs(wheelSum(ctx.events)) - base;
  const secs = (t - t0) / 1000;
  const rate = lines / secs;

  const cap = CFG.maxCruiseLinesPerSec;
  assert.ok(rate <= cap + 2,
    `不该超过上限 ${cap} 行/秒，实际 ${rate.toFixed(1)}`);
  assert.ok(rate >= cap * 0.9,
    `快速滑动应接近上限 ${cap}，实际只有 ${rate.toFixed(1)} 行/秒`);
});

/* 默认值必须真的是 80。
   上面那条测试读的是 CFG，所以不管上限设成多少都会通过——
   它验证的是"实际速率符合配置"，不是"配置就是 80"。
   这里单独钉住默认值，防止有人调小后测试仍全绿。 */
test('默认巡航上限为 80 行/秒', function () {
  assert.strictEqual(SB.DEFAULTS.maxCruiseLinesPerSec, 80);
});

test('默认单帧截断不阻碍 80 行/秒', function () {
  // 60fps 下 80 行/秒 = 每帧 1.33 行；120fps 更低。
  // 若 maxLinesPerTick 小于这个值，上限就成了摆设。
  const perFrameAt60 = SB.DEFAULTS.maxCruiseLinesPerSec / 60;
  assert.ok(SB.DEFAULTS.maxLinesPerTick > perFrameAt60,
    `单帧上限 ${SB.DEFAULTS.maxLinesPerTick} 必须大于 ${perFrameAt60.toFixed(2)}`);
});

test('滑得越快滚得越多（单调）', function () {
  function rateFor(pxPerFrame) {
    const ctx = makeEngine();
    ctx.engine.pointerDown(0, 0);
    let t = 0;
    let y = 0;
    for (let i = 0; i < 6; i += 1) {
      t += 16;
      y += pxPerFrame;
      ctx.engine.pointerMove(y, t);
    }
    const before = Math.abs(wheelSum(ctx.events));
    for (let i = 0; i < 63; i += 1) {
      t += 16;
      y += (i % 2 ? 0.4 : -0.4);
      ctx.engine.pointerMove(y, t);
      ctx.engine.tick(t);
    }
    return Math.abs(wheelSum(ctx.events)) - before;
  }

  const slow = rateFor(3);
  const mid = rateFor(12);
  const fast = rateFor(40);

  assert.ok(mid > slow, `中速应快于慢速：${mid} vs ${slow}`);
  assert.ok(fast >= mid, `快速不应慢于中速：${fast} vs ${mid}`);
});

test('没有先移动就停住不会巡航（速度为 0）', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0, 0);
  const before = Math.abs(wheelSum(ctx.events));
  runTicks(ctx, 0, 60, 16);
  assert.strictEqual(Math.abs(wheelSum(ctx.events)), before);
  assert.strictEqual(ctx.engine.cruising, false);
});

/* ---------- 触摸抖动（真机才会暴露的坑） ---------- */

/* 这是"按住不放但就是不滚"的真正原因。

   触摸屏按住不动时，触摸层会持续上报 ±0.4px 的亚像素抖动，
   每一帧都会触发 pointerMove。
   如果按"收到 move 事件就退出巡航"来判定，巡航永远启动不了。
   外加这些抖动还会正负交替地把速度估计磨成 0。

   桌面上用鼠标测不出来，因为鼠标静止时真的不产生事件。 */

/* 从引擎当前所在位置开始抖动。
   如果从 y=0 起算，第一帧会产生 -18.8px 的跳变，
   被断言为"真实滑动"，测不出抖动问题。 */
function jitterLoop(ctx, fromT, frames, amp) {
  let t = fromT;
  let y = ctx.engine._lastY;
  for (let i = 0; i < frames; i += 1) {
    t += 16;
    y += (i % 2 === 0 ? amp : -amp);
    ctx.engine.pointerMove(y, t);
    ctx.engine.tick(t);
  }
  return t;
}

test('触摸抖动不会打断巡航', function () {
  const ctx = cruiseEngine(0.6);
  runTicks(ctx, 32, 10, 16);            // 先进入巡航
  assert.strictEqual(ctx.engine.cruising, true);

  const before = Math.abs(wheelSum(ctx.events));
  jitterLoop(ctx, 192, 60, 0.4);        // 手指按住，触摸层抖动
  const after = Math.abs(wheelSum(ctx.events));

  assert.ok(after > before + 5,
    `抖动期间应持续滚，之前 ${before} 之后 ${after}`);
});

test('触摸抖动不会把速度磨成 0', function () {
  const ctx = cruiseEngine(0.6);
  runTicks(ctx, 32, 10, 16);
  const v0 = Math.abs(ctx.engine.velocity);
  assert.ok(v0 > 0.2, '巡航前速度应大于抖动阈值');

  jitterLoop(ctx, 192, 60, 0.4);

  const v1 = Math.abs(ctx.engine.velocity);
  assert.ok(v1 > v0 * 0.5,
    `速度不该被抖动磨掉，之前 ${v0.toFixed(3)} 之后 ${v1.toFixed(3)}`);
});

test('抖动幅度小于阈值时完全忽略', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0, 0);
  // 只抖动，不做真实滑动
  jitterLoop(ctx, 0, 60, 0.4);
  assert.strictEqual(ctx.events.length, 0, '纯抖动不该产生滚动');
  assert.strictEqual(ctx.engine.cruising, false, '没有速度不该巡航');
});

test('真实滑动仍然能打断巡航', function () {
  const ctx = cruiseEngine(0.6);
  runTicks(ctx, 32, 10, 16);
  assert.strictEqual(ctx.engine.cruising, true);

  // 明确移出阈值之外
  ctx.engine.pointerMove(ctx.engine._lastY + 20, 400);
  assert.strictEqual(ctx.engine.cruising, false, '真实滑动应退出巡航');
});

test('阈值可配置', function () {
  const ctx = makeEngine({ jitterPx: 10 });
  ctx.engine.pointerDown(0, 0);

  // 8px < 阈值 10，应被当作抖动：既不滚，也不更新速度
  ctx.engine.pointerMove(8, 16);
  assert.strictEqual(ctx.events.length, 0);
  assert.strictEqual(ctx.engine._pendingPx, 0, '抖动不应累积像素');
  assert.strictEqual(ctx.engine.velocity, 0, '抖动不应产生速度');

  // 19.2px 超过阈值 10 => 真实移动，应累积像素
  ctx.engine.pointerMove(27.2, 32);
  assert.ok(Math.abs(ctx.engine._pendingPx) > 0, '超过阈值应累积滚动量');
  assert.ok(Math.abs(ctx.engine.velocity) > 0, '超过阈值应产生速度');
});

/* ---------- 慢速拖动（阈值不能吃掉真实输入） ---------- */

/* 这是加抖动阈值后必然要防的副作用。

   如果按"单帧位移 < 阈值就丢弃"来过滤抖动，
   那么手指慢慢移动（每帧 2~3px）会被整段丢弃，一行都不滚。
   慢挪是很常见的操作，绝不能失效。

   解法是累积判定：把位移攒起来，够了才算真的动。
   原地抖动正负抵消攒不起来，慢速拖动则能在几帧内达标。 */

function slowDrag(pxPerFrame, frames) {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0, 0);
  let t = 0;
  let y = 0;
  for (let i = 0; i < frames; i += 1) {
    t += 16;
    y += pxPerFrame;
    ctx.engine.pointerMove(y, t);
  }
  return Math.abs(wheelSum(ctx.events));
}

test('每帧 2px 的慢速拖动仍然能滚', function () {
  const lines = slowDrag(2, 60);
  assert.ok(lines > 0, '慢速拖动必须有效，实际 ' + lines + ' 行');
});

test('每帧 1px 的极慢拖动也能滚', function () {
  const lines = slowDrag(1, 120);
  assert.ok(lines > 0, '极慢拖动也必须有效，实际 ' + lines + ' 行');
});

test('慢速拖动越慢滚得越少，但不为 0', function () {
  const slow = slowDrag(1, 60);
  const fast = slowDrag(8, 60);
  assert.ok(slow > 0, '慢速不该为 0');
  assert.ok(fast >= slow, `快速不该少于慢速，慢 ${slow} 快 ${fast}`);
});

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
  // 加速生效后 linePx 是"1 倍速下的一行"。
  // 拖 23px 时倍率已升到约 1.29，等效 29.6px，够一行了。
  // 所以这里用更小的位移来验证"不足一行"。
  ctx.engine.pointerMove(8);
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

/* ---------- 加速度 ---------- */

/* 需求：拖动幅度从 1 倍平滑增大到 4 倍。

   这里刻意用"分多小步"的方式测总行数，
   因为单帧大步长会被 maxLinesPerTick 截断，
   那样测出来的是截断上限而不是加速度曲线。 */

function totalLines(steps, targetPx) {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  let y = 0;
  for (let i = 0; i < steps; i += 1) {
    y += targetPx / steps;
    ctx.engine.pointerMove(y);
  }
  return Math.abs(wheelSum(ctx.events));
}

test('居中时倍率为 1', function () {
  const ctx = makeEngine();
  assert.strictEqual(ctx.engine.factor, 1);
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(0.0001);
  assert.ok(ctx.engine.factor < 1.05, '刚开始拖应该接近 1 倍，实际 ' + ctx.engine.factor);
});

test('拖到最远处倍率为 3', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(CFG.maxOffset);
  assert.ok(Math.abs(ctx.engine.factor - CFG.maxFactor) < 0.01,
    '满行程应为 ' + CFG.maxFactor + ' 倍，实际 ' + ctx.engine.factor);
});

test('倍率随距离单调递增', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  let prev = 0;
  for (let y = 0; y <= CFG.maxOffset; y += 10) {
    ctx.engine.pointerMove(y);
    assert.ok(ctx.engine.factor >= prev - 1e-9,
      `倍率不该回落: ${prev} -> ${ctx.engine.factor}`);
    prev = ctx.engine.factor;
  }
});

test('倍率不超过上限', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(CFG.maxOffset * 5);   // 远超行程
  assert.ok(ctx.engine.factor <= CFG.maxFactor + 0.01,
    '不该超过 ' + CFG.maxFactor + ' 倍，实际 ' + ctx.engine.factor);
});

test('同样拖 24px，在更远处滚得更多', function () {
  function stepFrom(from) {
    const ctx = makeEngine();
    ctx.engine.pointerDown(0);
    ctx.engine.pointerMove(from);
    const base = Math.abs(wheelSum(ctx.events));
    ctx.engine.pointerMove(from + 24);
    return Math.abs(wheelSum(ctx.events)) - base;
  }

  const near = stepFrom(0);
  const far = stepFrom(120);
  assert.ok(far > near,
    `远端同样距离应滚得更多，近 ${near} 远 ${far}`);
});

test('满行程总行数明显多于单倍速', function () {
  const slow = totalLines(20, 24);      // 只拖一点点
  const full = totalLines(20, CFG.maxOffset);
  assert.ok(full > slow * 3,
    `满行程应远超近处，近 ${slow} 满 ${full}`);
});

test('松手后倍率复位为 1', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(CFG.maxOffset);
  assert.ok(ctx.engine.factor > 2.5, '拖动中应处于高档');
  ctx.engine.pointerUp();
  assert.strictEqual(ctx.engine.factor, 1);
});

test('wheel 事件带倍率，供 UI 显示', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(CFG.linePx * 3);
  const wheels = ctx.events.filter(function (x) { return x.type === 'wheel'; });
  assert.ok(wheels.length > 0);
  assert.strictEqual(typeof wheels[0].payload.factor, 'number');
  assert.ok(wheels[0].payload.factor >= 1);
});

test('倍率可配置', function () {
  const ctx = makeEngine({ minFactor: 2, maxFactor: 8 });
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(CFG.maxOffset);
  assert.ok(Math.abs(ctx.engine.factor - 8) < 0.01, '实际 ' + ctx.engine.factor);
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
  const first = Math.abs(wheelSum(ctx.events));

  // 再微动 1px，不应突然冒出一大截积压
  ctx.engine.pointerMove(10001);
  const total = Math.abs(wheelSum(ctx.events));
  assert.strictEqual(total, first,
    '触顶后被截掉的量必须丢弃，否则微动一下会涌出积压');
});

/* 这一条是上面那个 bug 的回归测试。
   加速度会放大大拖积累的像素量，如果触顶后把余额留着，
   手指之后只需微动 1px 就会连续吐出十几行，
   表现为"轻轻一碰，页面又跳了一大截"。 */
test('触顶后连续微动不会持续输出', function () {
  const ctx = makeEngine();
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(10000);
  const afterBig = Math.abs(wheelSum(ctx.events));
  assert.ok(afterBig > 0, '大拖本身应该产生滚动');

  for (let i = 1; i <= 5; i += 1) {
    ctx.engine.pointerMove(10000 + i);
  }
  const afterNudges = Math.abs(wheelSum(ctx.events));
  assert.ok(afterNudges - afterBig <= 1,
    `微动 5px 最多再多 1 行，实际多出 ${afterNudges - afterBig} 行`);
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
  // 加速下要真正不足一行必须拖得很小（8px 时等效约 8.8px）
  ctx.engine.pointerMove(8);
  assert.strictEqual(ctx.events.length, 0);
  ctx.engine.pointerUp();
  // 再次按下时不应继承这不到一行的零头
  ctx.engine.pointerDown(0);
  ctx.engine.pointerMove(8);
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
