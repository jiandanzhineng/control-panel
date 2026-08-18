const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

function assertSafeRelPath(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new Error('清单包含不安全路径');
  }
  if (normalized.split('/').includes('..')) {
    throw new Error('清单包含路径穿越');
  }
  return normalized;
}

const { zipPath, targetDir } = workerData;
const zip = new AdmZip(zipPath);
const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
parentPort.postMessage({ type: 'start', total: entries.length });
let done = 0;
for (const entry of entries) {
  const rel = assertSafeRelPath(entry.entryName.replace(/\\/g, '/'));
  const outPath = path.resolve(targetDir, rel);
  const root = path.resolve(targetDir);
  if (!(outPath === root || outPath.startsWith(root + path.sep))) {
    throw new Error('压缩包路径越界');
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, entry.getData());
  done += 1;
  if (done === 1 || done === entries.length || done % 20 === 0) {
    parentPort.postMessage({ type: 'progress', done, total: entries.length });
  }
}
parentPort.postMessage({ type: 'done', done, total: entries.length });
