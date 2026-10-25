const fs = require('fs');
const path = require('path');
const Module = require('module');
const gameService = require('../services/gameService');
const gameCacheService = require('../services/gameCacheService');
const surgeCore = require('./cores/surge-edging-core');
const pressureV2Core = require('./cores/pressure-edging-v2-core');

const DEFAULT_CORE_FILE = 'game-core.js';
const DEFAULT_LIST_TTL_MS = 5000;
const CACHE_PREFIX = '/games/cache/';
const GAMES_PREFIX = '/games/';
// 拆分游戏的宿主核心必须实现的接口，与 gameHostService 的调用面保持一致
const CORE_METHODS = ['start', 'step', 'snapshot', 'pause', 'resume', 'stop', 'setParams', 'action'];

// 内置核心：包内核心缺失或损坏时兜底（老玩法走的老路径）
const BUILTIN_CORES = {
  [surgeCore.GAME_ID]: surgeCore.SurgeEdgingCore,
  [pressureV2Core.GAME_ID]: pressureV2Core.PressureEdgingV2Core,
};
const BUILTIN_MANIFESTS = [
  require('./cores/surge-edging-manifest'),
  require('./cores/pressure-edging-v2-manifest'),
];

function coreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toPosix(value) {
  return String(value == null ? '' : value).replace(/\\/g, '/');
}

// 含 .. / 盘符 / UNC 的路径一律视为越界
function isEscapingPath(value) {
  const raw = toPosix(value);
  if (!raw) return false;
  if (raw.includes('\0') || raw.startsWith('//') || /^[a-zA-Z]:/.test(raw)) return true;
  return raw.split('/').includes('..');
}

class GameCoreResolver {
  constructor({
    getGameById = gameService.getGameById,
    getGameRoot = gameService.getGameRoot,
    getCacheRoot = gameCacheService.getCacheRoot,
    listGames = gameService.listGames,
    readFile = fs.readFileSync,
    existsSync = fs.existsSync,
    realpathSync = fs.realpathSync,
    now = Date.now,
    listTtlMs = DEFAULT_LIST_TTL_MS,
  } = {}) {
    this.getGameById = getGameById;
    this.getGameRoot = getGameRoot;
    this.getCacheRoot = getCacheRoot;
    this.listGames = listGames;
    this.readFile = readFile;
    this.existsSync = existsSync;
    this.realpathSync = realpathSync;
    this.now = now;
    this.listTtlMs = listTtlMs;
    this.moduleCache = new Map();
    this.listCache = null;
    this.lastError = null;
  }

  // 热路径（路由 / remoteGameService）会频繁调用，列表结果按 listTtlMs 缓存，避免每次重扫 games 目录。
  // 安装 / 删除 / 换版本后由调用方显式 clearCache()（见 routes/games.js 的 reload 与 delete），
  // TTL 只是兜底，不在这里每次深扫清单。
  listHostGames() {
    const nowMs = Number(this.now());
    const cached = this.listCache;
    if (cached && nowMs - cached.atMs < this.listTtlMs) return cached.rows;
    const byId = new Map();
    for (const manifest of BUILTIN_MANIFESTS) {
      const row = this._rowFromManifest(manifest, 'builtin', '');
      if (row) byId.set(row.id, row);
    }
    for (const row of this._scanPackageRows()) byId.set(row.id, row);
    const rows = Array.from(byId.values());
    this.listCache = { atMs: nowMs, rows };
    return rows;
  }

  _rowFromManifest(manifest, source, folder) {
    if (!manifest || typeof manifest !== 'object') return null;
    const id = String(manifest.id || manifest.GAME_ID || '').trim();
    if (!id) return null;
    return {
      id,
      title: String(manifest.title || manifest.TITLE || id),
      version: String(manifest.version || manifest.VERSION || '1.0.0'),
      runtimeMode: 'host',
      devices: Array.isArray(manifest.devices || manifest.DEVICES) ? (manifest.devices || manifest.DEVICES) : [],
      params: Array.isArray(manifest.params || manifest.PARAMS) ? (manifest.params || manifest.PARAMS) : [],
      source,
      folder: folder || '',
    };
  }

  // 扫描已安装游戏包：坏包只跳过并记 lastError，不能让整个列表挂掉
  _scanPackageRows() {
    const rows = [];
    let games = [];
    try {
      games = this.listGames() || [];
    } catch (error) {
      this._rememberError(`扫描游戏包失败：${error?.message || error}`);
      return rows;
    }
    for (const game of games) {
      if (!game || !game.id) continue;
      let pkg = null;
      try {
        pkg = this._readPackage(game);
      } catch (error) {
        this._rememberError(`游戏包不可用 ${game.id}：${error?.message || error}`);
        continue;
      }
      if (!pkg) continue;
      const row = this._rowFromManifest(pkg.manifest, 'package', game.folder || '');
      if (row) rows.push(row);
    }
    return rows;
  }

  isHostGame(gameId) {
    const id = String(gameId == null ? '' : gameId).trim();
    if (!id) return false;
    if (BUILTIN_CORES[id]) return true;
    try {
      return !!this.resolveGamePackage(id);
    } catch (error) {
      this._rememberError(`读取游戏包失败 ${id}：${error?.message || error}`);
      return false;
    }
  }

  // 解析已安装游戏包：未安装 / 未声明 runtime:'host' 都返回 null
  resolveGamePackage(gameId) {
    const id = String(gameId == null ? '' : gameId).trim();
    if (!id) return null;
    let game = null;
    try {
      game = this.getGameById(id);
    } catch (error) {
      this._rememberError(`查询游戏失败 ${id}：${error?.message || error}`);
      return null;
    }
    if (!game) return null;
    const pkg = this._readPackage(game);
    if (!pkg) return null;
    return {
      id,
      version: String(pkg.manifest.version || game.version || '1.0.0'),
      title: String(pkg.manifest.title || game.title || game.name || id),
      devices: Array.isArray(pkg.manifest.devices) ? pkg.manifest.devices : [],
      params: Array.isArray(pkg.manifest.params) ? pkg.manifest.params : [],
      source: pkg.source,
      dir: pkg.dir,
      corePath: pkg.corePath,
      manifest: pkg.manifest,
    };
  }

  // 读 index.html + 内联 manifest；只有声明 runtime:'host' 的包才参与宿主运行
  _readPackage(game) {
    const dir = this._packageDir(game);
    const indexPath = path.join(dir, 'index.html');
    if (!this.existsSync(indexPath)) return null;
    const manifest = gameService.extractManifestFromHtml(String(this.readFile(indexPath, 'utf8')));
    if (!manifest || String(manifest.runtime || '') !== 'host') return null;
    return {
      dir,
      source: this._isCachePath(game.gamePath) ? 'package' : 'builtin',
      manifest,
      corePath: this._corePath(dir, manifest.core),
    };
  }

  // /games/cache/<id>/<version>/... 落在缓存根，其余 /games/<folder>/... 落在 games 根
  _packageDir(game) {
    const raw = String(game.gamePath || '').trim();
    if (!raw) throw coreError('GAME_PACKAGE_UNSAFE_PATH', '游戏包缺少 gamePath');
    if (isEscapingPath(raw)) throw coreError('GAME_PACKAGE_UNSAFE_PATH', `游戏包路径不安全：${raw}`);
    const parts = toPosix(raw).split('/').filter((part) => part && part !== '.');
    const [head, second, ...rest] = parts;
    if (head !== 'games') throw coreError('GAME_PACKAGE_UNSAFE_PATH', `游戏包路径不在 games 目录内：${raw}`);
    if (!second) throw coreError('GAME_PACKAGE_UNSAFE_PATH', `游戏包路径缺少目录：${raw}`);
    // 末段是 index.html，包目录取它的上一级（缓存包形如 cache/<id>/<version>/index.html）
    const tail = rest.slice(0, -1);
    if (second === 'cache' && tail.length < 2) {
      throw coreError('GAME_PACKAGE_UNSAFE_PATH', `缓存游戏包路径缺少 id/版本：${raw}`);
    }
    const root = second === 'cache' ? this.getCacheRoot() : this.getGameRoot();
    return path.resolve(path.join(root, ...(second === 'cache' ? tail : [second, ...tail])));
  }

  // 核心文件必须在包目录内，越界一律拒绝。
  // 词法包含只是第一道；包目录/核心文件本身可能是符号链接，必须再比一次真实路径，
  // 否则 core 指向包外（或包目录本身是软链）时词法检查看不出来（见 gameCoreResolver.test.js）。
  _corePath(dir, coreFile) {
    const rel = String(coreFile || DEFAULT_CORE_FILE).trim() || DEFAULT_CORE_FILE;
    if (isEscapingPath(rel) || path.isAbsolute(rel)) {
      throw coreError('GAME_PACKAGE_UNSAFE_PATH', `游戏核心文件路径越界：${rel}`);
    }
    const target = path.resolve(dir, rel);
    const root = path.resolve(dir);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw coreError('GAME_PACKAGE_UNSAFE_PATH', `游戏核心文件越出包目录：${rel}`);
    }
    if (this.existsSync(target)) {
      let realTarget = null;
      let realRoot = null;
      try {
        realTarget = this.realpathSync(target);
        realRoot = this.realpathSync(root);
      } catch (error) {
        throw coreError('GAME_PACKAGE_UNSAFE_PATH', `游戏核心文件无法解析真实路径：${error?.message || error}`);
      }
      const resolvedRoot = path.resolve(realRoot);
      const resolvedTarget = path.resolve(realTarget);
      if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
        throw coreError('GAME_PACKAGE_UNSAFE_PATH', `游戏核心文件通过符号链接越出包目录：${rel}`);
      }
      return resolvedTarget;
    }
    return target;
  }

  _isCachePath(gamePath) {
    return toPosix(gamePath).startsWith(CACHE_PREFIX);
  }

  createCore(gameId, { params, random } = {}) {
    const id = String(gameId == null ? '' : gameId).trim();
    if (!id) throw coreError('GAME_NOT_HOSTED', '缺少 gameId');
    let pkg = null;
    let pkgError = null;
    let failure = null;
    try {
      pkg = this.resolveGamePackage(id);
    } catch (error) {
      // 路径不安全等硬错误按包损坏处理，留给内置兜底
      pkgError = error;
      failure = error?.message || String(error);
    }
    if (pkg) {
      try {
        const Ctor = this._assertCore(this._loadPackageCore(pkg), pkg);
        return new Ctor({ params, random });
      } catch (error) {
        failure = error?.message || String(error);
      }
    }
    const Builtin = BUILTIN_CORES[id];
    if (Builtin) {
      if (failure) {
        this._rememberError(`游戏包核心不可用，已回退内置核心 ${id}：${failure}`);
      }
      return new Builtin({ params, random });
    }
    if (pkgError) throw pkgError;
    if (pkg && failure) {
      throw coreError('GAME_CORE_INVALID', `游戏包核心不可用：${failure}`);
    }
    throw coreError('GAME_NOT_HOSTED', `该游戏尚未接入 HostRuntime：${id}`);
  }

  // 编译结果按 id@version 缓存：同版本不重复编译，换版本必须重新编译
  _loadPackageCore(pkg) {
    const key = `${pkg.id}@${pkg.version}`;
    const cached = this.moduleCache.get(key);
    if (cached) return cached;
    const code = String(this.readFile(pkg.corePath, 'utf8'));
    const mod = new Module(pkg.corePath, null);
    mod.filename = pkg.corePath;
    mod.paths = Module._nodeModulePaths(pkg.dir);
    try {
      mod._compile(code, pkg.corePath);
    } catch (error) {
      // 编译期报错要带上包名与版本，日志里才定位得到
      throw coreError('GAME_CORE_INVALID', `游戏包核心 ${pkg.id}@${pkg.version} 编译失败：${error?.message || error}`);
    }
    this.moduleCache.set(key, mod.exports);
    return mod.exports;
  }

  _assertCore(exports, pkg) {
    const label = `游戏包核心 ${pkg.id}@${pkg.version}`;
    const Ctor = this._pickCtor(exports);
    if (!Ctor) {
      throw coreError('GAME_CORE_INVALID', `${label} 未导出构造函数（可用 default / module.exports / { createCore } / 单个 *Core）`);
    }
    const probe = Ctor.prototype || {};
    const missing = CORE_METHODS.filter((name) => typeof probe[name] !== 'function');
    if (missing.length) {
      throw coreError('GAME_CORE_INVALID', `${label} 缺少必要方法：${missing.join('、')}`);
    }
    return Ctor;
  }

  // 构造函数识别：直接导出 / createCore 工厂 / Core|GameCore|唯一 *Core 命名导出
  _pickCtor(exports) {
    if (typeof exports === 'function') return exports;
    if (!exports || typeof exports !== 'object') return null;
    if (typeof exports.createCore === 'function') return exports.createCore;
    if (typeof exports.default === 'function') return exports.default;
    if (typeof exports.Core === 'function') return exports.Core;
    if (typeof exports.GameCore === 'function') return exports.GameCore;
    const named = Object.keys(exports).filter((key) => /Core$/.test(key) && typeof exports[key] === 'function');
    return named.length === 1 ? exports[named[0]] : null;
  }

  clearCache() {
    this.moduleCache.clear();
    this.listCache = null;
    this.lastError = null;
  }

  _rememberError(message) {
    this.lastError = { message: String(message), atMs: Number(this.now()) || 0 };
    try {
      require('../utils/logger').warn('GameCore', this.lastError.message);
    } catch (_) {}
  }
}

const resolver = new GameCoreResolver();

module.exports = resolver;
module.exports.GameCoreResolver = GameCoreResolver;
