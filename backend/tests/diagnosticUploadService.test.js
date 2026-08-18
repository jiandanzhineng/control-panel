const fs = require('fs');
const os = require('os');
const path = require('path');

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('diagnosticUploadService', () => {
  let tempDir;
  let previousDataDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-upload-'));
    previousDataDir = process.env.BACKEND_DATA_DIR;
    process.env.BACKEND_DATA_DIR = path.join(tempDir, 'data');
    jest.resetModules();
  });

  afterEach(() => {
    restoreEnv('BACKEND_DATA_DIR', previousDataDir);
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('parses panel log lines and redacts bearer tokens', () => {
    const service = require('../services/diagnosticUploadService');
    const parsed = service.parseLogLine(
      '[2026-08-18T01:02:03.000Z] [INFO] [System] Authorization: Bearer abc.def-ghi',
    );
    expect(parsed.level).toBe('info');
    expect(parsed.category).toBe('System');
    expect(parsed.message).toContain('Bearer ***');
    expect(parsed.message).not.toContain('abc.def-ghi');
  });

  it('builds a user_report bundle even when logs are empty', () => {
    const service = require('../services/diagnosticUploadService');
    const bundle = service.buildBundle([], []);
    expect(bundle.reason).toBe('user_report');
    expect(bundle.logs[0].event).toBe('empty_log_bundle');
    expect(bundle.context.app).toBe('control-panel');
    expect(bundle.anonymousId).toHaveLength(32);
  });
});
