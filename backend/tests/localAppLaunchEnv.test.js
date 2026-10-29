const path = require('path');

jest.mock('../services/voiceSettingsService', () => ({
  getTakoConfig: jest.fn(() => ({ api_key: 'local-tako-key', proxy: 'http://127.0.0.1:7990' })),
}));

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('localAppLaunchEnv', () => {
  const previous = {};

  beforeEach(() => {
    for (const key of ['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONIOENCODING', 'PYTHONUTF8', 'BACKEND_URL']) {
      previous[key] = process.env[key];
    }
    jest.resetModules();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) restoreEnv(key, value);
  });

  it('prepends cwd/bin and strips python vars', () => {
    process.env.PYTHONHOME = 'C:\\old-python';
    process.env.PYTHONPATH = 'C:\\old-site';
    process.env.PYTHONSTARTUP = 'startup.py';
    const { launchEnv } = require('../services/localAppLaunchEnv');
    const cwd = 'D:\\apps\\digital-human\\current';
    const env = launchEnv({ env: {} }, cwd);
    const key = Object.keys(env).find((name) => name.toLowerCase() === 'path');
    expect(env[key].startsWith(path.resolve(cwd, 'bin') + path.delimiter)).toBe(true);
    expect(env.PYTHONHOME).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
    expect(env.PYTHONSTARTUP).toBeUndefined();
    expect(env.DIGITAL_HUMAN_NO_BROWSER).toBe('1');
  });

  it('does not invent python vars on a clean env', () => {
    delete process.env.PYTHONHOME;
    delete process.env.PYTHONPATH;
    delete process.env.PYTHONSTARTUP;
    const { launchEnv } = require('../services/localAppLaunchEnv');
    const env = launchEnv({}, path.resolve('x'));
    expect('PYTHONHOME' in env).toBe(false);
    expect('PYTHONPATH' in env).toBe(false);
  });

  it('uses UTF-8 for piped Python output even with an inherited GBK setting', () => {
    process.env.PYTHONIOENCODING = 'gbk';
    process.env.PYTHONUTF8 = '0';
    const { launchEnv } = require('../services/localAppLaunchEnv');
    const env = launchEnv({ env: { PYTHONIOENCODING: 'gbk' } }, path.resolve('x'));
    expect(env.PYTHONIOENCODING).toBe('utf-8');
    expect(env.PYTHONUTF8).toBe('1');
    expect(process.env.PYTHONIOENCODING).toBe('gbk');
  });

  it('passes Tako credentials only to the digital-human child', () => {
    const { launchEnv } = require('../services/localAppLaunchEnv');
    const digitalHuman = launchEnv({}, path.resolve('x'), 'digital-human');
    const otherApp = launchEnv({}, path.resolve('x'), 'other-app');
    expect(digitalHuman.TAKO_API_KEY).toBe('local-tako-key');
    expect(digitalHuman.TAKO_PROXY).toBe('http://127.0.0.1:7990');
    expect(otherApp.TAKO_API_KEY).toBeUndefined();
    expect(otherApp.TAKO_PROXY).toBeUndefined();
  });

  it('includes last output lines in the exit hint', () => {
    const { exitHint } = require('../services/localAppLaunchEnv');
    expect(exitHint(1, [])).toBe('进程提前退出 (1)');
    expect(exitHint(1, ['ffmpeg not found'])).toBe('进程提前退出 (1)：ffmpeg not found');
  });
});
