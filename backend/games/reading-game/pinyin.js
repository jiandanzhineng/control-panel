/**
 * 页面内拼音转换（替代原版主进程 IPC text-to-pinyin）
 * 下标规则沿用 electron-client services/pinyinService.js：按 origin.length 累加，charIndex 指回原文本下标。
 * 浏览器用 vendor/pinyin-pro.min.js（UMD，MIT）暴露的 window.pinyinPro，Node 里直接 require vendor 文件。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./vendor/pinyin-pro.min.js'))
  } else {
    root.RGPinyin = factory(root.pinyinPro)
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (pinyinPro) {
  'use strict'

  function textToPinyin(text) {
    const source = String(text == null ? '' : text)
    if (!source.trim()) return { chars: [], syllables: [] }
    if (!pinyinPro || typeof pinyinPro.pinyin !== 'function') {
      return { chars: [], syllables: [], error: 'pinyin-unavailable' }
    }

    let items = []
    try {
      items = pinyinPro.pinyin(source, {
        toneType: 'none',
        type: 'all',
        nonZh: 'consecutive'
      })
    } catch (error) {
      // 拼音库异常时退化为空结果，调用方会按“识别不可用”降级
      return { chars: [], syllables: [], error: error.message }
    }

    const chars = []
    const syllables = []
    let charIndex = 0
    for (let i = 0; i < items.length; i++) {
      const item = items[i] || {}
      const origin = String(item.origin != null ? item.origin : '')
      const len = Math.max(1, origin.length)
      for (let k = 0; k < len; k++) {
        chars.push({
          char: origin.charAt(k),
          charIndex: charIndex + k,
          isZh: false,
          pinyin: '',
          initial: '',
          final: ''
        })
      }
      const isZh = item.isZh === true && !!item.pinyin
      if (isZh) {
        const entry = {
          char: origin,
          charIndex,
          isZh,
          pinyin: item.pinyin || '',
          initial: item.initial || '',
          final: item.final || ''
        }
        if (chars.length >= charIndex + 1) {
          chars[charIndex] = entry
        }
        syllables.push({
          char: origin,
          charIndex,
          pinyin: entry.pinyin,
          initial: entry.initial,
          final: entry.final
        })
      }
      charIndex += len
    }

    return { chars, syllables }
  }

  return { textToPinyin }
})
