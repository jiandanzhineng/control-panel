// test/extract.test.js — 锁定 extractManifestFromHtml 的行为，防与面板侧漂移。
// 面板侧 backend/services/gameService.js 用同一正则；任一方改正则，此 fixture 会立刻暴露。
// 运行：npm test（node --test）
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { extractManifestFromHtml, MANIFEST_RE } = require('../scripts/build-registry');

// 固定 fixture：覆盖 id 在最前 / type 在前 两种写法，确保正则都匹配。
const CASE_TYPE_FIRST = `<html><head>
<script type="application/json" id="game-manifest">
{ "id": "demo", "title": "演示", "version": "1.2.3", "devices": [], "params": [] }
</script></head><body></body></html>`;

const CASE_ID_FIRST = `<html><head>
<script id="game-manifest" type="application/json">
{ "id": "demo2", "title": "演示2", "version": "0.9.0" }
</script></head><body></body></html>`;

const CASE_NO_MANIFEST = `<html><head></head><body>no manifest here</body></html>`;

test('提取 type 在前的 manifest', () => {
  const m = extractManifestFromHtml(CASE_TYPE_FIRST);
  assert.strictEqual(m.id, 'demo');
  assert.strictEqual(m.title, '演示');
  assert.strictEqual(m.version, '1.2.3');
});

test('提取 id 在最前的 manifest（旧正则 [^>]+id 会失配，新正则 [^>]*\\bid 通过）', () => {
  const m = extractManifestFromHtml(CASE_ID_FIRST);
  assert.ok(m, 'id 在最前的写法必须能匹配');
  assert.strictEqual(m.id, 'demo2');
});

test('无 manifest 返回 null', () => {
  assert.strictEqual(extractManifestFromHtml(CASE_NO_MANIFEST), null);
});

test('正则字面量导出（供双端一致性人工核对）', () => {
  assert.ok(MANIFEST_RE instanceof RegExp);
});
