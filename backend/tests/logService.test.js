const fs = require('fs');
const os = require('os');
const path = require('path');
const { LogService } = require('../services/logService');

describe('buffered log persistence', () => {
  let directory;
  let service;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-log-'));
    service = new LogService({ logsDir: directory });
  });

  afterEach(async () => {
    await service.flush();
    jest.restoreAllMocks();
    jest.useRealTimers();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('emits live logs immediately and writes a burst in one batch', async () => {
    const append = jest.spyOn(fs.promises, 'appendFile');
    const writes = () => append.mock.calls.filter(([file]) => path.dirname(file) === directory);
    const syncAppend = jest.spyOn(fs, 'appendFileSync');
    const live = jest.fn();
    service.on('newLog', live);
    for (let n = 0; n < 100; n++) service.info('Device', `report-${n}`);
    expect(live).toHaveBeenCalledTimes(100);
    expect(writes()).toHaveLength(0);
    expect(syncAppend).not.toHaveBeenCalled();
    await service.flush();
    expect(writes()).toHaveLength(1);
    const lines = fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(100);
    expect(lines[0]).toContain('report-0');
    expect(lines[99]).toContain('report-99');
  });

  it('flushes automatically after the batch interval', async () => {
    jest.useFakeTimers();
    const append = jest.spyOn(fs.promises, 'appendFile');
    service.info('Device', 'automatic');
    await jest.advanceTimersByTimeAsync(100);
    await service.flush();
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('waits for messages queued during an in-flight flush', async () => {
    let release;
    const append = jest.spyOn(fs.promises, 'appendFile')
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    service.info('Device', 'first');
    const flushing = service.flush();
    service.info('Device', 'second');
    expect(service.flush()).toBe(flushing);
    release();
    await flushing;
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1][1]).toContain('second');
  });

  it('keeps midnight batches in their original daily files', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-05T23:59:59.999Z') });
    service.info('Device', 'before midnight');
    jest.setSystemTime(new Date('2026-09-06T00:00:00.001Z'));
    service.info('Device', 'after midnight');
    await service.flush();
    expect(fs.readFileSync(path.join(directory, '2026-09-05.log'), 'utf8')).toContain('before midnight');
    expect(fs.readFileSync(path.join(directory, '2026-09-06.log'), 'utf8')).toContain('after midnight');
  });

  it('retains failed batches for the next flush without throwing from log()', async () => {
    jest.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(new Error('disk unavailable'));
    expect(() => service.info('Device', 'first')).not.toThrow();
    await expect(service.flush()).rejects.toThrow('disk unavailable');
    service.info('Device', 'second');
    await service.flush();
    const contents = fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8');
    expect(contents.indexOf('first')).toBeLessThan(contents.indexOf('second'));
  });
});
