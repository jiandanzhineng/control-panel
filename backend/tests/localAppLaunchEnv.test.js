const path = require('path');

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('localAppLaunchEnv', () => {
  const previous = {};

  beforeEach(() => {
    for (const key of ['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'BACKEND_URL']) {
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

  it('includes last output lines in the exit hint', () => {
    const { exitHint } = require('../services/localAppLaunchEnv');
    expect(exitHint(1, [])).toBe('进程提前退出 (1)');
    expect(exitHint(1, ['ffmpeg not found'])).toBe('进程提前退出 (1)：ffmpeg not found');
  });
});
