(function () {
  'use strict';

  var devices = [];
  var pollTimer = null;
  var lastSignature = null;
  var toastTimer = null;
  // 只补 monitorSpec 未定义的字段，宿主提供的设备专属名称和单位优先。
  var extraFields = {
    report_delay_ms: { name: '上报间隔', unit: 'ms' },
    voltage: { name: '电击电压' },
    shock: { name: '电击状态' },
    power: { name: '电机强度' },
    strength: { name: '强度' },
    device_type: { name: '设备类型' },
    open: { name: '锁状态' },
    low_band: { name: '近阈值', unit: 'mm' },
    high_band: { name: '远阈值', unit: 'mm' }
  };

  function L() { return (typeof GameI18n !== 'undefined' && GameI18n.t) ? GameI18n.t : function (zh) { return zh; }; }
  function t(zh, vars) { return L()(zh, vars); }
  function byId(id) { return document.getElementById(id); }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }
  function connectionType(device) {
    return device.controlConnection || device.connectionType || 'unknown';
  }
  function connectionLabel(type) {
    return { mqtt: 'MQTT', serial: t('串口'), ble: 'BLE', remote: t('远程') }[type] || type;
  }
  function capabilities(device) {
    return Array.isArray(device.capabilities) ? device.capabilities : [];
  }
  function operations(device) {
    return Array.isArray(device.typeConfig && device.typeConfig.operations)
      ? device.typeConfig.operations : [];
  }
  function showToast(message, error) {
    var node = byId('toast');
    node.textContent = message;
    node.className = 'toast show' + (error ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.className = 'toast'; }, 2200);
  }

  function controlHtml(device) {
    var caps = capabilities(device);
    var rows = [];
    if (caps.indexOf('strength') >= 0) {
      rows.push('<div class="control-row"><span>' + t('强度') + '</span><input type="range" min="0" max="255" value="0" data-strength="' + escapeHtml(device.id) + '"><button class="btn primary" data-apply-strength="' + escapeHtml(device.id) + '">' + t('应用') + '</button></div>');
    }
    if (caps.indexOf('shock') >= 0) {
      rows.push('<div class="control-row"><span>' + t('电击电压') + '</span><input type="number" min="0" max="100" value="15" data-voltage="' + escapeHtml(device.id) + '"><span class="button-row"><button class="btn danger" data-shock-start="' + escapeHtml(device.id) + '">' + t('开始') + '</button><button class="btn" data-shock-stop="' + escapeHtml(device.id) + '">' + t('停止') + '</button></span></div>');
    }
    if (caps.indexOf('lock') >= 0) {
      rows.push('<div class="control-row"><span>' + t('设备锁') + '</span><span></span><span class="button-row"><button class="btn" data-lock="' + escapeHtml(device.id) + '">' + t('加锁') + '</button><button class="btn primary" data-unlock="' + escapeHtml(device.id) + '">' + t('解锁') + '</button></span></div>');
    }
    if (caps.indexOf('reporting') >= 0) {
      rows.push('<div class="control-row"><span>' + t('上报间隔') + '</span><input type="number" min="50" max="60000" step="50" value="500" data-report="' + escapeHtml(device.id) + '"><button class="btn primary" data-apply-report="' + escapeHtml(device.id) + '">' + t('应用') + '</button></div>');
    }
    if (caps.indexOf('distance') >= 0) {
      rows.push('<div class="control-row"><span>' + t('近距离阈值 (mm)') + '</span><input type="number" min="0" max="999999" value="20" data-distance-low="' + escapeHtml(device.id) + '"><span></span></div>');
      rows.push('<div class="control-row"><span>' + t('远距离阈值 (mm)') + '</span><input type="number" min="0" max="999999" value="80" data-distance-high="' + escapeHtml(device.id) + '"><button class="btn primary" data-apply-distance="' + escapeHtml(device.id) + '">' + t('应用') + '</button></div>');
    }
    var ops = operations(device);
    if (ops.length) {
      rows.push('<div class="button-row">' + ops.map(function (op) {
        return '<button class="btn" data-operation="' + escapeHtml(device.id) + '" data-operation-key="' + escapeHtml(op.key) + '">' + escapeHtml(op.name || op.key) + '</button>';
      }).join('') + '</div>');
    }
    return rows.length ? '<div class="section"><div class="section-title">' + t('控制') + '</div>' + rows.join('') + '</div>' : '';
  }

  function dataHtml(device) {
    var entries = Object.entries(device.data || {});
    if (!entries.length) return '';
    var fields = new Map();
    (device.monitorSpec || []).concat((device.typeConfig && device.typeConfig.monitorData) || []).forEach(function (field) {
      fields.set(field.key, field);
    });
    return '<div class="section"><div class="section-title">' + t('实时数据') + '</div><div class="data-grid">' + entries.map(function (entry) {
      var key = entry[0];
      var field = fields.get(key) || (Object.prototype.hasOwnProperty.call(extraFields, key) && extraFields[key]);
      var label = field ? t(field.name) + (field.unit ? ' · ' + t(field.unit) : '') : key;
      var value = typeof entry[1] === 'object' ? JSON.stringify(entry[1]) : entry[1];
      return '<div class="datum"><div class="datum-key">' + escapeHtml(label) + '</div><div class="datum-value" data-device="' + escapeHtml(device.id) + '" data-key="' + escapeHtml(key) + '">' + escapeHtml(value) + '</div></div>';
    }).join('') + '</div></div>';
  }

  function cardHtml(device) {
    var type = connectionType(device);
    return '<article class="device-card' + (device.connected ? '' : ' offline') + '" data-card="' + escapeHtml(device.id) + '">'
      + '<div class="device-head"><div><div class="device-name">' + escapeHtml(device.nickname || device.name || device.id) + '</div><div class="device-id">' + escapeHtml(device.id) + '</div></div>'
      + '<div class="tags"><span class="tag">' + escapeHtml(device.type) + '</span><span class="tag ' + (type === 'remote' ? 'remote' : '') + '">' + escapeHtml(connectionLabel(type)) + '</span></div></div>'
      + controlHtml(device) + dataHtml(device) + '</article>';
  }

  function render() {
    var online = devices.filter(function (device) { return device.connected; });
    byId('devices').innerHTML = online.map(cardHtml).join('');
    byId('empty').hidden = online.length > 0;
    byId('status').textContent = t('{n} 台在线').replace('{n}', online.length) + ' · ' + t('{n} 台远程').replace('{n}', online.filter(function (device) { return connectionType(device) === 'remote'; }).length);
    bindControls();
  }

  function updateLive() {
    devices.forEach(function (device) {
      Object.entries(device.data || {}).forEach(function (entry) {
        var selector = '[data-device="' + CSS.escape(device.id) + '"][data-key="' + CSS.escape(entry[0]) + '"]';
        var node = document.querySelector(selector);
        if (node) node.textContent = typeof entry[1] === 'object' ? JSON.stringify(entry[1]) : String(entry[1]);
      });
    });
  }

  function invoke(deviceId, capability, action, params, button) {
    if (button) button.disabled = true;
    return DeviceAPI.device(deviceId).invoke(capability, action, params || {}).then(function () {
      showToast(t('指令已发送'), false);
    }).catch(function (error) {
      showToast(error && error.message || String(error), true);
    }).finally(function () {
      if (button) button.disabled = false;
    });
  }

  function bindControls() {
    document.querySelectorAll('[data-apply-strength]').forEach(function (button) {
      button.onclick = function () {
        var id = button.dataset.applyStrength;
        var input = document.querySelector('[data-strength="' + CSS.escape(id) + '"]');
        invoke(id, 'strength', 'set', { value: Number(input.value) }, button);
      };
    });
    document.querySelectorAll('[data-shock-start]').forEach(function (button) {
      button.onclick = function () {
        var id = button.dataset.shockStart;
        var input = document.querySelector('[data-voltage="' + CSS.escape(id) + '"]');
        invoke(id, 'shock', 'start', { voltage: Number(input.value) }, button);
      };
    });
    document.querySelectorAll('[data-shock-stop]').forEach(function (button) {
      button.onclick = function () { invoke(button.dataset.shockStop, 'shock', 'stop', {}, button); };
    });
    document.querySelectorAll('[data-lock]').forEach(function (button) {
      button.onclick = function () { invoke(button.dataset.lock, 'lock', 'setOpen', { open: false }, button); };
    });
    document.querySelectorAll('[data-unlock]').forEach(function (button) {
      button.onclick = function () { invoke(button.dataset.unlock, 'lock', 'setOpen', { open: true }, button); };
    });
    document.querySelectorAll('[data-apply-report]').forEach(function (button) {
      button.onclick = function () {
        var id = button.dataset.applyReport;
        var input = document.querySelector('[data-report="' + CSS.escape(id) + '"]');
        invoke(id, 'reporting', 'setReportDelay', { ms: Number(input.value) }, button);
      };
    });
    document.querySelectorAll('[data-apply-distance]').forEach(function (button) {
      button.onclick = function () {
        var id = button.dataset.applyDistance;
        var low = document.querySelector('[data-distance-low="' + CSS.escape(id) + '"]');
        var high = document.querySelector('[data-distance-high="' + CSS.escape(id) + '"]');
        invoke(id, 'distance', 'configure', {
          lowBand: Number(low.value),
          highBand: Number(high.value),
        }, button);
      };
    });
    document.querySelectorAll('[data-operation]').forEach(function (button) {
      button.onclick = function () {
        button.disabled = true;
        DeviceAPI.device(button.dataset.operation).operate(button.dataset.operationKey, {})
          .catch(function (error) { showToast(error && error.message || String(error), true); })
          .finally(function () { button.disabled = false; });
      };
    });
  }

  function refresh() {
    return DeviceAPI.getDevices().then(function (next) {
      devices = Array.isArray(next) ? next : [];
      var signature = devices.map(function (device) {
        return [device.id, device.type, device.connected, connectionType(device), Object.keys(device.data || {}).sort().join(',')].join(':');
      }).sort().join('|');
      if (signature !== lastSignature) {
        lastSignature = signature;
        render();
      } else {
        updateLive();
      }
    }).catch(function (error) {
      byId('status').textContent = t('设备通道不可用');
      showToast(error && error.message || String(error), true);
    });
  }

  function stopDevice(device) {
    var caps = capabilities(device);
    var jobs = [];
    if (caps.indexOf('shock') >= 0) jobs.push(invoke(device.id, 'shock', 'stop', {}));
    if (caps.indexOf('strength') >= 0) jobs.push(invoke(device.id, 'strength', 'set', { value: 0 }));
    return Promise.allSettled(jobs);
  }

  async function boot() {
    try { await DeviceAPI.ready; } catch (_) {}
    byId('refresh').onclick = refresh;
    byId('stop-all').onclick = function () {
      var button = byId('stop-all');
      button.disabled = true;
      Promise.all(devices.filter(function (device) { return device.connected; }).map(stopDevice))
        .finally(function () { button.disabled = false; });
    };
    if (typeof GameI18n !== 'undefined' && GameI18n.apply) GameI18n.apply();
    await refresh();
    pollTimer = setInterval(refresh, 1000);
  }

  window.addEventListener('beforeunload', function () { if (pollTimer) clearInterval(pollTimer); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else void boot();
})();
