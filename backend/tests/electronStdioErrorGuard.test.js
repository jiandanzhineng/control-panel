const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const {
  handleStdioError,
  installStdioErrorGuards,
} = require('../../electron/stdioErrorGuard');

describe('Electron stdio error guard', () => {
  it('ignores broken pipes but keeps unexpected stream errors visible', () => {
    expect(() => handleStdioError(Object.assign(new Error('closed pipe'), { code: 'EPIPE' })))
      .not.toThrow();
    expect(() => handleStdioError(Object.assign(new Error('unexpected'), { code: 'EIO' })))
      .toThrow('unexpected');
  });

  it('guards stdout and stderr only once', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();

    installStdioErrorGuards({ stdout, stderr });
    installStdioErrorGuards({ stdout, stderr });

    expect(stdout.listenerCount('error')).toBe(1);
    expect(stderr.listenerCount('error')).toBe(1);
    expect(() => stdout.emit('error', Object.assign(new Error('closed pipe'), { code: 'EPIPE' })))
      .not.toThrow();
    expect(() => stderr.emit('error', Object.assign(new Error('closed pipe'), { code: 'EPIPE' })))
      .not.toThrow();
  });

  it('keeps a process alive after its stdout reader disconnects', async () => {
    const guardPath = require.resolve('../../electron/stdioErrorGuard');
    const script = `
      const { installStdioErrorGuards } = require(${JSON.stringify(guardPath)});
      installStdioErrorGuards();
      setTimeout(() => console.log('write after reader disconnect'), 50);
      setTimeout(() => process.exit(0), 150);
    `;
    const child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.destroy();

    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });
});
