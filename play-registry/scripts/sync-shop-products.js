#!/usr/bin/env node
'use strict';

// Same bilingual, price-free snapshot as ezs-docs/tool/sync-shop-products.mjs.
const fs = require('node:fs');
const path = require('node:path');
const SHOP_ORIGIN = 'https://shop.undersilicon.cn';
const OUT_FILE = path.resolve(__dirname, '../assets/data/shop-products.json');

async function fetchProducts(locale) {
  const url = `${SHOP_ORIGIN}/api/products?locale=${locale}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`请求 ${url} 失败：HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const [zh, en] = await Promise.all([fetchProducts('zh'), fetchProducts('en')]);
  const enNames = new Map(en.map((p) => [p.slug, p.name]));
  const products = zh.map((p) => ({
    slug: p.slug,
    nameZh: p.name,
    nameEn: enNames.get(p.slug) || p.name,
    image: p.image ? new URL(p.image, SHOP_ORIGIN).href : '',
  }));
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(products, null, 2)}\n`, 'utf8');
  console.log(`已写入 ${OUT_FILE}（${products.length} 个商品）`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
