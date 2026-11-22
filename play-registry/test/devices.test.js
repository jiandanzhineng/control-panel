'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const registry = require('../../backend/devices/registry');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('设备文档列出注册能力，切到英文站时能力列表仍使用中文 CAPS', () => {
  const html = read('docs/devices.html');
  assert.doesNotMatch(html.match(/<main[\s\S]*?<\/main>/)[0], /data-i18n/);
  const rows = Array.from(html.matchAll(/<tr><td><code>([^<]+)<\/code><\/td><td>.*?<\/td><td data-cap-list>(.*?)<\/td><\/tr>/g));
  const types = Object.fromEntries(rows.map(([, type, list]) => [type, Array.from(list.matchAll(/<code>([^<]+)<\/code>/g), ([, cap]) => cap)]));
  assert.deepEqual(types, registry.getTypeCapabilityMap());
  const codes = Object.keys(Object.fromEntries(Object.values(types).flat().map((cap) => [cap, true])));
  const labels = {};
  const document = {
    readyState: 'loading', addEventListener() {},
    createElement: () => ({ append(label, code) { labels[code.textContent] = label.trim(); } }),
    querySelectorAll: () => codes.map((cap) => ({ textContent: cap, before() {} })),
  };
  const ctx = vm.createContext({ document, localStorage: { getItem: () => 'en' } });
  vm.runInContext(read('assets/js/i18n.js'), ctx);
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ctx);
  for (const cap of codes) {
    assert.match(labels[cap], /\p{Script=Han}/u);
    assert.equal(labels[cap], ctx.SiteI18n.capLabel(cap, 'zh'));
  }
  assert.equal(ctx.SiteI18n.capLabel('heartRate'), 'Heart rate');
});

test('控制页优先显示配置标题，回落 CAPS；默认名本地化且保留自定义昵称', async () => {
  const callbacks = {};
  const elements = new Map();
  const document = {
    readyState: 'loading', documentElement: {}, querySelectorAll: () => [],
    addEventListener(name, fn) { (callbacks[name] ||= []).push(fn); },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { querySelectorAll: () => [], querySelector: () => null, addEventListener() {} });
      return elements.get(id);
    },
  };
  const devices = [
    { id: 'CUNZHI01', name: 'cunzhi01', type: 'CUNZHI01', typeConfig: { name: '寸止玩法设备', capabilityConfig: { sphincterPressure: { name: '括约压力' } } }, capabilities: ['sphincterPressure'] },
    { id: 'aabbccddeeff', name: '心率带 eeff', type: 'HRM', typeConfig: { name: '心率带' }, capabilities: ['heartRate'] },
    { id: 'aabbccdd0011', name: 'base-0011', type: 'DAN01', typeConfig: { name: '十轴姿态传感器' } },
    { id: 'DZC01', name: 'DZC01', type: 'DZC01', typeConfig: { name: '电子秤' } },
    { id: 'QTZ', name: 'QTZ', nickname: '我的设备', type: 'QTZ', typeConfig: { name: '测距及脚踏传感器' }, capabilities: [] },
  ];
  const ctx = vm.createContext({
    document, addEventListener() {}, setInterval() {},
    localStorage: { getItem: () => 'zh' },
    DeviceAPI: { getGrantStatus: async () => ({ granted: true }), requestAccess() {}, getDevices: async () => devices },
  });
  ctx.window = ctx;
  vm.runInContext(read('assets/js/i18n.js'), ctx);
  vm.runInContext(read('assets/js/device-control.js'), ctx);
  callbacks.DOMContentLoaded.forEach((fn) => fn());
  await new Promise(setImmediate);
  const html = elements.get('grid').innerHTML;
  for (const label of ['寸止玩法设备 · CUNZHI01', '心率带 · eeff', '十轴姿态传感器 · 0011', '电子秤 · DZC01', '我的设备', '括约压力', '心率']) {
    assert.ok(html.includes('>' + label + '<'), label);
  }
});
