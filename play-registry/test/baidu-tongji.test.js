'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const MARKER = 'baidu-tongji.js';

function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '.site') continue;
      walk(p, acc);
    } else if (ent.name.endsWith('.html')) {
      acc.push(p);
    }
  }
  return acc;
}

const files = walk(ROOT);
const admin = files.filter((f) => path.basename(f) === 'admin.html');
const others = files.filter((f) => path.basename(f) !== 'admin.html' && !f.includes(`${path.sep}games${path.sep}`));

assert.ok(admin.length === 1, 'expected one admin.html');
assert.ok(!fs.readFileSync(admin[0], 'utf8').includes(MARKER), 'admin.html must not include tongji');
assert.ok(others.length > 0, 'expected public html files');
for (const f of others) {
  assert.ok(fs.readFileSync(f, 'utf8').includes(MARKER), `${path.relative(ROOT, f)} missing tongji`);
}
console.log('PASS: public pages have tongji, admin.html does not');
