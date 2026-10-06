// 游戏状态增量补丁（GameStatePatch）
// 一份文件两处用：后端 require('../public/game-state-patch')，
// 游戏页面通过 /bridge-api/game-state-patch.js 加载（全局 window.GameStatePatch）。
//
// op 契约（其他代码依赖，不要改）：
//   { op: 'set',     path: 'a.b', value: <任意> }
//   { op: 'del',     path: 'a.b' }
//   { op: 'append',  path: 'logs', items: [新尾部条目] }
//   { op: 'prepend', path: 'logs', items: [新头部条目] }
//   根路径是空字符串 ''。
//
// diff 规则：
//   1. 两边都是普通对象 → 逐 key 递归。只在 next 里 → set；只在 prev 里 → del；
//      next 里值为 undefined 的 key 视为删除（发 del）。
//   2. key 为空串、或含 '.' / '\' 时无法用路径寻址 → 只要该 key 有变化
//      （新增/删除/改值）就退化为对整个父对象发一条 set（根层父对象即整份替换）。
//   3. 数组：prev 是 next 的前缀（等长前缀深度相等）→ append next.slice(prev.length)；
//      否则 prev 是 next 的后缀 → prepend next.slice(0, next.length - prev.length)；
//      都不是 → 整段 set。append/prepend 条目数超过 MAX_ARRAY_ITEMS 时退回 set。
//   4. 其余情况（原始值、类型变化、null、Date 之类）只要不深度相等就 set。
//   5. op 数超过 MAX_OPS → 返回 [{ op: 'set', path: '', value: next }] 全量替换。
//   6. 绝不修改 prev/next；set 的 value 按引用传递（不深拷贝）。
//
// apply 规则：
//   - set 的 path 为 '' 时，value 直接作为新根。
//   - 沿途对象/数组做结构共享克隆，其余分支保持原引用；中间容器缺失时补建
//     （该段像数字下标就补数组，否则补对象）。
//   - append/prepend 的目标不是数组（含缺失）→ 返回 null。
//   - del 删不存在的 key 是空操作，仍返回合法 state。
//   - op 名未知、path 不是字符串（或含空段）、items 不是数组、ops 不是数组 → 返回 null。
//   - apply(state, []) 原样返回 state。
//
// isApplicable 是断档检测：patch.baseRev 必须等于消费端本地 rev，否则要补全量。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GameStatePatch = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_OPS = 500;
  var MAX_ARRAY_ITEMS = 200;
  var INDEX_RE = /^\d+$/;

  function isPlainObject(value) {
    return !!value && typeof value === 'object' &&
      Object.prototype.toString.call(value) === '[object Object]';
  }

  function isSafeKey(key) {
    return key.length > 0 && key.indexOf('.') === -1 && key.indexOf('\\') === -1;
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function shallowCopy(obj) {
    var copy = {};
    for (var key in obj) {
      if (hasOwn(obj, key)) copy[key] = obj[key];
    }
    return copy;
  }

  // 深度相等：数组按元素顺序比，普通对象按 key 集合比，其余用 ===
  function deepEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    var aIsArray = Array.isArray(a);
    if (aIsArray !== Array.isArray(b)) return false;
    if (aIsArray) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) {
        if (!deepEqual(a[i], b[i])) return false;
      }
      return true;
    }
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    var keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (var j = 0; j < keys.length; j++) {
      if (!hasOwn(b, keys[j])) return false;
      if (!deepEqual(a[keys[j]], b[keys[j]])) return false;
    }
    return true;
  }

  // prev 是否等于 next 的前 count 项
  function matchesPrefix(prev, next, count) {
    for (var i = 0; i < count; i++) {
      if (!deepEqual(prev[i], next[i])) return false;
    }
    return true;
  }

  // prev 是否等于 next 的后 count 项
  function matchesSuffix(prev, next, count) {
    var offset = next.length - count;
    for (var i = 0; i < count; i++) {
      if (!deepEqual(prev[i], next[offset + i])) return false;
    }
    return true;
  }

  function joinPath(prefix, key) {
    return prefix ? prefix + '.' + key : key;
  }

  // 把 prev/next 的差异写进 ops；超出 MAX_OPS 时返回 false 让调用方回退全量
  function diffCore(prev, next, path, ops) {
    if (ops.length >= MAX_OPS) return false;
    if (prev === next) return true;

    if (Array.isArray(prev) && Array.isArray(next)) {
      if (prev.length === 0) {
        ops.push({ op: 'set', path: path, value: next });
        return true;
      }
      if (prev.length <= next.length && matchesPrefix(prev, next, prev.length)) {
        var added = next.slice(prev.length);
        if (added.length > 0) {
          if (added.length <= MAX_ARRAY_ITEMS) {
            ops.push({ op: 'append', path: path, items: added });
            return true;
          }
          ops.push({ op: 'set', path: path, value: next });
          return true;
        }
      } else if (prev.length < next.length && matchesSuffix(prev, next, prev.length)) {
        var head = next.slice(0, next.length - prev.length);
        if (head.length <= MAX_ARRAY_ITEMS) {
          ops.push({ op: 'prepend', path: path, items: head });
          return true;
        }
      }
      ops.push({ op: 'set', path: path, value: next });
      return true;
    }

    if (isPlainObject(prev) && isPlainObject(next)) {
      var keys = Object.keys(prev);
      for (var i = 0; i < keys.length; i++) {
        if (!hasOwn(next, keys[i])) {
          // 不可寻址的 key（含点/反斜杠/空串）：无法发 del，只能整份替换父对象
          if (!isSafeKey(keys[i])) {
            ops.push({ op: 'set', path: path, value: next });
            return true;
          }
          ops.push({ op: 'del', path: joinPath(path, keys[i]) });
          if (ops.length >= MAX_OPS) return false;
        }
      }
      var nextKeys = Object.keys(next);
      for (var j = 0; j < nextKeys.length; j++) {
        var key = nextKeys[j];
        var value = next[key];
        var differs = value === undefined
          ? hasOwn(prev, key)
          : (!hasOwn(prev, key) || !deepEqual(prev[key], value));
        // 不可寻址的 key 只要有变化（新增/删除/改值）就整份替换父对象；
        // 根层 path 为 ''，等价于整份替换（apply 对 path '' 直接换根）
        if (differs && !isSafeKey(key)) {
          ops.push({ op: 'set', path: path, value: next });
          return true;
        }
        if (value === undefined) {
          if (hasOwn(prev, key)) ops.push({ op: 'del', path: joinPath(path, key) });
        } else if (!hasOwn(prev, key)) {
          ops.push({ op: 'set', path: joinPath(path, key), value: value });
        } else if (!deepEqual(prev[key], value)) {
          if (!diffCore(prev[key], value, joinPath(path, key), ops)) return false;
        }
        if (ops.length >= MAX_OPS) return false;
      }
      return true;
    }

    ops.push({ op: 'set', path: path, value: next });
    return true;
  }

  // 解析 path：'' → []（根）；含空段（a..b）或非字符串 → null（坏 op）
  function splitPath(path) {
    if (typeof path !== 'string') return null;
    if (path === '') return [];
    var parts = path.split('.');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) return null;
    }
    return parts;
  }

  // 在 path 上写入 value，沿途克隆（结构共享），未触及的分支保持原引用
  function setAt(node, parts, value) {
    if (parts.length === 0) return value;
    var head = parts[0];
    var rest = parts.slice(1);
    var base;
    if (Array.isArray(node)) base = node.slice();
    else if (isPlainObject(node)) base = shallowCopy(node);
    // 容器缺失时补建：head 像数字下标就补数组，否则补对象
    else base = INDEX_RE.test(head) ? [] : {};
    base[head] = setAt(base[head], rest, value);
    return base;
  }

  // 删除 path 末端；末端 key 不存在时是空操作（仍返回克隆后的结构）
  function deleteAt(node, parts) {
    if (parts.length === 0 || node == null || typeof node !== 'object') return node;
    var head = parts[0];
    var rest = parts.slice(1);
    if (Array.isArray(node)) {
      if (!INDEX_RE.test(head)) return node;
      var arr = node.slice();
      var index = Number(head);
      if (rest.length > 0) arr[index] = deleteAt(arr[index], rest);
      else if (index >= 0 && index < arr.length) arr.splice(index, 1);
      return arr;
    }
    if (!isPlainObject(node)) return node;
    if (rest.length === 0) {
      if (!hasOwn(node, head)) return node;
      var copy = shallowCopy(node);
      delete copy[head];
      return copy;
    }
    if (!hasOwn(node, head)) return node;
    var nextCopy = shallowCopy(node);
    nextCopy[head] = deleteAt(node[head], rest);
    return nextCopy;
  }

  // 取 path 上的容器节点（用于 append/prepend）；缺失或类型不对返回 undefined
  function getAt(node, parts) {
    var cur = node;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  // 单个 op 回放；坏 op 返回 undefined（调用方据此整体返回 null）
  function applyOp(state, op) {
    if (!isPlainObject(op)) return undefined;
    var parts = splitPath(op.path);
    if (parts === null) return undefined;
    if (op.op === 'set') {
      return setAt(state, parts, op.value);
    }
    if (op.op === 'del') {
      return deleteAt(state, parts);
    }
    if (op.op === 'append' || op.op === 'prepend') {
      if (!Array.isArray(op.items)) return undefined;
      var target = getAt(state, parts);
      if (!Array.isArray(target)) return undefined;
      var items = op.op === 'append' ? target.concat(op.items) : op.items.concat(target);
      return setAt(state, parts, items);
    }
    return undefined;
  }

  // 计算 prev → next 的增量 ops；无变化返回 []
  function diff(prev, next) {
    var ops = [];
    if (prev === next) return ops;
    if (!diffCore(prev, next, '', ops)) {
      return [{ op: 'set', path: '', value: next }];
    }
    return ops;
  }

  // 回放 ops 得到新 state；任何坏 op 都返回 null（调用方应补全量）
  function apply(state, ops) {
    if (!Array.isArray(ops)) return null;
    var result = state;
    for (var i = 0; i < ops.length; i++) {
      var next = applyOp(result, ops[i]);
      if (next === undefined) return null;
      result = next;
    }
    return result;
  }

  // 断档检测：patch 必须建立在本地 rev 之上
  function isApplicable(localRev, patch) {
    if (!patch || typeof patch !== 'object') return false;
    if (typeof localRev !== 'number' || !isFinite(localRev)) return false;
    return patch.baseRev === localRev;
  }

  return {
    diff: diff,
    apply: apply,
    isApplicable: isApplicable,
    MAX_OPS: MAX_OPS,
    MAX_ARRAY_ITEMS: MAX_ARRAY_ITEMS,
  };
});
