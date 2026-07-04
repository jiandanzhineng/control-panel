const puppeteer = require('puppeteer');
const http = require('http');

const BASE = 'http://localhost:3000';

function httpReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const opts = { hostname: 'localhost', port: 3000, path, method, headers: { 'Content-Type': 'application/json' } };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(opts, (res) => {
      let chunks = ''; res.on('data', c => chunks += c);
      res.on('end', () => { try { resolve(JSON.parse(chunks)); } catch (_) { resolve(chunks); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function testGame(browser, game, deviceMap, setupFn) {
  const dmParam = encodeURIComponent(JSON.stringify(deviceMap));
  const url = `${BASE}${game.gamePath}?deviceMap=${dmParam}`;
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

  await page.goto(url, { waitUntil: 'networkidle0', timeout: 10000 });

  // Wait for DeviceAPI.ready
  const bridgeReady = await page.evaluate(() => {
    return new Promise((resolve) => {
      if (window.DeviceAPI && window.DeviceAPI.ready) {
        window.DeviceAPI.ready.then(() => resolve(true)).catch(() => resolve(false));
        setTimeout(() => resolve(false), 5000);
      } else { resolve(false); }
    });
  });

  if (!bridgeReady) {
    await page.close();
    return { game: game.id, pass: false, reason: 'Bridge did not connect', errors };
  }

  // Run game-specific setup (inject sensor data, etc)
  if (setupFn) await setupFn();
  await sleep(2000);

  // Check page is not blank and has content
  const bodyText = await page.evaluate(() => document.body.innerText);
  const hasContent = bodyText.length > 20;

  // Check no critical JS errors
  const criticalErrors = errors.filter(e => !e.includes('favicon') && !e.includes('404'));

  await page.close();
  const pass = bridgeReady && hasContent && criticalErrors.length === 0;
  return { game: game.id, pass, bridgeReady, hasContent, errors: criticalErrors };
}

async function main() {
  console.log('=== Browser Game Testing ===\n');

  // Create virtual devices for all game types
  await httpReq('POST', '/api/virtual-devices/batch', { devices: [
    { id: 'vb_qiya', type: 'QIYA', properties: { pressure: 5.0, report_delay_ms: 1000 } },
    { id: 'vb_td01', type: 'TD01', properties: { power: 0 } },
    { id: 'vb_dianji', type: 'DIANJI', properties: { shock: 0, voltage: 0 } },
    { id: 'vb_lock', type: 'ZIDONGSUO', properties: { open: 1 } },
    { id: 'vb_qtz', type: 'QTZ', properties: { distance: 200, button0: 0, button1: 0, low_band: 150, high_band: 350 } },
    { id: 'vb_dzc', type: 'DZC01', properties: { weight: 1000, report_delay_ms: 1000 } },
    { id: 'vb_cunzhi', type: 'CUNZHI01', properties: { pressure: 0, pressure1: 0, power: 0 } },
  ]});
  console.log('Virtual devices created.\n');

  const games = await httpReq('GET', '/api/games');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

  const deviceMaps = {
    'pressure-edging': { sensor: ['vb_qiya'], motor: ['vb_td01'], punish: ['vb_dianji'], lock: ['vb_lock'] },
    'pressure-edging-v2': { sensor: ['vb_qiya'], motor: ['vb_td01'], punish: ['vb_dianji'], lock: ['vb_lock'] },
    'maid-punishment': { qtz: ['vb_qtz'], tiptoeSensor: ['vb_cunzhi'], shock: ['vb_dianji'], motor: ['vb_td01'], lock: ['vb_lock'] },
    'pushup-detection': { qtz: ['vb_qtz'], lock: ['vb_lock'], shock: ['vb_dianji'], vibrator: ['vb_td01'] },
    'pelvic-training': { sensor: ['vb_qiya'], punish: ['vb_dianji'], lock: ['vb_lock'] },
    'drink-pee-unlock': { scale: ['vb_dzc'], sensor: ['vb_qiya'], qtz: ['vb_qtz'], punish: ['vb_dianji'], vibe: ['vb_td01'], lock: ['vb_lock'] },
  };

  const setupFns = {
    'pressure-edging': () => httpReq('PUT', '/api/virtual-devices/vb_qiya/properties', { pressure: 12.0 }),
    'pressure-edging-v2': () => httpReq('PUT', '/api/virtual-devices/vb_qiya/properties', { pressure: 10.0 }),
    'pelvic-training': () => httpReq('PUT', '/api/virtual-devices/vb_qiya/properties', { pressure: 8.0 }),
    'maid-punishment': () => httpReq('PUT', '/api/virtual-devices/vb_cunzhi/properties', { pressure1: 150 }),
    'pushup-detection': () => httpReq('PUT', '/api/virtual-devices/vb_qtz/properties', { distance: 100 }),
    'drink-pee-unlock': () => httpReq('PUT', '/api/virtual-devices/vb_dzc/properties', { weight: 1050 }),
  };

  const results = [];
  for (const game of games) {
    const dm = deviceMaps[game.id] || {};
    const setup = setupFns[game.id] || null;
    console.log(`Testing: ${game.id} (${game.name})...`);
    try {
      const result = await testGame(browser, game, dm, setup);
      results.push(result);
      console.log(`  ${result.pass ? 'PASS' : 'FAIL'} - bridge:${result.bridgeReady} content:${result.hasContent} errors:${result.errors?.length || 0}`);
      if (result.errors?.length) result.errors.forEach(e => console.log(`    ERR: ${e}`));
    } catch (e) {
      results.push({ game: game.id, pass: false, reason: e.message });
      console.log(`  FAIL - ${e.message}`);
    }
  }

  await browser.close();

  // Check commands received by virtual motor
  const motorCmds = await httpReq('GET', '/api/virtual-devices/vb_td01/commands');
  const shockCmds = await httpReq('GET', '/api/virtual-devices/vb_dianji/commands');
  console.log(`\nVirtual device commands received:`);
  console.log(`  Motor (vb_td01): ${motorCmds.length} commands`);
  console.log(`  Shock (vb_dianji): ${shockCmds.length} commands`);

  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  console.log(`\n=== Results: ${passed}/${total} games passed ===`);

  if (passed < total) {
    console.log('\nFailed games:');
    results.filter(r => !r.pass).forEach(r => console.log(`  ${r.game}: ${r.reason || r.errors?.join('; ')}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
