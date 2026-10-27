/* reMouse 提示文案生成。
 *
 * 单独抽出来是为了能测：面板里那段"HTTP 下怎么办"的说明是纯字符串拼接，
 * 一旦 HTML 少个闭合标签或转义出错，页面上就会显示成一坨乱码或吞掉后面的按钮，
 * 而这类问题在只有手机才能复现的场景里极难发现。
 *
 * 纯函数，不碰 DOM，Node 里直接 require 就能测。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Hint = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* 浏览器不支持传感器。
     这里要点明"换 Chrome"而不是笼统说"版本太旧"——
     国产套壳浏览器不实现这个接口是最高频的原因，
     用户按"升级浏览器"的思路去试永远试不出来。 */
  function buildUnsupportedHint() {
    return '<strong>这个浏览器没有 DeviceMotionEvent。</strong><br>' +
      '系统自带浏览器、微信/QQ 内置浏览器普遍不实现这个接口。<br>' +
      '请换 <strong>Chrome</strong> 或 Firefox 打开同一个地址。';
  }

  /* HTTP 下拿不到传感器数据。
     给出可以直接复制的 origin，避免手敲 IP 和端口敲错。 */
  function buildInsecureHint(origin) {
    const safe = escapeHtml(origin || '');
    return '<strong>当前是 HTTP，Chrome 不会提供传感器数据。</strong><br>' +
      'Chrome 只在「安全上下文」里开放陀螺仪。两种办法：<br><br>' +

      '<strong>① 把这个地址加进白名单（不用装证书）</strong><br>' +
      '1. 地址栏输入 <code>chrome://flags</code><br>' +
      '2. 搜索 <code>insecure</code><br>' +
      '3. 找到 <em>Insecure origins treated as secure</em><br>' +
      '4. 把下面这段填进去：<br>' +
      '<code class="origin">' + safe + '</code>' +
      '<button class="copy" data-copy="' + safe + '">复制</button><br>' +
      '5. 右侧下拉改成 <em>Enabled</em><br>' +
      '6. 按提示点 <em>Relaunch</em> 重启 Chrome<br><br>' +

      '<strong>② 换 HTTPS（一劳永逸）</strong><br>' +
      '电脑上改用 <code>py -3.11 run.py --https</code> 启动，' +
      '手机装一次根证书。证书会随 IP 变化自动重签。';
  }

  function buildDeniedHint() {
    return '<strong>传感器权限被拒绝了。</strong><br>' +
      '到浏览器设置 → 网站设置 → 运动传感器，允许本页访问后刷新。';
  }

  function buildPermissionHint() {
    return '点上面的「授权传感器」，系统会弹出确认框。';
  }

  /* 开启后 3 秒内一个事件都没来。
     这种情况最容易被误判成"代码坏了"，
     所以把两个真实原因直接写出来。 */
  function buildNoDataHint(secure) {
    const reason = secure
      ? '浏览器权限被全局关闭，或这台设备的传感器被系统禁用。'
      : '当前不是 HTTPS，也没有把本页加入 Chrome 的白名单。';
    return '<strong>已开启，但收不到传感器数据。</strong><br>' + reason;
  }

  return {
    escapeHtml: escapeHtml,
    buildUnsupportedHint: buildUnsupportedHint,
    buildInsecureHint: buildInsecureHint,
    buildDeniedHint: buildDeniedHint,
    buildPermissionHint: buildPermissionHint,
    buildNoDataHint: buildNoDataHint,
  };
});
