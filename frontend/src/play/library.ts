// 游戏库合并 / 排序 / 筛选的纯逻辑（不依赖 Vue 与 i18n，便于 node 单测）。
// 规则见 docs/plans/game-library-redesign.md「合并规则」。

export type LibraryFilter = 'all' | 'local' | 'online' | 'apps' | 'test';
export type GameLaunch = 'local' | 'remote';

export interface GameDevice {
  id?: string;
  logicalId?: string;
  label?: string;
  required?: boolean;
  capabilities?: string[];
  [key: string]: unknown;
}

export interface LocalGame {
  id: string;
  title?: string;
  name?: string;
  description?: string;
  version?: string;
  devices?: GameDevice[];
  source?: string;
  lastPlayed?: number | null;
  cached?: boolean;
  gamePath?: string;
  externalUrl?: string;
  origin?: string;
  localGamePath?: string;
  [key: string]: unknown;
}

export interface RemoteGame extends LocalGame {
  source?: 'remote';
  packageSize?: number;
  cacheable?: boolean;
}

export interface LibraryGame {
  id: string;
  title: string;
  description: string;
  /** 本机已安装版本（没有本机副本时取在线版本） */
  version: string;
  remoteVersion: string | null;
  devices: GameDevice[];
  local: LocalGame | null;
  remote: RemoteGame | null;
  /** 从哪一侧启动：可更新时走在线（一点就是最新版） */
  launch: GameLaunch;
  updateAvailable: boolean;
  lastPlayed: number | null;
  cached: boolean;
  packageSize: number;
}

export function titleOf(game: { title?: string; name?: string; id?: string }): string {
  return String(game.title || game.name || game.id || '');
}

/** 内置的测试游戏（设备控制台等），按 id 强制归入「测试」。 */
export const TEST_GAME_IDS = ['device-control'];

/** 条目或 manifest 上的测试标记：test === true / category === 'test' / tags 含 'test'。 */
function hasTestMark(game: LocalGame | RemoteGame | null | undefined): boolean {
  if (!game) return false;
  const row = game as unknown as Record<string, unknown>;
  const manifest = row.manifest && typeof row.manifest === 'object'
    ? (row.manifest as Record<string, unknown>)
    : null;
  return [row, manifest].some(
    (m) => !!m && (m.test === true || m.category === 'test'
      || (Array.isArray(m.tags) && (m.tags as unknown[]).includes('test'))),
  );
}

/** 测试游戏：用于联调的条目，不进「全部/本机/在线」，也不进「继续上次」。 */
export function isTestGame(game: LibraryGame): boolean {
  if (!game) return false;
  if (hasTestMark(game.local) || hasTestMark(game.remote)) return true;
  const id = String(game.id || '');
  if (TEST_GAME_IDS.includes(id) || /^(qa-|zz-)/i.test(id)) return true;
  // 只认明确的测试字样（「联调」「（测试）」「测试版」、独立的 QA），避免「打字速度测试」之类正常游戏被误判
  return /联调|[（(]测试[)）]|测试版|(^|[^A-Za-z])QA([^A-Za-z]|$)/i.test(String(game.title || ''));
}

interface ParsedVersion {
  nums: [number, number, number];
  pre: string[];
}

function parseVersion(value?: string | null): ParsedVersion {
  const raw = String(value || '').trim().replace(/^v/i, '');
  const m = raw.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return { nums: [0, 0, 0], pre: [] };
  return {
    nums: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)],
    pre: m[4] ? m[4].split('.') : [],
  };
}

/**
 * semver 比较：返回 >0 表示 a 比 b 新。支持 v 前缀与 -pre 预发布，
 * 解析失败按 0.0.0 处理（不引第三方依赖）。
 */
export function compareVersions(a?: string | null, b?: string | null): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  if (!pa.pre.length && !pb.pre.length) return 0;
  if (!pa.pre.length) return 1;
  if (!pb.pre.length) return -1;
  const n = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i += 1) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return pa.pre.length - pb.pre.length;
}

export function isCachedGame(game?: LocalGame | null): boolean {
  if (!game) return false;
  if (game.cached === true) return true;
  return String(game.gamePath || game.localGamePath || '').startsWith('/games/cache/');
}

function devicesOf(game: LocalGame | RemoteGame | null | undefined): GameDevice[] {
  return Array.isArray(game?.devices) ? game!.devices! : [];
}

/** 按 id 合并本机与在线游戏；一个 id 只出一张卡。 */
export function mergeGames(localGames: LocalGame[], remoteGames: RemoteGame[]): LibraryGame[] {
  const byId = new Map<string, LibraryGame>();
  for (const remote of remoteGames || []) {
    const id = String(remote?.id || '');
    if (!id) continue;
    byId.set(id, {
      id,
      title: titleOf(remote),
      description: String(remote.description || ''),
      version: String(remote.version || '0.0.0'),
      remoteVersion: remote.version ? String(remote.version) : null,
      devices: devicesOf(remote),
      local: null,
      remote,
      launch: 'remote',
      updateAvailable: false,
      lastPlayed: null,
      cached: isCachedGame(remote),
      packageSize: Number(remote.packageSize || 0),
    });
  }
  for (const local of localGames || []) {
    const id = String(local?.id || '');
    if (!id) continue;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, {
        id,
        title: titleOf(local),
        description: String(local.description || ''),
        version: String(local.version || '0.0.0'),
        remoteVersion: null,
        devices: devicesOf(local),
        local,
        remote: null,
        launch: 'local',
        updateAvailable: false,
        lastPlayed: typeof local.lastPlayed === 'number' ? local.lastPlayed : null,
        cached: isCachedGame(local),
        packageSize: 0,
      });
      continue;
    }
    const localVersion = String(local.version || existing.version || '0.0.0');
    const update = !!(local.version && existing.remoteVersion)
      && compareVersions(existing.remoteVersion, localVersion) > 0;
    const launch: GameLaunch = update ? 'remote' : 'local';
    const localDevices = devicesOf(local);
    const remoteDevices = devicesOf(existing.remote);
    byId.set(id, {
      ...existing,
      title: titleOf(local),
      description: String(local.description || existing.description || ''),
      version: localVersion,
      devices: launch === 'remote' ? (remoteDevices.length ? remoteDevices : localDevices) : (localDevices.length ? localDevices : remoteDevices),
      local,
      launch,
      updateAvailable: update,
      lastPlayed: typeof local.lastPlayed === 'number' ? local.lastPlayed : null,
      cached: isCachedGame(local),
    });
  }
  return Array.from(byId.values());
}

export interface SortOptions {
  runningId?: string | null;
  locale?: string;
}

/** 排序：运行中 > 最后游玩倒序 > 本机未玩 > 在线未装（按标题）。 */
export function sortGames(games: LibraryGame[], options: SortOptions = {}): LibraryGame[] {
  const locale = options.locale || 'en';
  const rank = (g: LibraryGame) => (options.runningId && g.id === options.runningId ? 1 : 0);
  return [...games].sort((a, b) => {
    const ar = rank(a);
    const br = rank(b);
    if (ar !== br) return br - ar;
    const al = a.lastPlayed || 0;
    const bl = b.lastPlayed || 0;
    if (al !== bl) return bl - al;
    if (!!a.local !== !!b.local) return a.local ? -1 : 1;
    const byTitle = a.title.localeCompare(b.title, locale);
    return byTitle !== 0 ? byTitle : a.id.localeCompare(b.id, locale);
  });
}

export function matchesQuery(value: { title?: string; description?: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return String(value.title || '').toLowerCase().includes(q) || String(value.description || '').toLowerCase().includes(q);
}

/** 筛选：测试游戏单独成组，不计入全部/本机/在线；本机 = 有本机副本；在线 = 在线库里有。 */
export function filterGames(games: LibraryGame[], filter: LibraryFilter, query = ''): LibraryGame[] {
  const list = games.filter((g) => matchesQuery(g, query));
  if (filter === 'test') return list.filter(isTestGame);
  if (filter === 'apps') return [];
  const normal = list.filter((g) => !isTestGame(g));
  if (filter === 'local') return normal.filter((g) => g.local !== null);
  // 「在线」= 在线库里有的游戏（含本机已装），与「本机」可重叠
  if (filter === 'online') return normal.filter((g) => g.remote !== null);
  return normal;
}

/** 最近游玩：跳过测试游戏，「继续上次」永远不会指向它们。 */
export function mostRecentGame(games: LibraryGame[]): LibraryGame | null {
  let best: LibraryGame | null = null;
  for (const game of games) {
    if (!game.lastPlayed || isTestGame(game)) continue;
    if (!best || game.lastPlayed > (best.lastPlayed || 0)) best = game;
  }
  return best;
}

export const HIDDEN_CAPABILITIES = ['reporting'];

export interface DeviceChip {
  key: string;
  label: string;
  required: boolean;
  capabilities: string[];
}

/** 设备需求 chips：按设备去重合并能力，隐藏 reporting，最多 max 个。 */
export function deviceChips(devices?: GameDevice[] | null, max = 4): { chips: DeviceChip[]; overflow: number } {
  const byKey = new Map<string, DeviceChip>();
  let index = 0;
  for (const device of devices || []) {
    index += 1;
    if (!device || typeof device !== 'object') continue;
    const label = String(device.label || '');
    const key = String(device.id || device.logicalId || label || `#${index}`);
    const caps = (Array.isArray(device.capabilities) ? device.capabilities : [])
      .filter((cap) => cap && !HIDDEN_CAPABILITIES.includes(cap));
    const prev = byKey.get(key);
    if (prev) {
      prev.required = prev.required || device.required === true;
      if (!prev.label && label) prev.label = label;
      for (const cap of caps) if (!prev.capabilities.includes(cap)) prev.capabilities.push(cap);
    } else {
      byKey.set(key, { key, label, required: device.required === true, capabilities: [...caps] });
    }
  }
  const all = Array.from(byKey.values());
  const limit = Math.max(0, max);
  return { chips: all.slice(0, limit), overflow: Math.max(0, all.length - limit) };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface RelativeTime {
  kind: 'never' | 'justNow' | 'minutes' | 'hours' | 'days' | 'months' | 'years';
  value: number;
}

/** 相对时间（传入 now 便于单测）：由 UI 映射到 i18n 文案。 */
export function relativeTime(ts?: number | null, now = Date.now()): RelativeTime {
  if (ts == null || !Number.isFinite(Number(ts)) || Number(ts) <= 0) return { kind: 'never', value: 0 };
  const diff = Math.max(0, now - Number(ts));
  if (diff < MINUTE) return { kind: 'justNow', value: 0 };
  if (diff < HOUR) return { kind: 'minutes', value: Math.floor(diff / MINUTE) };
  if (diff < DAY) return { kind: 'hours', value: Math.floor(diff / HOUR) };
  if (diff < 30 * DAY) return { kind: 'days', value: Math.floor(diff / DAY) };
  if (diff < 365 * DAY) return { kind: 'months', value: Math.floor(diff / (30 * DAY)) };
  return { kind: 'years', value: Math.floor(diff / (365 * DAY)) };
}

export function formatSize(bytes?: number | null): string {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 按 id 得到稳定的封面色相 0-359。 */
export function hueForId(id: string): number {
  let hue = 0;
  for (const ch of String(id || '')) hue = (hue * 31 + (ch.codePointAt(0) || 0)) % 360;
  return hue;
}

/** 封面上的大号字形（取首字符，兼容 emoji / 中文）。 */
export function firstGlyph(title?: string): string {
  const chars = Array.from(String(title || '').trim());
  return (chars[0] || '?').toUpperCase();
}
