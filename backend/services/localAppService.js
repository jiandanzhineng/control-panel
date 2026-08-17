const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const DEFAULT_FEED = 'http://firmware.undersilicon.cn/apps';
const CATALOG = {
  'digital-human': {
    id: 'digital-human',
    title: '数字人',
    description: '本机数字人玩法。点一下安装或更新后启动。',
  },
};

const jobs = new Map();
const syncing = new Map();

function fallbackDataDir() {
  return path.resolve(__dirname, '..', 'data');
}

function dataDir() {
  return process.env.BACKEND_DATA_DIR
    ? path.resolve(process.env.BACKEND_DATA_DIR)
    : fallbackDataDir();
}

function feedBase() {
  return String(process.env.LOCAL_APP_FEED || DEFAULT_FEED).replace(/\/+$/, '');
}

function channel() {
  const value = String(process.env.LOCAL_APP_CHANNEL || 'test').trim();
  return value === 'stable' ? 'stable' : 'test';
}

function appError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function cleanId(id) {
  const value = String(id || '').trim();
  if (!CATALOG[value]) {
    throw appError('LOCAL_APP_NOT_FOUND', '未知本机应用', 404);
  }
  return value;
}

function appsRoot() {
  return path.join(dataDir(), 'apps');
}

function appRoot(id) {
  return path.join(appsRoot(), cleanId(id));
}

function currentDir(id) {
  return path.join(appRoot(id), 'current');
}

function casRoot() {
  return path.join(appsRoot(), 'cas');
}

function casPath(sha256) {
  const digest = String(sha256 || '').toLowerCase();
  return path.join(casRoot(), digest.slice(0, 2), digest);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let bytes = 0;
    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function assertSafeRelPath(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw appError('LOCAL_APP_UNSAFE_PATH', '清单包含不安全路径');
  }
  if (normalized.split('/').includes('..')) {
    throw appError('LOCAL_APP_UNSAFE_PATH', '清单包含路径穿越');
  }
  return normalized;
}

function validateManifest(id, manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw appError('LOCAL_APP_BAD_MANIFEST', '清单无效', 502);
  }
  if (manifest.id !== id || manifest.kind !== 'local-app') {
    throw appError('LOCAL_APP_BAD_MANIFEST', '清单应用不匹配', 502);
  }
  if (!manifest.version || !manifest.launch || !manifest.launch.exe) {
    throw appError('LOCAL_APP_BAD_MANIFEST', '清单缺少启动信息', 502);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw appError('LOCAL_APP_BAD_MANIFEST', '清单没有文件', 502);
  }
  for (const file of manifest.files) {
    assertSafeRelPath(file.path);
    if (!/^[a-f0-9]{64}$/i.test(String(file.sha256 || ''))) {
      throw appError('LOCAL_APP_BAD_MANIFEST', `文件哈希无效: ${file.path}`, 502);
    }
    if (!Number.isFinite(file.size) || file.size < 0) {
      throw appError('LOCAL_APP_BAD_MANIFEST', `文件大小无效: ${file.path}`, 502);
    }
  }
  return manifest;
}

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '.app-meta.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

function fileIsPresent(file) {
  const digest = String(file.sha256).toLowerCase();
  const cas = casPath(digest);
  if (fs.existsSync(cas) && fs.statSync(cas).size === file.size) return true;
  return false;
}

function planSync(manifest) {
  const missing = [];
  let bytesToDownload = 0;
  for (const file of manifest.files) {
    if (fileIsPresent(file)) continue;
    missing.push(file);
    bytesToDownload += file.size;
  }
  return { missing, bytesToDownload };
}

function fileShaList(files) {
  return (files || []).map((file) => String(file.sha256).toLowerCase()).sort();
}

function installedMatches(id, manifest) {
  const dir = currentDir(id);
  const meta = readMeta(dir);
  if (!meta || meta.version !== manifest.version) return false;
  const expected = fileShaList(manifest.files).join(',');
  const actual = fileShaList((meta.files || []).map((sha256) => ({ sha256 }))).join(',');
  if (expected !== actual) return false;
  return fs.existsSync(path.join(dir, manifest.launch.exe));
}

async function fetchLatest(id) {
  const url = `${feedBase()}/${id}/${channel()}/latest.json`;
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    throw appError('LOCAL_APP_FEED_FAILED', `清单下载失败: HTTP ${response.status}`, 502);
  }
  return validateManifest(id, await response.json());
}

function catalogEntry(id) {
  return { ...CATALOG[cleanId(id)], kind: 'local-app' };
}

function jobSnapshot(id) {
  return jobs.get(id) || {
    id,
    phase: 'idle',
    doneBytes: 0,
    totalBytes: 0,
    filesDone: 0,
    filesTotal: 0,
    error: null,
  };
}

function setJob(id, patch) {
  const next = { ...jobSnapshot(id), ...patch, id };
  jobs.set(id, next);
  return next;
}

async function getStatus(id) {
  const appId = cleanId(id);
  const entry = catalogEntry(appId);
  try {
    const manifest = await fetchLatest(appId);
    const plan = planSync(manifest);
    const installed = installedMatches(appId, manifest);
    return {
      ...entry,
      version: manifest.version,
      installed,
      needsUpdate: !installed,
      bytesToDownload: installed ? 0 : plan.bytesToDownload,
      filesToDownload: installed ? 0 : plan.missing.length,
      currentDir: installed ? currentDir(appId) : null,
      launch: manifest.launch,
      progress: jobSnapshot(appId),
    };
  } catch (error) {
    const meta = readMeta(currentDir(appId));
    return {
      ...entry,
      version: meta?.version || null,
      installed: !!meta,
      needsUpdate: true,
      bytesToDownload: null,
      filesToDownload: null,
      currentDir: meta ? currentDir(appId) : null,
      launch: meta?.launch || null,
      progress: jobSnapshot(appId),
      error: error.message,
      errorCode: error.code || 'LOCAL_APP_STATUS_FAILED',
    };
  }
}

async function listApps() {
  const ids = Object.keys(CATALOG);
  const items = [];
  for (const id of ids) {
    items.push(await getStatus(id));
  }
  return items;
}

async function downloadFile(file, onChunk) {
  const digest = String(file.sha256).toLowerCase();
  const dest = casPath(digest);
  if (fs.existsSync(dest) && fs.statSync(dest).size === file.size) return dest;
  const url = `${feedBase()}/cas/${digest.slice(0, 2)}/${digest}`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw appError('LOCAL_APP_DOWNLOAD_FAILED', `下载失败 ${file.path}: HTTP ${response.status}`, 502);
  }
  ensureDir(path.dirname(dest));
  const partial = `${dest}.part`;
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(partial, buffer);
    if (onChunk) onChunk(buffer.length);
  } else {
    const { Readable } = require('stream');
    const nodeStream = Readable.fromWeb(response.body);
    nodeStream.on('data', (chunk) => { if (onChunk) onChunk(chunk.length); });
    await pipeline(nodeStream, fs.createWriteStream(partial));
  }
  if (sha256File(partial) !== digest) {
    fs.rmSync(partial, { force: true });
    throw appError('LOCAL_APP_SHA_MISMATCH', `校验失败: ${file.path}`);
  }
  fs.renameSync(partial, dest);
  return dest;
}

function linkOrCopy(from, to) {
  ensureDir(path.dirname(to));
  fs.rmSync(to, { force: true });
  try {
    fs.linkSync(from, to);
  } catch (_) {
    fs.copyFileSync(from, to);
  }
}

function replaceDirectory(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  ensureDir(path.dirname(target));
  try {
    fs.renameSync(source, target);
  } catch (error) {
    if (error.code !== 'EXDEV' && error.code !== 'EPERM') throw error;
    fs.cpSync(source, target, { recursive: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

function extractZip(zipPath, targetDir) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(zipPath);
  for (const entry of zip.getEntries()) {
    const rel = assertSafeRelPath(entry.entryName.replace(/\\/g, '/'));
    if (entry.isDirectory) continue;
    const outPath = path.resolve(targetDir, rel);
    const root = path.resolve(targetDir);
    if (!(outPath === root || outPath.startsWith(root + path.sep))) {
      throw appError('LOCAL_APP_UNSAFE_PATH', '压缩包路径越界');
    }
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, entry.getData());
  }
}

function materialize(id, manifest) {
  const staging = path.join(appRoot(id), `staging-${Date.now()}`);
  ensureDir(staging);
  for (const file of manifest.files) {
    if (file.extract) {
      extractZip(casPath(file.sha256), staging);
      continue;
    }
    const rel = assertSafeRelPath(file.path);
    linkOrCopy(casPath(file.sha256), path.join(staging, rel));
  }
  fs.writeFileSync(path.join(staging, '.app-meta.json'), `${JSON.stringify({
    id,
    version: manifest.version,
    launch: manifest.launch,
    files: fileShaList(manifest.files),
    installedAt: Date.now(),
  }, null, 2)}\n`);
  replaceDirectory(staging, currentDir(id));
}

async function syncApp(id) {
  const appId = cleanId(id);
  if (syncing.has(appId)) return syncing.get(appId);
  const work = (async () => {
    setJob(appId, { phase: 'checking', error: null, doneBytes: 0, totalBytes: 0 });
    const manifest = await fetchLatest(appId);
    if (installedMatches(appId, manifest)) {
      return setJob(appId, { phase: 'ready', version: manifest.version });
    }
    const plan = planSync(manifest);
    setJob(appId, {
      phase: 'downloading',
      version: manifest.version,
      doneBytes: 0,
      totalBytes: plan.bytesToDownload,
      filesDone: 0,
      filesTotal: plan.missing.length,
    });
    for (const file of plan.missing) {
      await downloadFile(file, (n) => {
        const job = jobSnapshot(appId);
        setJob(appId, { doneBytes: job.doneBytes + n });
      });
      const job = jobSnapshot(appId);
      setJob(appId, { filesDone: job.filesDone + 1 });
    }
    setJob(appId, { phase: 'installing' });
    materialize(appId, manifest);
    return setJob(appId, { phase: 'ready', version: manifest.version });
  })();
  syncing.set(appId, work);
  try {
    await work;
    return getStatus(appId);
  } catch (error) {
    setJob(appId, { phase: 'error', error: error.message });
    throw error;
  } finally {
    syncing.delete(appId);
  }
}

function getCurrentLaunch(id) {
  const appId = cleanId(id);
  const dir = currentDir(appId);
  const meta = readMeta(dir);
  if (!meta) throw appError('LOCAL_APP_NOT_INSTALLED', '尚未安装', 404);
  return { id: appId, dir, meta, launch: meta.launch };
}

function _resetForTests() {
  jobs.clear();
  syncing.clear();
}

module.exports = {
  CATALOG,
  listApps,
  getStatus,
  syncApp,
  getCurrentLaunch,
  jobSnapshot,
  currentDir,
  casPath,
  _resetForTests,
};
