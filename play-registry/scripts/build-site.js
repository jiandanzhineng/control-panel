#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ROOT, '..');
const OUT = path.join(ROOT, '.site');

function copyDir(src, dest, skip = () => false) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip(ent.name)) continue;
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(from, to, skip);
    else if (ent.isFile()) fs.copyFileSync(from, to);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
copyDir(ROOT, OUT, (name) => new Set([
  '.git',
  '.site',
  'node_modules',
  'scripts',
  'test',
  'package.json',
  'package-lock.json',
  'README.md',
  '.gitignore',
  '.gitattributes',
]).has(name) || name.endsWith('.log'));

const outGames = path.join(OUT, 'games');
fs.mkdirSync(outGames, { recursive: true });
copyDir(path.join(REPO_ROOT, 'backend', 'games'), outGames);
fs.rmSync(path.join(outGames, '.gitkeep'), { force: true });

console.log(`site -> ${path.relative(ROOT, OUT)}`);
