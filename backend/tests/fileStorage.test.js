const fs = require('fs');
const os = require('os');
const path = require('path');

describe('atomic asynchronous file storage', () => {
  let directory;
  let previousDataDir;
  let storage;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-storage-'));
    previousDataDir = process.env.BACKEND_DATA_DIR;
    process.env.BACKEND_DATA_DIR = directory;
    jest.resetModules();
    storage = require('../utils/fileStorage');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousDataDir === undefined) delete process.env.BACKEND_DATA_DIR;
    else process.env.BACKEND_DATA_DIR = previousDataDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('replaces an existing record and leaves no temporary files', async () => {
    storage.setItem('devices', 'old');
    await storage.setItemAsync('devices', [{ id: 'demo' }]);
    expect(JSON.parse(storage.getItem('devices'))).toEqual([{ id: 'demo' }]);
    expect(fs.readdirSync(directory)).toEqual(['devices.json']);
  });

  it('preserves the previous record if replacement fails', async () => {
    storage.setItem('devices', 'old');
    jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('access denied'));
    await expect(storage.setItemAsync('devices', 'new')).rejects.toThrow('access denied');
    expect(storage.getItem('devices')).toBe('old');
    expect(fs.readdirSync(directory)).toEqual(['devices.json']);
  });
});
