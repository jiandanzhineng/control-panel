// Site-only hardware guide; intentionally not part of the game packages.
(function (root) {
  'use strict';

  var SHOP_ORIGIN = 'https://shop.undersilicon.cn';
  var REF_PATTERN = /^[A-Za-z0-9._-]{1,64}$/; // shop/src/lib/promoSource.ts
  var SURFACES = ['detail', 'list', 'modal'];
  var docsOrigin = 'https://docs.undersilicon.cn';
  // Use the actual manifest slot IDs, not every kit or accessory from the guide.
  var pressureSlots = { sensor: 'cunzhi01', motor: 'cunzhi01' };
  var slotProducts = {
    'pressure-edging': pressureSlots,
    'pressure-edging-v2': pressureSlots,
    'surge-edging': pressureSlots,
    'pelvic-training': { sensor: 'kuoyue-sensor' },
    'drink-pee-unlock': { scale: 'electronic-scale' },
    'maid-punishment': { shock: 'tiptoe-v2' },
    'pushup-detection': { qtz: 'distance-sensor' },
    'reading-game': { shock: 'beidanci' },
    'vocab-game': { shock: 'beidanci' },
  };

  function localePath(locale) { return locale === 'en' ? '/en' : '/zh'; }

  function withRef(url, ref) {
    // The explicit end check also rejects final newlines (JS $ can match before one).
    if (REF_PATTERN.test(ref) && !/\s/.test(ref)) url.searchParams.set('ref', ref);
    return url.href;
  }

  function shopUrl(locale, ref) {
    return withRef(new URL(SHOP_ORIGIN + localePath(locale)), ref || '');
  }

  function surfaceRef(surface, gameId) {
    return SURFACES.indexOf(surface) >= 0 && gameId ? 'play-' + surface + '-' + gameId : '';
  }

  function productUrl(slug, locale, surface, gameId) {
    var url = new URL(SHOP_ORIGIN + localePath(locale) + '/products/' + encodeURIComponent(slug));
    return withRef(url, surfaceRef(surface, gameId));
  }

  function docsUrl(docPath, locale) {
    return docPath ? docsOrigin + (locale === 'en' ? '/en' : '') + docPath : '';
  }

  var api = { productUrl: productUrl, shopUrl: shopUrl, docsUrl: docsUrl };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root) return;

  var assetBase = new URL('../data/', document.currentScript.src);
  var products = Object.create(null);
  var hardware = Object.create(null);
  var loading;

  function read(file) {
    return fetch(new URL(file, assetBase)).then(function (res) {
      if (!res.ok) throw new Error(file + ': HTTP ' + res.status);
      return res.json();
    });
  }

  api.load = function () {
    if (!loading) loading = Promise.all([read('shop-products.json'), read('game-hardware.json')])
      .then(function (data) {
        data[0].forEach(function (p) { products[p.slug] = p; });
        Object.assign(hardware, data[1]);
      })
      .catch(function (err) {
        loading = null;
        console.warn('Shop catalog unavailable:', err);
      });
    return loading;
  };

  api.guideFor = function (gameId) { return hardware[gameId]; };
  api.itemsFor = function (gameId, locale) {
    var guide = api.guideFor(gameId);
    return (guide ? guide.items : []).filter(function (item) { return products[item.slug]; })
      .map(function (item) {
        var p = products[item.slug];
        var en = locale === 'en';
        return { slug: item.slug, role: item.role, name: en ? p.nameEn : p.nameZh,
          image: p.image, note: en ? item.noteEn : item.note };
      });
  };
  api.itemForSlot = function (gameId, slotId, locale) {
    var slots = Object.hasOwn(slotProducts, gameId) && slotProducts[gameId];
    var slug = slots && slots[slotId];
    return api.itemsFor(gameId, locale).find(function (item) { return item.slug === slug; });
  };
  root.ShopCatalog = api;
})(typeof window === 'undefined' ? null : window);
