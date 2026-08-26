// 将跨平台 Rust 桥(bridge/target/release)复制到 tools/，供 Electron 主进程监管(spawn)。
// 跨平台：macOS 复制 ycy_bridge / dglab_bridge；Windows 复制 .exe 版本。
const fs = require('fs');
const path = require('path');

const ext = process.platform === 'win32' ? '.exe' : '';
const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'bridge', 'target', 'release');
const dstDir = path.join(root, 'tools');

if (!fs.existsSync(dstDir)) {
  fs.mkdirSync(dstDir, { recursive: true });
}

for (const name of ['ycy_bridge', 'dglab_bridge']) {
  const src = path.join(srcDir, name + ext);
  const dst = path.join(dstDir, name + ext);
  if (!fs.existsSync(src)) {
    console.warn(`[copy-bridge] 跳过 ${src}（尚未构建，请先运行 cargo build --release --manifest-path bridge/Cargo.toml）`);
    continue;
  }
  fs.copyFileSync(src, dst);
  try { fs.chmodSync(dst, 0o755); } catch (_) { /* 已可执行则忽略 */ }
  console.log(`[copy-bridge] ${src} -> ${dst}`);
}
