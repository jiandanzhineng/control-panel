'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { productUrl, shopUrl, docsUrl } = require('../assets/js/shop-catalog');
const hardware = require('../assets/data/game-hardware.json');
const products = require('../assets/data/shop-products.json');

// Keep this assertion independent of the generator (shop/src/lib/promoSource.ts).
const REF_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

test('all guide entries reference products in the price-free snapshot', () => {
  const slugs = new Set(products.map(({ slug }) => slug));
  assert.equal(slugs.size, products.length);
  assert.deepEqual(Object.keys(hardware).sort(), [
    'device-control', 'drink-pee-unlock', 'heart-rate-trainer', 'maid-punishment',
    'pelvic-training', 'pressure-edging', 'pressure-edging-v2', 'pushup-detection',
    'rc-car', 'reading-game', 'surge-edging', 'vocab-game',
  ]);
  for (const product of products) {
    assert.deepEqual(Object.keys(product).sort(), ['image', 'nameEn', 'nameZh', 'slug']);
    if (product.image) assert.match(product.image, /^https:\/\/shop\.undersilicon\.cn\/uploads\//);
  }
  for (const [gameId, { items }] of Object.entries(hardware)) {
    for (const { slug } of items) assert.ok(slugs.has(slug), `${gameId}: ${slug}`);
  }
});

test('all product links use the correct language and an accepted ref on every surface', () => {
  for (const [gameId, { items }] of Object.entries(hardware)) {
    for (const { slug } of items) {
      for (const surface of ['detail', 'list', 'modal']) {
        for (const locale of ['zh', 'en']) {
          const url = new URL(productUrl(slug, locale, surface, gameId));
          assert.equal(url.origin, 'https://shop.undersilicon.cn');
          assert.equal(url.pathname, `/${locale}/products/${slug}`);
          assert.match(url.searchParams.get('ref'), REF_PATTERN);
          assert.equal(url.searchParams.get('ref'), `play-${surface}-${gameId}`);
        }
      }
    }
  }
});

test('invalid attribution is omitted without breaking the product link', () => {
  for (const id of ['invalid id', '游戏', 'a'.repeat(64), 'test\n', '']) {
    assert.equal(productUrl('distance-sensor', 'en', 'detail', id),
      'https://shop.undersilicon.cn/en/products/distance-sensor');
  }
  assert.equal(productUrl('distance-sensor', 'zh', 'nav', 'pushup-detection'),
    'https://shop.undersilicon.cn/zh/products/distance-sensor');
});

test('shop landing pages and tutorial links use the correct locale', () => {
  assert.equal(shopUrl('zh', 'play-nav'), 'https://shop.undersilicon.cn/zh?ref=play-nav');
  assert.equal(shopUrl('en', 'play-detail-device-control'),
    'https://shop.undersilicon.cn/en?ref=play-detail-device-control');
  assert.equal(docsUrl(hardware['pressure-edging'].docPath, 'zh'), 'https://docs.undersilicon.cn/docs/player/cunzhi01');
  assert.equal(docsUrl(hardware['pushup-detection'].docPath, 'en'), 'https://docs.undersilicon.cn/en/docs/player/pushup-game');
  for (const id of ['vocab-game', 'reading-game']) assert.equal(docsUrl(hardware[id].docPath, 'zh'), '');
});
