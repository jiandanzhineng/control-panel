/* 生产部署时可在 OSS 发布前将 apiBase 改为正式 API 域名。 */
(function (root) {
  'use strict';
  var local = root.location.hostname === 'localhost' || root.location.hostname === '127.0.0.1';
  root.GamePlatformConfig = {
    apiBase: local ? 'http://127.0.0.1:8787' : 'https://game-api.undersilicon.cn'
  };
})(window);
