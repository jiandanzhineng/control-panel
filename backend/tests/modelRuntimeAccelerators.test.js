const fs = require('fs');
const os = require('os');
const path = require('path');
const { Accelerators } = require('../model-runtime/accelerators');

const model = {
  id: 'demo', task: 'asr', providers: ['cuda', 'directml', 'npu', 'cpu'],
  title: { zh: '', en: '' }, engine: 'sherpa-onnx', engineConfig: {},
  files: [], license: { name: 'MIT' }, recommended: true,
};
const catalog = { list: () => [model], get: (id) => (id === 'demo' ? model : null) };

function makeAccelerators({ providers = ['cpu'], nvidia = null, npu = null, dir } = {}) {
  const engine = { supportedProviders: () => providers, buildInfo: () => ({ name: 'fake', providers }) };
  return new Accelerators({
    engine, catalog, cachePath: path.join(dir, 'acc.json'),
    probeNvidia: () => nvidia, probeNpu: () => npu, platform: 'win32',
  });
}

describe('Accelerators', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-acc-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('always reports CPU and marks unsupported providers with a reason', () => {
    const acc = makeAccelerators({ nvidia: { name: 'GTX 1050 Ti', driver: '581.80' }, dir });
    const devices = acc.probeAll();
    expect(devices.find((d) => d.id === 'cpu')).toMatchObject({ available: true, reason: null });
    expect(devices.find((d) => d.id === 'cuda')).toMatchObject({
      supported: false, available: false, reason: 'engine-unsupported',
    });
  });

  test('requires a successful load before enabling a GPU', () => {
    const acc = makeAccelerators({ providers: ['cuda', 'cpu'], nvidia: { name: 'GTX', driver: '1' }, dir });
    expect(acc.probeAll().find((d) => d.id === 'cuda')).toMatchObject({ available: false, reason: 'untested' });
    acc.recordBenchmark('demo', 'cuda', 120);
    acc.recordBenchmark('demo', 'cpu', 400);
    expect(acc.probeAll().find((d) => d.id === 'cuda')).toMatchObject({ available: true, reason: null });
    expect(acc.orderForModel('demo', 'auto')).toEqual(['cuda', 'cpu']);
  });

  test('drops a provider after two failures and restores it on refresh', () => {
    const acc = makeAccelerators({ providers: ['cuda', 'cpu'], nvidia: { name: 'GTX', driver: '1' }, dir });
    acc.recordBenchmark('demo', 'cuda', 100);
    acc.recordFailure('demo', 'cuda');
    expect(acc.orderForModel('demo', 'auto')).toContain('cuda');
    acc.recordFailure('demo', 'cuda');
    expect(acc.orderForModel('demo', 'auto')).toEqual(['cpu']);
    expect(acc.devicesForModel('demo').find((d) => d.id === 'cuda')).toMatchObject({
      available: false, reason: 'failed-twice', failures: 2,
    });
    expect(acc.refresh().find((d) => d.id === 'cuda').reason).toBe('untested');
  });

  test('falls back to CPU when a manual provider is not usable', () => {
    const acc = makeAccelerators({ providers: ['cpu'], nvidia: null, dir });
    expect(acc.orderForModel('demo', 'cuda')).toEqual(['cpu']);
  });

  test('recognizes an NPU but leaves it disabled until an engine supports it', () => {
    const acc = makeAccelerators({ providers: ['cpu'], npu: 'Intel AI Boost', dir });
    const npu = acc.probeAll().find((d) => d.id === 'npu');
    expect(npu.name).toContain('Intel AI Boost');
    expect(npu).toMatchObject({ present: true, supported: false, available: false });
  });
});
