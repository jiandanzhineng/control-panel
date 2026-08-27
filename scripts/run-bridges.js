// 跨平台启动两个本机桥二进制，供 `npm run dev` 开发时使用，
// 让“本机桥接”通道在开发环境（未走 Electron 监管）也能用。
// 生产环境由 Electron 主进程 superviseBridge 监管拉起，无需本脚本。
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const isWin = process.platform === 'win32'
const toolsDir = path.join(__dirname, '..', 'tools')
const bins = [
  { name: isWin ? 'ycy_bridge.exe' : 'ycy_bridge', port: 3001 },
  { name: isWin ? 'dglab_bridge.exe' : 'dglab_bridge', port: 3002 },
]

for (const b of bins) {
  const binPath = path.join(toolsDir, b.name)
  if (!fs.existsSync(binPath)) {
    console.warn(`[run-bridges] 未找到 ${b.name}，请先运行 npm run build:bridge`)
    continue
  }
  try { fs.chmodSync(binPath, 0o755) } catch (_) {}
  const child = spawn(binPath, ['-port', String(b.port)], {
    cwd: toolsDir,
    stdio: 'ignore',
  })
  child.on('error', (e) => console.error(`[run-bridges] 启动 ${b.name} 失败:`, e.message))
  console.log(`[run-bridges] 已启动 ${b.name} (port ${b.port})`)
}
