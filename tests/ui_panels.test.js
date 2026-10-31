/* 打字面板与折叠分组的契约测试。
 *
 * 这两块都是纯前端交互，跑不了 DOM，所以测的是"源码里必须存在的性质"。
 * 这类静态断言价值有限但能防住真出现过的回归：
 *   - 输入法组合期间按回车会误发半截内容
 *   - 面板切换退化成 toggle，手机上点一次开、点第二次关
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
const read = function (f) { return fs.readFileSync(path.join(WEB, f), 'utf8'); };

const appJs = read('app.js');
const indexHtml = read('index.html');
const styleCss = read('style.css');

/* ---------- 打字面板 ---------- */

test('打字面板存在且默认隐藏', function () {
  assert.ok(indexHtml.includes('id="panel-type"'));
  const m = /<section class="panel" id="panel-type"[^>]*hidden/.exec(indexHtml);
  assert.ok(m, '打字面板默认必须隐藏');
});

test('输入框足够高，能打长文本', function () {
  const m = /id="type-input"[^>]*rows="(\d+)"/.exec(indexHtml);
  assert.ok(m, '找不到 type-input 的 rows');
  assert.ok(Number(m[1]) >= 4, `rows 至少 4，实际 ${m[1]}`);
});

test('输入框禁用了自动纠错与大写', function () {
  // 手机上这些属性不加，打字会被系统自作主张改写
  assert.ok(/autocorrect="off"/.test(indexHtml));
  assert.ok(/autocapitalize="off"/.test(indexHtml));
  assert.ok(/spellcheck="false"/.test(indexHtml));
});

test('设置 enterkeyhint，手机回车键显示"发送"', function () {
  assert.ok(indexHtml.includes('enterkeyhint="send"'));
});

test('回车发送前检查输入法组合状态', function () {
  // 中文输入法选词时按回车是"确认候选"，不是"提交"。
  // 不判断 isComposing 会把半截内容发出去。
  assert.ok(appJs.includes('isComposing'), '必须检查 e.isComposing');
  assert.ok(appJs.includes('229'), '必须兼容 keyCode 229（部分安卓输入法）');
});

test('回车触发发送，Shift+Enter 不发送', function () {
  assert.ok(/e\.key === 'Enter' && !e\.shiftKey/.test(appJs),
    '回车发送应排除 Shift+Enter');
});

test('有换行按钮，能插入多行', function () {
  assert.ok(indexHtml.includes('id="type-newline"'), '缺少换行按钮');
  assert.ok(appJs.includes('type-newline'), '换行按钮未绑定');
  // 插入 \n 而不是 <br>
  assert.ok(appJs.includes("'\\n'"), '换行应插入 \\n');
});

test('发送成功后清空输入框', function () {
  const idx = appJs.indexOf('function typeSubmit');
  assert.ok(idx > 0);
  const body = appJs.slice(idx, idx + 700);
  assert.ok(body.includes("input.value = ''"), '发送后应清空');
});

test('空白内容不发送', function () {
  // 空内容判定在 checkText 里，typeSubmit 调用它做前置校验
  assert.ok(appJs.includes('function checkText'), '应有 checkText 前置校验');
  const idx = appJs.indexOf('function checkText');
  const body = appJs.slice(idx, idx + 600);
  assert.ok(body.includes('text.trim()') || body.includes('s.trim()'),
    '应检查 trim，避免只发空格');
});

test('超限时保留输入内容，不清空', function () {
  // 用户辛苦打的一段话，不能因为超限就丢掉
  const idx = appJs.indexOf('function typeSubmit');
  assert.ok(idx > 0);
  const body = appJs.slice(idx, idx + 700);
  assert.ok(body.includes('return'), '超限应提前返回');
  // 清空只能发生在发送成功分支
  const clearIdx = body.indexOf("input.value = ''");
  const problemIdx = body.indexOf('if (problem)');
  assert.ok(problemIdx >= 0 && problemIdx < clearIdx,
    '必须先判超限，再走清空逻辑');
});

test('前端文本上限与服务端一致', function () {
  const py = fs.readFileSync(
    path.join(__dirname, '..', 'remouse', 'protocol.py'), 'utf8');
  const chars = /MAX_TEXT_CHARS = (\d+)/.exec(py);
  const units = /MAX_TEXT_UNITS = (\d+)/.exec(py);
  assert.ok(chars && units, '服务端应定义两个上限');

  const jsChars = /MAX_TEXT_CHARS = (\d+)/.exec(appJs);
  const jsUnits = /MAX_TEXT_UNITS = (\d+)/.exec(appJs);
  assert.ok(jsChars, '前端应定义 MAX_TEXT_CHARS');
  assert.ok(jsUnits, '前端应定义 MAX_TEXT_UNITS');

  assert.strictEqual(jsChars[1], chars[1], 'MAX_TEXT_CHARS 必须与服务端一致');
  assert.strictEqual(jsUnits[1], units[1], 'MAX_TEXT_UNITS 必须与服务端一致');
});

test('服务端错误会显示给用户', function () {
  // 之前 'er' 分支直接 return，超限消息被静默丢弃，
  // 用户看到"已发送"但电脑上什么都没有。
  const idx = appJs.indexOf("msg.t === 'er'");
  assert.ok(idx > 0);
  const body = appJs.slice(idx, idx + 500);
  assert.ok(body.includes('showTypeHint'), '错误应显示到打字面板');
});

/* ---------- 折叠分组 ---------- */

test('快捷键面板按类型分成多个折叠组', function () {
  const folds = indexHtml.match(/class="fold"/g) || [];
  assert.ok(folds.length >= 3, `至少 3 个分组，实际 ${folds.length}`);
});

test('用原生 details 实现折叠', function () {
  assert.ok(indexHtml.includes('<details class="fold"'), '应用 details');
  assert.ok(indexHtml.includes('<summary>'), '应用 summary');
});

test('字母组默认展开，其余默认收起', function () {
  // 第一个 details 带 open，其余不带
  const all = indexHtml.match(/<details class="fold"[^>]*>/g) || [];
  assert.ok(all.length >= 3);
  assert.ok(all[0].includes('open'), '字母组应默认展开');
  all.slice(1).forEach(function (tag, i) {
    assert.ok(!tag.includes('open'), `第 ${i + 2} 个分组不该默认展开`);
  });
});

test('折叠组显示按键数量', function () {
  const notes = indexHtml.match(/class="fold-note"/g) || [];
  assert.ok(notes.length >= 3, '每组应显示键数');
});

test('折叠三角靠 CSS 绘制，去掉系统默认箭头', function () {
  assert.ok(styleCss.includes('-webkit-details-marker'), '应隐藏 safari 默认箭头');
  assert.ok(styleCss.includes('.fold > summary::after'), '应自绘三角');
});

/* ---------- 面板切换 ---------- */

test('面板切换是幂等的，不是 toggle', function () {
  // 手机上点按可能触发两次事件，toggle 语义会让面板开了立刻关
  const idx = appJs.indexOf('function togglePanel');
  assert.ok(idx > 0);
  const body = appJs.slice(idx, idx + 900);
  assert.ok(!body.includes('openPanel === name'),
    '不该再用 toggle 判断');
  assert.ok(body.includes('openPanel = name'), '应直接赋值为当前面板');
});

test('打字面板打开后自动聚焦输入框', function () {
  const idx = appJs.indexOf('function togglePanel');
  const body = appJs.slice(idx, idx + 1200);
  assert.ok(body.includes('type-input'), '应聚焦到 type-input');
  assert.ok(body.includes('focus()'), '应调用 focus');
});

/* ---------- 面板与工具条一致性 ---------- */

test('工具条上的每个 tab 都有对应面板', function () {
  const tabs = [...indexHtml.matchAll(/data-panel="([a-z]+)"/g)].map(function (m) {
    return m[1];
  });
  assert.ok(tabs.length >= 5, '至少有 5 个 tab');
  tabs.forEach(function (name) {
    assert.ok(indexHtml.includes(`id="panel-${name}"`),
      `tab ${name} 找不到对应面板`);
  });
});

test('键盘输入面板已恢复（与文件面板并存）', function () {
  assert.ok(indexHtml.includes('data-panel="type"'), '缺少打字 tab');
  assert.ok(indexHtml.includes('data-panel="files"'), '缺少传文件 tab');
});
