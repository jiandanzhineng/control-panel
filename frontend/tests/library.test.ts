import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compareVersions,
  deviceChips,
  filterGames,
  firstGlyph,
  formatSize,
  hueForId,
  isCachedGame,
  isTestGame,
  matchesQuery,
  mergeGames,
  mostRecentGame,
  relativeTime,
  sortGames,
  type LibraryGame,
  type LocalGame,
  type RemoteGame,
  TEST_GAME_IDS,
} from '../src/play/library.ts'

const local = (patch: Partial<LocalGame>): LocalGame => ({ id: 'g1', name: '本地游戏', source: 'builtin', ...patch })
const remote = (patch: Partial<RemoteGame>): RemoteGame => ({
  id: 'g1', title: 'Remote game', source: 'remote', version: '1.0.0', ...patch,
})

test('compareVersions follows semver without extra deps', () => {
  assert.ok(compareVersions('1.0.1', '1.0.0') > 0)
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0)
  assert.ok(compareVersions('v2.0.0', '1.99.99') > 0)
  assert.equal(compareVersions('1.1.13', 'v1.1.13'), 0)
  assert.ok(compareVersions('1.0.0', '1.0.0-beta.2') > 0)
  assert.ok(compareVersions('1.0.0-beta.10', '1.0.0-beta.2') > 0)
  assert.ok(compareVersions('1.0.0-beta', '1.0.0-alpha') > 0)
  assert.equal(compareVersions('not-a-version', '0.0.0'), 0)
})

test('mergeGames keeps one card per id and prefers local when it is not older', () => {
  const same = mergeGames(
    [local({ version: '1.1.0', lastPlayed: 123, devices: [{ id: 'sensor' }] })],
    [remote({ version: '1.1.0', devices: [{ id: 'remote-only' }] })],
  )
  assert.equal(same.length, 1)
  assert.equal(same[0].launch, 'local')
  assert.equal(same[0].updateAvailable, false)
  assert.equal(same[0].version, '1.1.0')
  assert.equal(same[0].remoteVersion, '1.1.0')
  assert.equal(same[0].lastPlayed, 123)
  assert.deepEqual(same[0].devices.map((d) => d.id), ['sensor'])
})

test('mergeGames launches online when the registry version is newer', () => {
  const [card] = mergeGames(
    [local({ version: '1.0.0', devices: [{ id: 'sensor' }] })],
    [remote({ version: '1.2.0', devices: [{ id: 'remote-role' }] })],
  )
  assert.equal(card.updateAvailable, true)
  assert.equal(card.launch, 'remote')
  assert.equal(card.version, '1.0.0')
  assert.equal(card.remoteVersion, '1.2.0')
  assert.deepEqual(card.devices.map((d) => d.id), ['remote-role'])
})

test('mergeGames covers local-only, online-only and cache detection', () => {
  const cards = mergeGames(
    [local({ id: 'saved', source: 'saved', cached: true })],
    [remote({ id: 'online', title: 'Online only', packageSize: 12288 })],
  )
  assert.equal(cards.length, 2)
  const saved = cards.find((c) => c.id === 'saved')!
  const online = cards.find((c) => c.id === 'online')!
  assert.equal(saved.launch, 'local')
  assert.equal(saved.cached, true)
  assert.equal(saved.title, '本地游戏')
  assert.equal(online.launch, 'remote')
  assert.equal(online.cached, false)
  assert.equal(online.packageSize, 12288)
  assert.equal(isCachedGame({ id: 'x', gamePath: '/games/cache/x/index.html' }), true)
  assert.equal(isCachedGame({ id: 'x', cached: true }), true)
  assert.equal(isCachedGame({ id: 'x' }), false)
})

test('sortGames puts running first, then last played, local-unplayed, online', () => {
  const cards = mergeGames(
    [
      local({ id: 'a', name: 'Alpha', lastPlayed: 1000 }),
      local({ id: 'b', name: 'Bravo' }),
    ],
    [
      remote({ id: 'c', title: 'Charlie' }),
      remote({ id: 'd', title: 'Delta' }),
      remote({ id: 'a', title: 'Alpha', version: '1.0.0' }),
    ],
  )
  const sorted = sortGames(cards, { runningId: 'c', locale: 'en' })
  assert.deepEqual(sorted.map((g) => g.id), ['c', 'a', 'b', 'd'])
  assert.deepEqual(sortGames(cards, { locale: 'en' }).map((g) => g.id), ['a', 'b', 'c', 'd'])
})

test('filterGames splits by local/online and searches title and description', () => {
  const cards = mergeGames(
    [local({ id: 'a', name: 'Alpha', description: 'pressure training', lastPlayed: 500 }), local({ id: 'b', name: 'Bravo', description: 'x' })],
    [remote({ id: 'a', title: 'Alpha' }), remote({ id: 'c', title: 'Charlie', version: '2.0.0' })],
  )
  assert.deepEqual(filterGames(cards, 'local').map((g) => g.id).sort(), ['a', 'b'])
  assert.deepEqual(filterGames(cards, 'online').map((g) => g.id).sort(), ['a', 'c'])
  assert.deepEqual(filterGames(cards, 'apps'), [])
  assert.deepEqual(filterGames(cards, 'all', 'pressure').map((g) => g.id), ['a'])
  assert.equal(matchesQuery({ title: 'Alpha', description: 'Desc' }, ' DESC '), true)
  assert.equal(matchesQuery({ title: 'Alpha' }, 'nope'), false)
  assert.equal(mostRecentGame(cards)?.id, 'a')
})

test('deviceChips dedupes roles, hides reporting and caps the list', () => {
  const { chips, overflow } = deviceChips([
    { id: 'sensor', label: '压力传感器', required: true, capabilities: ['sphincterPressure', 'reporting'] },
    { id: 'sensor', label: '压力传感器', capabilities: ['buttonInput', 'sphincterPressure'] },
    { id: 'lock', required: false, capabilities: ['lock'] },
    { id: 'vibe', label: '震动', capabilities: ['vibration'] },
    { id: 'shock', label: '电击', required: true, capabilities: ['shock'] },
    { id: 'extra', label: '多余', capabilities: [] },
  ], 4)
  assert.equal(chips.length, 4)
  assert.equal(overflow, 1)
  assert.deepEqual(chips[0], {
    key: 'sensor',
    label: '压力传感器',
    required: true,
    capabilities: ['sphincterPressure', 'buttonInput'],
  })
  assert.equal(chips[1].label, '')
  assert.deepEqual(chips[1].capabilities, ['lock'])
})

test('relativeTime passes now in and maps to kinds', () => {
  const now = 1_700_000_000_000
  assert.deepEqual(relativeTime(null, now), { kind: 'never', value: 0 })
  assert.deepEqual(relativeTime(now - 10_000, now), { kind: 'justNow', value: 0 })
  assert.deepEqual(relativeTime(now - 5 * 60_000, now), { kind: 'minutes', value: 5 })
  assert.deepEqual(relativeTime(now - 3 * 3_600_000, now), { kind: 'hours', value: 3 })
  assert.deepEqual(relativeTime(now - 3 * 86_400_000, now), { kind: 'days', value: 3 })
  assert.deepEqual(relativeTime(now - 70 * 86_400_000, now), { kind: 'months', value: 2 })
  assert.deepEqual(relativeTime(now - 400 * 86_400_000, now), { kind: 'years', value: 1 })
  assert.deepEqual(relativeTime(now + 10_000, now), { kind: 'justNow', value: 0 })
})

test('formatSize, hueForId and firstGlyph are display helpers', () => {
  assert.equal(formatSize(0), '')
  assert.equal(formatSize(900), '900 B')
  assert.equal(formatSize(12_288), '12 KB')
  assert.equal(formatSize(1_572_864), '1.5 MB')
  assert.equal(hueForId('device-control'), hueForId('device-control'))
  assert.ok(hueForId('device-control') >= 0 && hueForId('device-control') < 360)
  assert.notEqual(hueForId('a'), hueForId('b'))
  assert.equal(firstGlyph(' 设备控制台'), '设')
  assert.equal(firstGlyph('reading'), 'R')
  assert.equal(firstGlyph(''), '?')
})

test('isTestGame detects test manifests, ids and titles', () => {
  const card = (patch: Parameters<typeof mergeGames>[0][number]) => mergeGames([local(patch)], [])[0]
  assert.equal(isTestGame(card({ id: 'plain', name: 'Reading game' })), false)
  assert.equal(isTestGame(card({ id: 'flagged', name: 'Flagged', test: true })), true)
  assert.equal(isTestGame(card({ id: 'categorized', name: 'Categorized', category: 'test' })), true)
  assert.equal(isTestGame(card({ id: 'tagged', name: 'Tagged', tags: ['test'] })), true)
  assert.equal(isTestGame(card({ id: 'manifest-test', name: 'M', manifest: { test: true } })), true)
  assert.equal(isTestGame(card({ id: 'manifest-tag', name: 'M', manifest: { tags: ['test'] } })), true)
  assert.equal(isTestGame(card({ id: 'device-control', name: '设备控制台' })), true)
  for (const id of TEST_GAME_IDS) assert.equal(isTestGame(card({ id, name: id })), true)
  assert.equal(isTestGame(card({ id: 'qa-runtime-20260905', name: 'Game Platform QA' })), true)
  assert.equal(isTestGame(card({ id: 'zz-hr-probe', name: '心率探针（联调）' })), true)
  assert.equal(isTestGame(card({ id: 'zz-anything', name: 'ZZ' })), true)
  assert.equal(isTestGame(card({ id: 'plain2', name: '打字速度测试' })), false)
  assert.equal(isTestGame(card({ id: 'plain3', name: '寸止（测试）' })), true)
  assert.equal(isTestGame(card({ id: 'plain4', name: '寸止测试版' })), true)
  assert.equal(isTestGame(mergeGames([], [remote({ id: 'remote-test', title: 'R', manifest: { test: true } })])[0]), true)
})

test('filterGames keeps test games only in the test filter', () => {
  const cards = mergeGames(
    [
      local({ id: 'a', name: 'Alpha', lastPlayed: 900 }),
      local({ id: 'zz-hr-probe', name: '心率探针（联调）', lastPlayed: 999 }),
    ],
    [
      remote({ id: 'a', title: 'Alpha' }),
      remote({ id: 'qa-runtime-20260905', title: 'Game Platform QA', description: 'qa' }),
    ],
  )
  assert.deepEqual(filterGames(cards, 'all').map((g) => g.id), ['a'])
  assert.deepEqual(filterGames(cards, 'local').map((g) => g.id), ['a'])
  assert.deepEqual(filterGames(cards, 'online').map((g) => g.id), ['a'])
  assert.deepEqual(filterGames(cards, 'test').map((g) => g.id).sort(), ['qa-runtime-20260905', 'zz-hr-probe'])
  assert.deepEqual(filterGames(cards, 'test', '心率').map((g) => g.id), ['zz-hr-probe'])
  assert.deepEqual(filterGames(cards, 'all', 'qa'), [])
  assert.equal(cards.length, 3)
})

test('mostRecentGame ignores test games', () => {
  const cards = mergeGames(
    [local({ id: 'a', name: 'Alpha', lastPlayed: 100 }), local({ id: 'qa-x', name: 'QA rig', lastPlayed: 999 })],
    [],
  )
  assert.equal(mostRecentGame(cards)?.id, 'a')
  assert.equal(mostRecentGame(mergeGames([local({ id: 'qa-only', name: 'QA', lastPlayed: 1 })], [])), null)
})
