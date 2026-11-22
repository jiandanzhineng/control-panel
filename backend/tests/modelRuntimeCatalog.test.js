const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateModel, loadCatalog } = require('../model-runtime/catalog');

function baseModel(overrides = {}) {
  return {
    id: 'demo-model',
    task: 'asr',
    title: { zh: '演示', en: 'Demo' },
    engine: 'sherpa-onnx',
    engineConfig: { type: 'sense_voice', model: 'm.onnx', tokens: 'tokens.txt' },
    files: [{ name: 'm.onnx', bytes: 3, sha256: 'a'.repeat(64), urls: ['https://example.com/m.onnx'] }],
    providers: ['cpu'],
    license: { name: 'MIT' },
    recommended: true,
    ...overrides,
  };
}

describe('model runtime catalog', () => {
  test('accepts a valid model', () => {
    expect(validateModel(baseModel())).toEqual([]);
  });

  test('rejects missing and malformed fields', () => {
    const errors = validateModel(baseModel({
      id: 'Bad ID',
      title: { zh: '', en: 'Demo' },
      files: [{ name: 'm.onnx', bytes: -1, sha256: 'xyz', urls: [] }],
      providers: [],
      recommended: 'yes',
    }));
    expect(errors.length).toBeGreaterThanOrEqual(6);
    expect(errors.join('\n')).toMatch(/id/);
    expect(errors.join('\n')).toMatch(/sha256/);
  });

  test('rejects file and path names that could escape the model directory', () => {
    const errors = validateModel(baseModel({
      task: '__proto__',
      engineConfig: { type: 'sense_voice', model: '../m.onnx', tokens: 'a/../../tokens.txt' },
      files: [{ name: '../m.onnx', bytes: 3, sha256: 'a'.repeat(64), urls: ['https://example.com/m.onnx'] }],
    }));
    const text = errors.join('\n');
    expect(text).toMatch(/task/);
    expect(text).toMatch(/engineConfig\.model/);
    expect(text).toMatch(/engineConfig\.tokens/);
    expect(text).toMatch(/file\.name/);
  });

  test('loads a directory and reports invalid files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-catalog-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(baseModel()));
      fs.writeFileSync(path.join(dir, 'b.json'), '{oops');
      fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(baseModel({ id: 'x', task: '' })));
      const result = loadCatalog(dir);
      expect(result.models.map((m) => m.id)).toEqual(['demo-model']);
      expect(result.invalid).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
