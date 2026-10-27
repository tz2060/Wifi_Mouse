/* 提示文案单测：node tests/hint.test.js
 *
 * 这些字符串会直接塞进 innerHTML，所以除了内容对不对，
 * 还要验两件事：
 *   1. 转义有没有漏（origin 里含 & 或引号会不会破坏属性）
 *   2. 标签有没有配对（少个闭合会把后面的按钮吞掉）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Hint = require(path.join(__dirname, '..', 'web', 'hint.js'));

/* ---------- 转义 ---------- */

test('escapeHtml 转义四个危险字符', function () {
  assert.strictEqual(
    Hint.escapeHtml('<a href="x">&</a>'),
    '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;'
  );
});

test('escapeHtml 处理非字符串输入', function () {
  assert.strictEqual(Hint.escapeHtml(null), 'null');
  assert.strictEqual(Hint.escapeHtml(8765), '8765');
  assert.strictEqual(Hint.escapeHtml(undefined), 'undefined');
});

test('escapeHtml 不重复转义已有的实体', function () {
  // 已经是 &amp; 的不会再变成 &amp;amp;
  assert.strictEqual(Hint.escapeHtml('&amp;'), '&amp;amp;');
});

/* ---------- 不支持传感器的提示 ---------- */

test('不支持时点名 Chrome 和 DeviceMotionEvent', function () {
  const html = Hint.buildUnsupportedHint();
  assert.ok(html.includes('DeviceMotionEvent'));
  assert.ok(html.includes('Chrome'));
  // 不能只笼统地说"版本太旧"，那会把人引向错误方向
  assert.ok(!html.includes('版本太旧'));
});

test('不支持时提到内置浏览器', function () {
  const html = Hint.buildUnsupportedHint();
  assert.ok(html.includes('内置浏览器'));
});

/* ---------- HTTP 提示 ---------- */

test('HTTP 提示包含可复制的 origin', function () {
  const html = Hint.buildInsecureHint('http://10.166.157.159:8765');
  assert.ok(html.includes('http://10.166.157.159:8765'));
  assert.ok(html.includes('data-copy="http://10.166.157.159:8765"'));
});

test('HTTP 提示给出 chrome://flags 路径', function () {
  const html = Hint.buildInsecureHint('http://x:1');
  assert.ok(html.includes('chrome://flags'));
  assert.ok(html.includes('Insecure origins treated as secure'));
  assert.ok(html.includes('Enabled'));
  assert.ok(html.includes('Relaunch'));
});

test('HTTP 提示同时给出 HTTPS 方案', function () {
  const html = Hint.buildInsecureHint('http://x:1');
  assert.ok(html.includes('--https'));
});

test('HTTP 提示里 origin 被正确转义', function () {
  const html = Hint.buildInsecureHint('http://a&b"c:1');
  assert.ok(!html.includes('data-copy="http://a&b"c:1"'), '未转义会破坏属性');
  assert.ok(html.includes('&amp;'));
  assert.ok(html.includes('&quot;'));
});

test('origin 为空时不崩', function () {
  const html = Hint.buildInsecureHint();
  assert.ok(typeof html === 'string' && html.length > 0);
  assert.ok(html.includes('data-copy=""'));
});

/* ---------- 权限相关 ---------- */

test('拒绝提示指向权限设置', function () {
  const html = Hint.buildDeniedHint();
  assert.ok(html.includes('权限'));
  assert.ok(html.includes('运动传感器'));
});

test('待授权提示指向授权按钮', function () {
  assert.ok(Hint.buildPermissionHint().includes('授权传感器'));
});

/* ---------- 无数据提示 ---------- */

test('HTTPS 下无数据时归因到权限或系统禁用', function () {
  const html = Hint.buildNoDataHint(true);
  assert.ok(html.includes('已开启，但收不到'));
  assert.ok(!html.includes('HTTPS，也没有'), 'HTTPS 下不该再提白名单');
});

test('HTTP 下无数据时归因到协议', function () {
  const html = Hint.buildNoDataHint(false);
  assert.ok(html.includes('不是 HTTPS'));
  assert.ok(html.includes('白名单'));
});

/* ---------- 结构完整性 ---------- */

/* 这些串是用 innerHTML 插入的，标签不配对会把后面的 DOM 吞掉。
   不引入 DOM 解析器，直接数标签数量。 */
function countTag(html, tag) {
  const open = (html.match(new RegExp('<' + tag + '(\\s|>)', 'g')) || []).length;
  const close = (html.match(new RegExp('</' + tag + '>', 'g')) || []).length;
  return { open: open, close: close };
}

test('各提示标签配对', function () {
  const builders = [
    ['unsupported', Hint.buildUnsupportedHint()],
    ['insecure', Hint.buildInsecureHint('http://10.0.0.1:8765')],
    ['denied', Hint.buildDeniedHint()],
    ['permission', Hint.buildPermissionHint()],
    ['nodata-https', Hint.buildNoDataHint(true)],
    ['nodata-http', Hint.buildNoDataHint(false)],
  ];

  builders.forEach(function (pair) {
    const name = pair[0];
    const html = pair[1];
    ['strong', 'code', 'em', 'button'].forEach(function (tag) {
      const c = countTag(html, tag);
      assert.strictEqual(c.open, c.close, name + ' 的 <' + tag + '> 不配对: ' +
        c.open + ' 开 / ' + c.close + ' 闭');
    });
  });
});

test('复制按钮一定是 button 且带 copy class', function () {
  const html = Hint.buildInsecureHint('http://10.0.0.1:8765');
  assert.ok(/<button class="copy" data-copy="[^"]*">/.test(html));
});
