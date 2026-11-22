// 把 assets/icon.svg 渲染成多尺寸 PNG，再由 Python(Pillow) 合成 assets/icon.ico。
// 用法：node tools/render-icon.cjs [outDir]   （默认 tmp/icon），再跑 tools/build-icon-ico.py
const fs = require('fs');
const path = require('path');
const puppeteer = require('../backend/node_modules/puppeteer');

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

(async () => {
  const root = path.resolve(__dirname, '..');
  const outDir = path.resolve(root, process.argv[2] || 'tmp/icon');
  fs.mkdirSync(outDir, { recursive: true });
  const svg = fs.readFileSync(path.join(root, 'assets', 'icon.svg'), 'utf-8');
  // ≤32px 用去掉引脚的简化版，任务栏/托盘小尺寸更清晰
  const small = fs.readFileSync(path.join(root, 'assets', 'icon-small.svg'), 'utf-8');
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const size of SIZES) {
      await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
      await page.setContent(
        `<html><body style="margin:0;background:transparent">` +
          (size <= 32 ? small : svg).replace('<svg ', `<svg width="${size}" height="${size}" `) +
          `</body></html>`,
      );
      const file = path.join(outDir, `icon-${size}.png`);
      await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
      console.log(file);
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
