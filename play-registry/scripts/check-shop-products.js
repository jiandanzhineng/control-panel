#!/usr/bin/env node
'use strict';

const hardware = require('../assets/data/game-hardware.json');
const products = require('../assets/data/shop-products.json');
const slugs = new Set(products.map((p) => p.slug));

for (const [gameId, { items }] of Object.entries(hardware)) {
  for (const { slug } of items) {
    if (!slugs.has(slug)) {
      console.error(`${gameId}: 未知商城商品 slug ${slug}`);
      process.exitCode = 1;
    }
  }
}

if (!process.exitCode) console.log('硬件清单与商城商品快照校验通过');
