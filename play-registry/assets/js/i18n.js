/* play-registry 站点中英。跟随浏览器语言，可手动切换，记在 localStorage。 */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'site-locale';
  var M = {
    zh: {
      brand: '硅基之下游戏库',
      navGames: '游戏',
      navControl: '设备控制',
      navDocs: '开发文档',
      navDeviceApi: 'DeviceAPI',
      navContribute: '投稿',
      footerNote: '硅基之下游戏库 · UnderSilicon 控制面板 · 内容随仓库 main 分支自动发布',
      footerNoteGames: 'UnderSilicon 控制面板 · 远程玩法仓库 · 内容随仓库 main 分支自动发布',
      footerNoteControl: 'UnderSilicon 控制面板 · 设备控制中心 · 内容随仓库 main 分支自动发布',
      footerDevices: '设备清单',
      homeTitle: '硅基之下游戏库 · UnderSilicon 控制面板',
      homeDesc: '硅基之下游戏库：控制面板的在线游戏站。游戏经面板 gameProxy 同源加载、连本机 Bridge 驱动真实设备，改站即上新，无需重发 App。',
      homeEyebrow: '硅基之下 · 在线游戏站',
      homeH1Before: '硅基之下',
      homeH1Grad: '游戏库',
      homeLead: '连接你的真实设备，在浏览器里直接玩。每个游戏都是自包含网页，经控制面板同源加载、驱动本机硬件——上新即玩，无需更新 App。',
      browseGames: '浏览游戏 →',
      makeGame: '我要做一个游戏',
      statGames: '在线游戏',
      statDevices: '支持设备类型',
      statCaps: '设备能力',
      promptTitleBefore: '🤖 想做一个自己的游戏？把这段 ',
      promptTitleAfter: ' 丢给 Claude Code / Codex',
      copyPrompt: '复制 Prompt',
      copied: '✓ 已复制',
      promptHint: '改完这段描述发给 AI，它会照着规范帮你写出可上架的游戏。完整说明见 Agent 开发指南。',
      contributeEyebrow: '玩家投稿计划',
      contributeH2: '把你的脑洞做成游戏，投稿送硬件 + Token 套餐',
      contributeLead: '不用从零学写代码——clone 仓库后，用上面的 Prompt 让 AI 参考现有游戏改出你的玩法。通过审核上架后，玩家在控制面板里直接看到、直接玩。',
      tier1Name: 'AI 辅助开发',
      tier1Desc: '复制首页 Prompt，让 Claude Code / Codex 对照现有游戏实现',
      tier2Name: '提交 PR 上架',
      tier2Desc: '把新游戏目录发 PR 到 main，合并后自动发布',
      tier3Name: '投稿奖励',
      tier3Desc: '通过审核上架后送硬件 + Token 套餐，具体咨询客服',
      viewContribute: '查看投稿指南 →',
      agentGuide: 'Agent 开发指南',
      qrAlt: '微信客服二维码',
      qrLabel: '扫码加客服微信',
      qrSub: '投稿审核 · 套餐咨询 · 技术答疑',
      gamesTitle: '玩法列表 · UnderSilicon 控制面板',
      gamesH2: '玩法列表',
      gamesLead: '从 registry.json 实时拉取。点击「启动玩法」需先安装控制面板并完成设备映射。',
      gamesStat: '在线玩法',
      searchGames: '搜索玩法标题、描述、id…',
      modalPlay: '玩法',
      close: '关闭',
      cancel: '取消',
      startPlay: '启动玩法 →',
      filterAll: '全部',
      required: '必需',
      optional: '可选',
      noDesc: '（无描述）',
      cache: '缓存',
      launch: '启动 →',
      noMatch: '没找到匹配的玩法',
      tryOther: '试试别的关键词或清空筛选',
      registryFail: '⚠ 无法加载 registry.json',
      registryHint: '站点可能尚未部署，或当前在离线环境。本地开发请先运行 npm run build 生成 registry.json。',
      probing: '正在探测本机控制面板…',
      connecting: '连接中…',
      needGrant: '需要授权后才能控制本机设备',
      grantHint: '点击下方按钮，并在控制面板弹窗中允许今天访问。',
      requestGrant: '申请授权',
      waitingGrant: '等待面板授权…',
      grantFail: '授权失败: {msg}',
      panelRunningUnauthorized: '面板已运行，本网站尚未授权',
      envNoGrant: '当前环境不支持授权',
      cannotGrant: '面板已运行，但本页无法申请授权',
      cannotGrantHint: '请在控制面板的内置浏览器中打开本站；或在面板「网络配置 → 开发者：外部本地游戏放行」中开启开发者模式后重试。',
      retryDetect: '重新探测',
      noPanel: '未找到本机控制面板',
      noPanelHint: '未在 127.0.0.1 探测到控制面板后端',
      noPanelHint2: '请先启动控制面板（Electron 桌面端或后端服务），让本机 5278 端口可用后重试。',
      connectedLoading: '已连接 {base} · 加载设备中…',
      loadDevicesFail: '加载设备失败: {msg}',
      cannotReadDevices: '无法从控制面板读取设备列表。',
      noOnline: '{base} · 当前无在线设备',
      onlineCount: '{base} · {n} 个在线设备',
      deviceMap: '设备映射',
      caps: '能力: {caps}',
      none: '（无）',
      noMatchDevice: '无匹配设备',
      noMapNeeded: '此玩法不需要设备映射。',
      params: '参数',
      mapHint: '提示：可选设备不映射也能运行；必需设备必须选择。运行中可在控制栏「重选设备」。',
      needMap: '需映射: {ids}',
      caching: '正在缓存游戏本体…',
      cachedLaunch: '已使用本地缓存启动',
      cacheFallback: '缓存失败，改用在线加载: {msg}',
      starting: '启动中…',
      envNoLaunch: '当前环境不支持启动',
      launchingNamed: '正在启动「{title}」…',
      launchAccepted: '已受理，正在打开配置页…',
      launchFail: '启动失败：{msg}',
      cacheInApp: '请在客户端/App 内使用缓存功能',
      cachingNamed: '正在缓存「{title}」…',
      cachedNamed: '已缓存「{title}」',
      cacheFail: '缓存失败：{msg}',
      noManifest: '游戏页无 game-manifest',
      controlTitle: '设备控制中心 · 玩法库',
      controlEyebrow: '设备全局控制中心 · 控制面板授权访问',
      controlH1: '设备控制中心',
      controlLead: '在控制面板内置浏览器中打开此页后，通过授权过的 DeviceAPI 集中查看所有已连接设备，并调整每台设备的全部参数。未授权前，此页不会直接访问本机控制接口。',
      probingPanel: '正在探测本机控制面板…',
      revokeGrant: '撤销授权',
      refresh: '刷新',
      recheck: '重新检查',
      estop: '⚠ 全部停止 / 归零',
      checkingAuth: '当前正在检查网页授权状态…',
      searchDevices: '搜索设备 id、名称、类型…',
      playTitle: '运行玩法 · 玩法库',
      playDefault: '玩法',
      back: '← 返回',
      loading: '加载中',
      reselect: '重选设备',
      stop: '停止',
      loadingPlay: '正在加载玩法…',
      cannotLoad: '⚠ 无法加载玩法',
      needPanel: '需本机控制面板在线，且玩法经面板 gameProxy 加载。',
      backLibrary: '返回玩法库',
      missingLaunch: '缺少 launch 参数',
      iframeFail: 'iframe 加载失败',
      devicesOnline: '{n} 设备在线',
      noOnlineShort: '无在线设备',
      panelOffline: '面板离线',
      online: '在线',
      offline: '离线',
      neverReported: '从未上报',
      justNow: '刚刚',
      minutesAgo: '{n} 分钟前',
      hoursAgo: '{n} 小时前',
      capStrength: '强度',
      capShock: '电击',
      capLock: '锁',
      capReporting: '上报频率',
      capDistance: '距离阈值',
      zero: '归零',
      voltage: '电压',
      startShock: '开始电击',
      stopShock: '停止电击',
      unlock: '解锁',
      lock: '加锁',
      reportInterval: '上报间隔',
      nearBand: '近带',
      farBand: '远带',
      unauthorized: '当前网页尚未获得设备控制授权',
      pageUnauthorized: '当前页面未授权。 请点击“申请授权”，并在控制面板弹窗中允许今天访问。',
      needPanelAuth: '需要先在控制面板内授权',
      afterAuth: '授权后，此页才会列出设备并允许下发控制指令。',
      noDeviceApi: '当前环境不支持 DeviceAPI',
      notInPanel: '当前页面不在控制面板内置浏览器中。 请在 Electron 控制面板的浏览器页打开此地址。',
      needInPanel: '此页面需要在控制面板内打开',
      noDeviceApiHint: '普通浏览器不会注入 DeviceAPI，因此不能直接控制设备。',
      requestingAuth: '正在请求控制面板授权…',
      accessGranted: '设备访问已授权',
      authFail: '授权失败：{msg}',
      revoked: '已撤销当前网页授权',
      revokeFail: '撤销授权失败：{msg}',
      sessionStopped: '已停止当前网页设备会话',
      stopFail: '停止会话失败：{msg}',
      checkingPageAuth: '正在检查当前网页授权状态…',
      grantedLoading: '已授权 · 正在加载设备…',
      grantedNote: '当前页面已获授权。 设备控制将通过控制面板转发，不直接访问本机浏览器接口。',
      grantedOnline: '已授权 · {online}/{total} 在线',
      loadFail: '加载设备失败：{msg}',
      loadFailNote: '设备列表加载失败。 {msg}',
      cannotReadList: '无法读取设备列表',
      refreshFail: '设备列表刷新失败，重试中…',
      noDevices: '当前没有任何设备',
      connectFirst: '请先在控制面板中连接真实设备或创建虚拟设备。',
      paramControl: '参数控制',
      noParams: '该设备类型无可调参数（纯上行传感器）',
      battery: '电量 {n}',
      liveData: '实时读数',
      quickOps: '快捷操作',
      stopZero: '停止 / 归零',
      rawData: '原始数据',
      apply: '应用',
      suggestSafe: '建议 ≤ {n}V',
      applyConfig: '应用配置',
      cannotControl: '当前环境无法控制设备',
      sentOk: '{name} · {action} 已下发',
      actionFail: '{name} 失败：{msg}',
      cannotOp: '当前环境无法执行快捷操作',
      opSent: '操作 {op} 已下发',
      opFail: '操作失败：{msg}',
      enterNumber: '请输入有效数值',
      overSafe: '{name} 电压 {v}V 超过建议安全值 {max}V，确认继续？',
      noStopAction: '该设备无停止动作',
      stoppedOk: '{name} 已停止 / 归零',
      notGranted: '当前网页尚未授权',
      noOnlineDevices: '没有在线设备',
      confirmEstop: '将对 {n} 个在线设备下发停止 / 归零，确认？',
      estopSent: '已向 {n} 个设备下发停止指令',
      docsNav: '开发文档',
      docsStart: '快速开始',
      docsAgent: 'Agent 开发指南',
      docsApi: 'DeviceAPI 参考',
      docsDevices: '设备与能力',
      docsContribute: '投稿与奖励',
    },
    en: {
      brand: 'UnderSilicon Games',
      navGames: 'Games',
      navControl: 'Devices',
      navDocs: 'Docs',
      navDeviceApi: 'DeviceAPI',
      navContribute: 'Submit',
      footerNote: 'UnderSilicon Games · control panel · published from the main branch',
      footerNoteGames: 'UnderSilicon control panel · remote play registry · published from the main branch',
      footerNoteControl: 'UnderSilicon control panel · device console · published from the main branch',
      footerDevices: 'Device list',
      homeTitle: 'UnderSilicon Games · control panel',
      homeDesc: 'Online games for the UnderSilicon control panel. Games load through the panel gameProxy and drive real devices over the local Bridge.',
      homeEyebrow: 'UnderSilicon · online games',
      homeH1Before: 'UnderSilicon',
      homeH1Grad: 'Games',
      homeLead: 'Play in the browser with your real devices. Each game is a self-contained page, loaded by the control panel and talking to local hardware. New games appear without an app update.',
      browseGames: 'Browse games →',
      makeGame: 'Make a game',
      statGames: 'Online games',
      statDevices: 'Device types',
      statCaps: 'Capabilities',
      promptTitleBefore: '🤖 Want to make a game? Drop this ',
      promptTitleAfter: ' into Claude Code / Codex',
      copyPrompt: 'Copy prompt',
      copied: '✓ Copied',
      promptHint: 'Edit the description and send it to an AI. Full notes are in the Agent guide.',
      contributeEyebrow: 'Player submissions',
      contributeH2: 'Ship your idea. Approved games get hardware + Token packs',
      contributeLead: 'You do not need to start from a blank project. Clone the repo, use the prompt above, and let an AI adapt an existing game. After review, players see it in the control panel.',
      tier1Name: 'AI-assisted build',
      tier1Desc: 'Copy the home prompt and let Claude Code / Codex follow an existing game',
      tier2Name: 'Open a PR',
      tier2Desc: 'Send the new game folder to main. Merge publishes it',
      tier3Name: 'Rewards',
      tier3Desc: 'Approved listings get hardware + Token packs. Ask support for details',
      viewContribute: 'Submission guide →',
      agentGuide: 'Agent guide',
      qrAlt: 'WeChat support QR',
      qrLabel: 'Scan to add WeChat support',
      qrSub: 'Review · packs · tech help',
      gamesTitle: 'Games · UnderSilicon control panel',
      gamesH2: 'Games',
      gamesLead: 'Live from registry.json. Starting a play requires the control panel and device mapping.',
      gamesStat: 'Online plays',
      searchGames: 'Search title, description, id…',
      modalPlay: 'Play',
      close: 'Close',
      cancel: 'Cancel',
      startPlay: 'Start →',
      filterAll: 'All',
      required: 'Required',
      optional: 'Optional',
      noDesc: '(no description)',
      cache: 'Cache',
      launch: 'Start →',
      noMatch: 'No matching plays',
      tryOther: 'Try another keyword or clear filters',
      registryFail: '⚠ Could not load registry.json',
      registryHint: 'The site may be unpublished or offline. For local dev, run npm run build first.',
      probing: 'Looking for the local control panel…',
      connecting: 'Connecting…',
      needGrant: 'Authorize this site to control local devices',
      grantHint: 'Use the button below, then allow access for today in the control panel dialog.',
      requestGrant: 'Request access',
      waitingGrant: 'Waiting for panel access…',
      grantFail: 'Access failed: {msg}',
      panelRunningUnauthorized: 'Panel is running, this site is not authorized',
      envNoGrant: 'This environment cannot request access',
      cannotGrant: 'The panel is running, but this page cannot request access',
      cannotGrantHint: 'Open this site in the control panel built-in browser, or enable developer local-game access in Network settings.',
      retryDetect: 'Retry',
      noPanel: 'Local control panel not found',
      noPanelHint: 'No control panel backend on 127.0.0.1',
      noPanelHint2: 'Start the control panel (Electron or backend) so port 5278 is available, then retry.',
      connectedLoading: 'Connected {base} · loading devices…',
      loadDevicesFail: 'Failed to load devices: {msg}',
      cannotReadDevices: 'Could not read the device list from the control panel.',
      noOnline: '{base} · no online devices',
      onlineCount: '{base} · {n} online',
      deviceMap: 'Device mapping',
      caps: 'Caps: {caps}',
      none: '(none)',
      noMatchDevice: 'No matching device',
      noMapNeeded: 'This play does not need device mapping.',
      params: 'Parameters',
      mapHint: 'Optional devices can stay unmapped. Required devices must be selected. You can remap from the play bar.',
      needMap: 'Need: {ids}',
      caching: 'Caching the game package…',
      cachedLaunch: 'Starting from local cache',
      cacheFallback: 'Cache failed, loading online: {msg}',
      starting: 'Starting…',
      envNoLaunch: 'This environment cannot start plays',
      launchingNamed: 'Starting “{title}”…',
      launchAccepted: 'Accepted, opening the config page…',
      launchFail: 'Start failed: {msg}',
      cacheInApp: 'Use cache inside the client/app',
      cachingNamed: 'Caching “{title}”…',
      cachedNamed: 'Cached “{title}”',
      cacheFail: 'Cache failed: {msg}',
      noManifest: 'Game page has no game-manifest',
      controlTitle: 'Device console · play library',
      controlEyebrow: 'Global device console · control panel access',
      controlH1: 'Device console',
      controlLead: 'Open this page in the control panel browser. After access is granted, DeviceAPI lists connected devices and lets you change their parameters. This page does not talk to local control APIs before authorization.',
      probingPanel: 'Looking for the local control panel…',
      revokeGrant: 'Revoke access',
      refresh: 'Refresh',
      recheck: 'Recheck',
      estop: '⚠ Stop all / zero',
      checkingAuth: 'Checking page access…',
      searchDevices: 'Search device id, name, type…',
      playTitle: 'Running play · library',
      playDefault: 'Play',
      back: '← Back',
      loading: 'Loading',
      reselect: 'Remap devices',
      stop: 'Stop',
      loadingPlay: 'Loading play…',
      cannotLoad: '⚠ Could not load the play',
      needPanel: 'The local control panel must be online, and the play must load through gameProxy.',
      backLibrary: 'Back to library',
      missingLaunch: 'Missing launch parameter',
      iframeFail: 'iframe failed to load',
      devicesOnline: '{n} devices online',
      noOnlineShort: 'No online devices',
      panelOffline: 'Panel offline',
      online: 'Online',
      offline: 'Offline',
      neverReported: 'Never reported',
      justNow: 'Just now',
      minutesAgo: '{n} min ago',
      hoursAgo: '{n} h ago',
      capStrength: 'Intensity',
      capShock: 'Shock',
      capLock: 'Lock',
      capReporting: 'Report rate',
      capDistance: 'Distance bands',
      zero: 'Zero',
      voltage: 'Voltage',
      startShock: 'Start shock',
      stopShock: 'Stop shock',
      unlock: 'Unlock',
      lock: 'Lock',
      reportInterval: 'Report interval',
      nearBand: 'Near',
      farBand: 'Far',
      unauthorized: 'This page does not have device control access',
      pageUnauthorized: 'This page is not authorized. Request access, then allow today in the control panel dialog.',
      needPanelAuth: 'Authorize in the control panel first',
      afterAuth: 'After access is granted, this page can list devices and send commands.',
      noDeviceApi: 'This environment has no DeviceAPI',
      notInPanel: 'This page is not in the control panel browser. Open it from the Electron browser page.',
      needInPanel: 'Open this page inside the control panel',
      noDeviceApiHint: 'A normal browser does not inject DeviceAPI, so it cannot control devices.',
      requestingAuth: 'Requesting control panel access…',
      accessGranted: 'Device access granted',
      authFail: 'Access failed: {msg}',
      revoked: 'Page access revoked',
      revokeFail: 'Revoke failed: {msg}',
      sessionStopped: 'Stopped this page device session',
      stopFail: 'Stop failed: {msg}',
      checkingPageAuth: 'Checking page access…',
      grantedLoading: 'Authorized · loading devices…',
      grantedNote: 'This page is authorized. Device control is forwarded by the panel and does not use local browser APIs directly.',
      grantedOnline: 'Authorized · {online}/{total} online',
      loadFail: 'Failed to load devices: {msg}',
      loadFailNote: 'Device list failed. {msg}',
      cannotReadList: 'Could not read the device list',
      refreshFail: 'Device list refresh failed, retrying…',
      noDevices: 'No devices yet',
      connectFirst: 'Connect a real device or create a virtual device in the control panel first.',
      paramControl: 'Controls',
      noParams: 'This device type has no tunable parameters (sensor only)',
      battery: 'Battery {n}',
      liveData: 'Live data',
      quickOps: 'Quick ops',
      stopZero: 'Stop / zero',
      rawData: 'Raw data',
      apply: 'Apply',
      suggestSafe: 'Keep ≤ {n}V',
      applyConfig: 'Apply config',
      cannotControl: 'This environment cannot control devices',
      sentOk: '{name} · {action} sent',
      actionFail: '{name} failed: {msg}',
      cannotOp: 'This environment cannot run quick ops',
      opSent: 'Op {op} sent',
      opFail: 'Op failed: {msg}',
      enterNumber: 'Enter a valid number',
      overSafe: '{name} voltage {v}V is above the suggested {max}V. Continue?',
      noStopAction: 'This device has no stop action',
      stoppedOk: '{name} stopped / zeroed',
      notGranted: 'This page is not authorized',
      noOnlineDevices: 'No online devices',
      confirmEstop: 'Stop / zero {n} online devices?',
      estopSent: 'Stop sent to {n} devices',
      docsNav: 'Docs',
      docsStart: 'Getting started',
      docsAgent: 'Agent guide',
      docsApi: 'DeviceAPI',
      docsDevices: 'Devices & caps',
      docsContribute: 'Submit & rewards',
    },
  };

  function detect() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'en' || stored === 'zh') return stored;
    } catch (_) {}
    try {
      var lang = String((root.navigator && (navigator.language || navigator.userLanguage)) || '');
      return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    } catch (_) {}
    return 'zh';
  }

  var current = detect();

  function locale() { return current; }
  function isEn() { return current === 'en'; }

  function format(text, vars) {
    if (!vars) return text;
    return String(text).replace(/\{(\w+)\}/g, function (_, k) {
      return vars[k] == null ? '' : String(vars[k]);
    });
  }

  function t(key, vars) {
    var table = M[current] || M.zh;
    var text = table[key] || M.zh[key] || key;
    return format(text, vars);
  }

  function apply(rootEl) {
    var scope = rootEl || document;
    if (document.documentElement) document.documentElement.lang = current === 'en' ? 'en' : 'zh-CN';
    Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n]'), function (el) {
      var key = el.getAttribute('data-i18n');
      if (!key) return;
      el.textContent = t(key);
    });
    Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n-html]'), function (el) {
      var key = el.getAttribute('data-i18n-html');
      if (!key) return;
      el.innerHTML = t(key);
    });
    Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n-placeholder]'), function (el) {
      var key = el.getAttribute('data-i18n-placeholder');
      if (!key) return;
      el.setAttribute('placeholder', t(key));
    });
    Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n-title]'), function (el) {
      var key = el.getAttribute('data-i18n-title');
      if (!key) return;
      if (el.tagName === 'TITLE') document.title = t(key);
      else el.setAttribute('title', t(key));
    });
    Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n-aria]'), function (el) {
      var key = el.getAttribute('data-i18n-aria');
      if (!key) return;
      el.setAttribute('aria-label', t(key));
    });
    Array.prototype.forEach.call(scope.querySelectorAll('[data-i18n-alt]'), function (el) {
      var key = el.getAttribute('data-i18n-alt');
      if (!key) return;
      el.setAttribute('alt', t(key));
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-set-locale]'), function (btn) {
      var on = btn.getAttribute('data-set-locale') === current;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function setLocale(next) {
    current = next === 'en' ? 'en' : 'zh';
    try { localStorage.setItem(STORAGE_KEY, current); } catch (_) {}
    apply();
    try {
      document.dispatchEvent(new CustomEvent('site-locale-change', { detail: { locale: current } }));
    } catch (_) {}
  }

  function bind() {
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest && e.target.closest('[data-set-locale]');
      if (!btn) return;
      setLocale(btn.getAttribute('data-set-locale'));
    });
  }

  root.SiteI18n = { messages: M, locale: locale, isEn: isEn, t: t, apply: apply, setLocale: setLocale };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bind(); apply(); });
  } else {
    bind();
    apply();
  }
})(typeof window !== 'undefined' ? window : this);
