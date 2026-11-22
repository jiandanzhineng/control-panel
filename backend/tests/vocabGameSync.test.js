/**
 * 背单词游戏云存档同步单测（游戏侧，不测 bridge 动作）。
 * 覆盖 docs/plans/vocab-game.md 4.3：冲突用 err.remote 合并后重试、最多 3 次、
 * 网络失败保留本机缓存并标记离线。
 */
const assert = require('assert')
const core = require('../games/vocab-game/vocab-core.js')
const { VocabGame } = require('../games/vocab-game/game.js')
const test = (name, fn) => globalThis.test(name, fn)

function memoryStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) }
  }
}

function makeGame(cloud) {
  const game = new VocabGame({
    window: null,
    document: null,
    deviceApi: null,
    cloud: cloud,
    storage: memoryStorage(),
    now: () => 1000
  })
  game.signedIn = true
  game.userId = 'u1'
  game.online = true
  game.save = { v: 1, words: { local: { k: 1, due: 2, last: 1, wrong: 0, u: 10 } }, plans: {} }
  return game
}

test('版本冲突：用 err.remote 合并后带新版本重试', async () => {
  const calls = []
  const remoteSave = {
    v: 1,
    words: {
      local: { k: 2, due: 9, last: 1, wrong: 0, u: 20 },
      remote: { k: 1, due: 3, last: 2, wrong: 0, u: 15 }
    },
    plans: {}
  }
  const cloud = {
    put: async (data, baseVersion) => {
      calls.push(baseVersion)
      if (calls.length === 1) {
        const error = new Error('conflict')
        error.code = 'VERSION_CONFLICT'
        error.remote = { data: remoteSave, version: 5 }
        throw error
      }
      return { version: 6, updatedAt: 1000 }
    }
  }
  const game = makeGame(cloud)
  game.cloudVersion = 4
  game.dirty = true
  const ok = await game._maybeUpload(true)
  assert.strictEqual(ok, true)
  assert.deepStrictEqual(calls, [4, 5])
  assert.strictEqual(game.cloudVersion, 6)
  assert.strictEqual(game.syncState, 'synced')
  assert.strictEqual(game.dirty, false)
  assert.strictEqual(game.save.words.local.k, 2)
  assert.strictEqual(game.save.words.remote.k, 1)
})

test('连续冲突最多重试 3 次，之后标记待同步', async () => {
  let calls = 0
  const cloud = {
    put: async () => {
      calls += 1
      const error = new Error('conflict')
      error.code = 'VERSION_CONFLICT'
      error.remote = { data: { v: 1, words: {}, plans: {} }, version: calls }
      throw error
    }
  }
  const game = makeGame(cloud)
  game.dirty = true
  const ok = await game._maybeUpload(true)
  assert.strictEqual(ok, false)
  assert.strictEqual(calls, 3)
  assert.strictEqual(game.syncState, 'pending')
  assert.strictEqual(game.dirty, true)
})

test('网络失败：保留本机存档、角标离线，并节流到 30 秒后再试', async () => {
  let calls = 0
  const cloud = {
    put: async () => {
      calls += 1
      const error = new Error('network')
      error.code = 'NETWORK'
      throw error
    }
  }
  const game = makeGame(cloud)
  game.dirty = true
  const ok = await game._maybeUpload(true)
  assert.strictEqual(ok, false)
  assert.strictEqual(calls, 1)
  assert.strictEqual(game.syncState, 'offline')
  assert.strictEqual(game.dirty, true)
  assert.strictEqual(game.lastUploadAt, 1000)
  assert.ok(game._readCache().save.words.local)
})

test('未登录时上传返回 NOT_SIGNED_IN，转为离线并保留缓存', async () => {
  let calls = 0
  const cloud = {
    put: async () => {
      calls += 1
      const error = new Error('not signed in')
      error.code = 'NOT_SIGNED_IN'
      throw error
    }
  }
  const game = makeGame(cloud)
  game.dirty = true
  await game._maybeUpload(true)
  assert.strictEqual(calls, 1)
  assert.strictEqual(game.signedIn, false)
  assert.strictEqual(game.syncState, 'offline')
  assert.ok(game._readCache().save.words.local)
})
