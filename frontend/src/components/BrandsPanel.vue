<template>
  <div class="brands-page">
    <el-card shadow="never" class="stats-card stats-card--compact">
      <div class="stats-row">
        <span class="stat-mini">设备 {{ totalCount }}</span>
        <span class="stat-mini online-stat">在线 {{ onlineCount }}</span>
        <span class="stat-mini offline-stat">离线 {{ offlineCount }}</span>
        <div class="stats-actions">
          <el-checkbox v-model="autoRefreshEnabled" @change="(v: any) => v ? startAutoRefresh() : stopAutoRefresh()">自动刷新</el-checkbox>
          <el-button size="small" :icon="Refresh" :loading="refreshing" @click="refreshConnected">刷新</el-button>
        </div>
      </div>
    </el-card>

    <el-tabs v-model="pageTab" class="brand-tabs">
      <el-tab-pane label="连接" name="connect">
        <el-card shadow="never" class="section-card">
          <div class="connect-bar">
            <el-dropdown trigger="click" @command="startBleConnect">
              <el-button type="primary" :loading="scanningWebble || scanningYcyWebble">
                蓝牙连接
                <el-icon class="el-icon--right"><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="ycy">役次元</el-dropdown-item>
                  <el-dropdown-item command="dglab">郊狼</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-dropdown trigger="click" @command="openMoreConnect">
              <el-button>
                更多连接方式
                <el-icon class="el-icon--right"><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="native">本机桥接</el-dropdown-item>
                  <el-dropdown-item command="dglab-phone">郊狼手机连接</el-dropdown-item>
                  <el-dropdown-item command="ycy-bridge">役次元远程桥接</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-button v-if="scanningWebble" size="small" @click="dglabWebbleCancelScan">取消郊狼扫描</el-button>
            <el-button v-if="scanningYcyWebble" size="small" @click="ycyWebbleCancelScan">取消役次元扫描</el-button>
          </div>
          <p class="op-hint">用电脑蓝牙直连设备。点「蓝牙连接」后选品牌，再在列表里挑设备。</p>
        </el-card>

        <div v-if="dglabWebbleCandidates.length || ycyWebbleCandidates.length" class="candidate-list">
          <div v-for="c in dglabWebbleCandidates" :key="'dg-'+c.id" class="candidate-item">
            <div class="candidate-info">
              <span class="candidate-name">{{ brandLabel('dglab', c.name) }}</span>
              <span class="candidate-meta">郊狼 · {{ c.name }}</span>
            </div>
            <el-button size="small" type="primary" @click="dglabWebblePick(c)">选择</el-button>
          </div>
          <div v-for="c in ycyWebbleCandidates" :key="'ycy-'+c.id" class="candidate-item">
            <div class="candidate-info">
              <span class="candidate-name">{{ brandLabel('ycy', c.name) }}</span>
              <span class="candidate-meta">役次元 · {{ c.name }}</span>
            </div>
            <el-button size="small" type="primary" @click="ycyWebblePick(c)">选择</el-button>
          </div>
        </div>

        <div class="brand-col__devices">
          <div v-if="!allConnected.length" class="brand-col__empty">还没有已连接设备。点「蓝牙连接」或「更多连接方式」添加，连上后可在这里试控。</div>
          <div v-for="dev in allConnected" :key="dev.deviceId" class="device-card">
            <div class="device-card__head">
              <div>
                <span class="device-card__name">{{ brandLabel(dev.brand, dev.name) }}</span>
                <el-tag size="small" class="tag-brand">{{ BRAND_LABEL[dev.brand] || dev.brand }}</el-tag>
                <el-tag v-if="dev.type" size="small" type="warning">{{ TYPE_LABEL[dev.type] || ycyPanelType(dev) }}</el-tag>
              </div>
              <el-button size="small" :icon="Close" @click="disconnectDevice(dev)">断开</el-button>
            </div>
            <div v-if="dev.brand === 'dglab'" class="control-grid">
              <div class="control-field">
                <label>强度 {{ ctl(dev).intensity }}</label>
                <el-slider v-model="ctl(dev).intensity" :min="0" :max="100" />
              </div>
              <div class="control-actions">
                <el-button type="primary" size="small" :loading="opLoading[`dglabApply:${dev.deviceId}`]" @click="dglabApply(dev)">应用</el-button>
                <el-button size="small" :loading="opLoading[`dglabStop:${dev.deviceId}`]" @click="dglabStop(dev)">停止</el-button>
              </div>
            </div>
            <div v-else-if="ycyPanelType(dev) === 'YCY_CUP'" class="control-grid">
              <div class="control-field"><label>旋转 {{ ctl(dev).stroke }}</label><el-slider v-model="ctl(dev).stroke" :min="0" :max="40" /></div>
              <div class="control-field"><label>震动 {{ ctl(dev).vibe }}</label><el-slider v-model="ctl(dev).vibe" :min="0" :max="20" /></div>
              <div class="control-field"><label>第三轴 {{ ctl(dev).axis }}</label><el-slider v-model="ctl(dev).axis" :min="0" :max="20" /></div>
              <div class="control-actions">
                <el-button type="primary" size="small" :loading="opLoading[`ycyFjb:${dev.deviceId}`]" @click="ycyFjbApply(dev)">应用</el-button>
                <el-button size="small" :loading="opLoading[`ycyStop:${dev.deviceId}`]" @click="ycyFjbStop(dev)">停止</el-button>
              </div>
            </div>
            <div v-else-if="ycyPanelType(dev) === 'YCY_EMS'" class="control-grid">
              <div class="control-field"><label>左通道 {{ ctl(dev).aStrength }}</label><el-slider v-model="ctl(dev).aStrength" :min="0" :max="100" /></div>
              <div class="control-field"><label>右通道 {{ ctl(dev).bStrength }}</label><el-slider v-model="ctl(dev).bStrength" :min="0" :max="100" /></div>
              <div class="control-actions">
                <el-button type="primary" size="small" :loading="opLoading[`ycyEms:${dev.deviceId}`]" @click="ycyEmsApply(dev)">应用</el-button>
                <el-button size="small" :loading="opLoading[`ycyStop:${dev.deviceId}`]" @click="ycyStop(dev)">停止</el-button>
              </div>
            </div>
            <div v-else-if="ycyPanelType(dev) === 'YCY_TOY'" class="control-grid">
              <div class="control-field"><label>速度 {{ ctl(dev).speed }}</label><el-slider v-model="ctl(dev).speed" :min="0" :max="100" /></div>
              <div class="control-actions">
                <el-button type="primary" size="small" :loading="opLoading[`ycyToy:${dev.deviceId}`]" @click="ycyToyApply(dev)">应用</el-button>
                <el-button size="small" :loading="opLoading[`ycyStop:${dev.deviceId}`]" @click="ycyStop(dev)">停止</el-button>
              </div>
            </div>
            <div v-else-if="ycyPanelType(dev) === 'YCY_ENEMA'" class="control-grid">
              <div class="control-actions">
                <el-button type="primary" size="small" :loading="opLoading[`ycyPump:${dev.deviceId}`]" @click="ycyPumpApply(dev)">启动泵</el-button>
                <el-button size="small" :loading="opLoading[`ycyPumpS:${dev.deviceId}`]" @click="ycyPumpStop(dev)">停止</el-button>
              </div>
            </div>
            <div v-else-if="dev.mode === 'bridge'" class="control-grid">
              <div class="control-field"><label>玩法编号</label><el-input v-model="ctl(dev).commandId" size="small" /></div>
              <div class="control-actions">
                <el-button type="primary" size="small" @click="ycyTrigger(dev)">触发</el-button>
                <el-button size="small" @click="ycyStop(dev)">停止</el-button>
              </div>
            </div>
          </div>
        </div>

      <section v-if="false" class="brand-col">
        <div class="brand-col__head">
          <h3 class="brand-col__name">郊狼</h3>
          <p class="brand-col__desc">蓝牙体感设备：连上本机即可查看电量与状态，可同时连接多台。</p>
        </div>

        <el-card shadow="never" class="section-card">
          <template #header>
            <div class="card-header">
              <span>发现与连接</span>
              <el-radio-group v-model="dglabMode" size="small" class="mode-switch">
                <el-radio-button value="native">本机桥接</el-radio-button>
                <el-radio-button value="webble">网页蓝牙</el-radio-button>
                <el-radio-button value="phone">手机连接</el-radio-button>
              </el-radio-group>
              <el-button size="small" type="primary" :icon="Plus" @click="openAdd('dglab')">添加设备</el-button>
            </div>
          </template>

          <!-- 本机通道：mac 可选本机桥接/网页蓝牙，其他平台走网页蓝牙；另有手机连接(远程 WebSocket) -->
          <template v-if="dglabMode === 'native' || dglabMode === 'webble'">
            <!-- 原生桥（macOS，Swift 桥，由 Electron 主进程监管（崩溃自启）） -->
            <template v-if="dglabMode === 'native'">
            <div class="discover-row">
              <el-tag :type="dglabNativeSummary.type" size="small" effect="light">{{ dglabNativeSummary.text }}</el-tag>
              <el-button type="primary" size="small" :loading="busy" :disabled="dglabNativeDevices.length === 0" @click="dglabNativeConnectAll">全部连接</el-button>
              <el-button size="small" :loading="busy" @click="dglabNativeRescan">重新扫描</el-button>
            </div>
            <p class="op-hint">本机已通过电脑蓝牙直接连接，开页即自动连上并自动显示电量；已连上的设备掉线会自动重连，可同时连多台。</p>
            <el-alert
              v-if="dglabNativeDevices.length === 0"
              class="hint"
              type="info"
              :closable="false"
              :title="dglabNativeBtHint"
            />
            <div v-else class="ycy-native-list">
              <el-card
                v-for="d in dglabNativeDevices"
                :key="d.id"
                shadow="hover"
                class="ycy-native-card"
                :class="{ 'ycy-native-card--ready': d.ready }"
              >
                <div class="ycy-native-card__head">
                  <el-icon v-if="d.ready" class="ycy-native-card__icon ycy-native-card__icon--ok"><CircleCheck /></el-icon>
                  <el-icon v-else class="ycy-native-card__icon ycy-native-card__icon--wait"><Loading /></el-icon>
                  <div class="ycy-native-card__title">
                    <div class="ycy-native-card__name">{{ brandLabel('dglab', d.name) }}</div>
                  </div>
                  <el-tag
                    :type="d.ready ? 'success' : dglabNativePending.includes(d.id) ? 'warning' : 'info'"
                    size="small"
                    effect="light"
                  >{{ d.ready ? '已连接' : dglabNativePending.includes(d.id) ? '连接中' : '待连接' }}</el-tag>
                </div>
                <el-descriptions v-if="d.ready" :column="1" border size="small" class="ycy-native-card__meta">
                  <el-descriptions-item label="电量">{{ d.battery == null ? '—' : d.battery + '%' }}</el-descriptions-item>
                </el-descriptions>
                <div class="ycy-native-card__actions">
                  <el-button v-if="d.ready" type="danger" plain size="small" :loading="busy" @click="dglabNativeDisconnect(d)">断开连接</el-button>
                  <el-button v-else type="primary" size="small" :loading="busy" @click="dglabNativeConnect(d)">连接设备</el-button>
                </div>
              </el-card>
            </div>

            <!-- 排查：显示全部附近设备（含未命名），确认“为什么只看到 N 台” -->
            <div class="diag">
              <div class="discover-row" style="margin-top: 8px">
                <el-button size="small" text bg @click="dglabShowAll = !dglabShowAll">{{ dglabShowAll ? '收起全部列表' : '排查：显示全部附近设备' }}</el-button>
                <span class="op-hint" style="margin: 0">桥共扫到 {{ dglabAllDevices.length }} 台附近蓝牙设备，其中已识别郊狼 {{ dglabNativeDevices.length }} 台；其余多为手机/家电等无关设备，或广播无名字的未命名设备。</span>
              </div>
              <div v-if="dglabShowAll" class="diag-list">
                <div v-for="d in dglabAllDevices" :key="d.id" class="diag-item" :class="{ 'diag-item--matched': DGLAB_RE.test(d.name || '') }">
                  <span class="diag-name">{{ d.name || '未命名设备' }}</span>
                  <span class="diag-meta">{{ d.name ? '' : (d.id.slice(0, 8) + ' · ') }}RSSI {{ d.rssi }}</span>
                  <el-tag v-if="DGLAB_RE.test(d.name || '')" type="success" size="small" effect="plain">已识别</el-tag>
                  <el-tag v-else type="info" size="small" effect="plain">未识别</el-tag>
                  <el-tag :type="d.ready ? 'success' : 'info'" size="small">{{ d.ready ? '已连' : '待连' }}</el-tag>
                  <el-button v-if="!d.ready" size="small" type="primary" plain :loading="busy" @click="dglabNativeConnect(d)">连接</el-button>
                  <el-button v-else size="small" plain :loading="busy" @click="dglabNativeDisconnect(d)">断开</el-button>
                </div>
              </div>
            </div>
            </template>

            <!-- 浏览器直连（网页蓝牙 Web Bluetooth，非 macOS 自动选用） -->
            <template v-else-if="dglabMode === 'webble'">
              <div class="discover-row">
                <el-tag :type="dglabWebbleHint.type" size="small" effect="light">{{ dglabWebbleHint.text }}</el-tag>
                <el-button type="primary" size="small" :loading="scanningWebble" :disabled="!webbleSupported" @click="dglabWebbleConnect">连接设备</el-button>
                <el-button v-if="scanningWebble" size="small" @click="dglabWebbleCancelScan">取消</el-button>
              </div>
              <div v-if="dglabWebbleCandidates.length" class="candidate-list">
                <div v-for="c in dglabWebbleCandidates" :key="c.id" class="candidate-item">
                  <div class="candidate-info">
                    <span class="candidate-name">{{ brandLabel('dglab', c.name) }}</span>
                    <span class="candidate-meta">{{ c.name }}</span>
                  </div>
                  <el-button size="small" type="primary" @click="dglabWebblePick(c)">选择</el-button>
                </div>
              </div>
            <p class="op-hint">浏览器通过电脑蓝牙直接连接郊狼：点“连接设备”后在系统蓝牙选择器里挑选即可，连上自动显示电量，可同时连多台。需使用 Chrome / Edge 等支持网页蓝牙的浏览器，且页面须通过 https 或本机 localhost 打开。</p>
            <el-alert
              v-if="!webbleSupported"
              class="hint"
              type="warning"
              :closable="false"
              title="当前浏览器不支持网页蓝牙直连，请改用“手机连接”，或用 Chrome / Edge 打开本页。"
            />
            <el-alert
              v-else-if="dglabWebbleDevices.length === 0"
              class="hint"
              type="info"
              :closable="false"
              title="点击“连接设备”以选择并连接附近的郊狼设备（2.0 / 3.0 均可）。"
            />
            <div v-else class="ycy-native-list">
              <el-card
                v-for="d in dglabWebbleDevices"
                :key="d.id"
                shadow="hover"
                class="ycy-native-card"
                :class="{ 'ycy-native-card--ready': d.ready }"
              >
                <div class="ycy-native-card__head">
                  <el-icon class="ycy-native-card__icon ycy-native-card__icon--ok"><CircleCheck /></el-icon>
                  <div class="ycy-native-card__title">
                    <div class="ycy-native-card__name">{{ brandLabel('dglab', d.name) }}</div>
                  </div>
                  <el-tag type="success" size="small" effect="light">已连接</el-tag>
                </div>
                <el-descriptions :column="1" border size="small" class="ycy-native-card__meta">
                  <el-descriptions-item label="电量">{{ d.battery == null ? '—' : d.battery + '%' }}</el-descriptions-item>
                </el-descriptions>
                <div class="control-grid">
                  <div class="control-field">
                    <label>强度 {{ webbleCtl(d.id).intensity ?? 60 }}</label>
                    <el-slider v-model="webbleCtl(d.id).intensity" :min="0" :max="100" />
                  </div>
                  <div class="control-actions">
                    <el-button type="primary" size="small" :loading="opLoading[`dglabW:${d.id}`]" @click="dglabWebbleApply(d)">应用</el-button>
                    <el-button size="small" :loading="opLoading[`dglabWS:${d.id}`]" @click="dglabWebbleStop(d)">停止</el-button>
                  </div>
                </div>
                <div class="ycy-native-card__actions">
                  <el-button type="danger" plain size="small" :loading="busy" @click="dglabWebbleDisconnect(d)">断开连接</el-button>
                </div>
              </el-card>
            </div>
            </template>
          </template>

          <!-- 手机连接（娱乐模式） -->
          <template v-else>
            <div class="discover-row">
              <el-input v-model="dglabHost" placeholder="手机上显示的地址" class="addr-input" />
              <el-input v-model="dglabPort" placeholder="端口" class="port-input" />
              <el-button type="primary" :loading="scanningDglab" @click="discoverDglab">探测</el-button>
            </div>
            <p class="op-hint">手机连接：在配套手机软件里打开“娱乐模式”，屏幕上会显示本机地址和端口，填好后点“探测”即可发现设备。可逐台连接，支持多台同时在线。</p>
            <div v-if="dglabCandidates.length" class="candidate-list">
              <div v-for="c in dglabCandidates" :key="c.suggestedDeviceId" class="candidate-item">
                <div class="candidate-info">
                  <span class="candidate-name">{{ brandLabel('dglab', c.suggestedName) }}</span>
                  <span class="candidate-meta">{{ c.host }}:{{ c.port }}
                    <el-tag v-if="c.reachable" type="success" size="small">可达</el-tag>
                    <el-tag v-else type="danger" size="small">不可达</el-tag>
                  </span>
                </div>
                <el-button size="small" type="primary" :disabled="!c.reachable || busy" @click="connectDglab(c)">连接</el-button>
              </div>
            </div>
          </template>
        </el-card>

        <!-- 已连接的郊狼设备（手机连接） -->
        <div class="brand-col__devices">
          <div v-if="!dglabConnected.length" class="brand-col__empty">还没有连接中的郊狼设备，连上后可在这里试控</div>

          <div v-for="dev in dglabConnected" :key="dev.deviceId" class="device-card">
            <div class="device-card__head">
              <div>
                <span class="device-card__name">{{ brandLabel('dglab', dev.name) }}</span>
                <el-tag size="small" class="tag-brand">郊狼</el-tag>
                <el-tag size="small" type="info">手机连接</el-tag>
              </div>
              <el-button size="small" :icon="Close" @click="disconnectDevice(dev)">断开</el-button>
            </div>

            <!-- 手机连接 控制 -->
            <div class="control-grid">
              <div class="control-field">
                <label>波形</label>
                <el-select v-model="ctl(dev).pattern" size="small" class="control-input">
                  <el-option v-for="p in dglabPatterns" :key="p" :label="p" :value="p" />
                </el-select>
                <span class="op-hint">选择电击节奏的样子，例如经典、心跳、潮汐</span>
              </div>
              <div class="control-field">
                <label>强度 {{ ctl(dev).intensity }}</label>
                <el-slider v-model="ctl(dev).intensity" :min="0" :max="100" />
                <span class="op-hint">调节电击强弱，0 最弱、100 最强</span>
              </div>
              <div class="control-field">
                <label>时长</label>
                <el-select v-model="ctl(dev).ticks" size="small" class="control-input">
                  <el-option label="循环播放" :value="-1" />
                  <el-option label="播放一遍" :value="0" />
                </el-select>
                <span class="op-hint">选择循环播放，还是只播放一遍就停</span>
              </div>
              <div class="control-actions">
                <el-button type="primary" size="small" :loading="opLoading[`dglabApply:${dev.deviceId}`]" @click="dglabApply(dev)">应用</el-button>
                <el-button size="small" :loading="opLoading[`dglabStop:${dev.deviceId}`]" @click="dglabStop(dev)">停止</el-button>
                <el-button size="small" :loading="opLoading[`dglabMax:${dev.deviceId}`]" @click="dglabMaxPrompt(dev)">强度上限 +10</el-button>
              </div>
              <div class="control-hint">“应用”下发当前设置；“停止”立刻断电；“强度上限 +10”把设备允许的最高强度再提高一档。</div>
            </div>
          </div>
        </div>
      </section>

      </el-tab-pane>
      <!-- 旧分栏保留逻辑，主界面不再展示 -->
      <el-tab-pane v-if="false" label="役次元" name="ycy">
      <section class="brand-col">
        <div class="brand-col__head">
          <h3 class="brand-col__name">役次元</h3>
          <p class="brand-col__desc">遥控蓝牙设备：可用本机桥接（mac）或网页蓝牙（mac / Windows / Linux / Android）直连，也可远程桥接，可同时连接多台，连上即可查看电量与状态。</p>
        </div>

        <el-card shadow="never" class="section-card">
          <template #header>
            <div class="card-header">
              <span>发现与连接</span>
              <el-radio-group v-model="ycyMode" size="small" class="mode-switch">
                <el-radio-button value="native">本机桥接</el-radio-button>
                <el-radio-button value="webble">网页蓝牙</el-radio-button>
                <el-radio-button value="bridge">远程桥接</el-radio-button>
              </el-radio-group>
              <el-button size="small" type="primary" :icon="Plus" @click="openAdd('ycy')">添加设备</el-button>
            </div>
          </template>

          <!-- 本机通道：mac 可选本机桥接/网页蓝牙，其他平台走网页蓝牙；另有远程桥接(WebSocket) -->
          <template v-if="ycyMode === 'native' || ycyMode === 'webble'">
            <!-- 原生桥（仅 macOS，Swift 桥，由 Electron 主进程监管（崩溃自启）） -->
            <template v-if="ycyMode === 'native'">
            <div class="discover-row">
              <el-tag :type="ycyNativeSummary.type" size="small" effect="light">{{ ycyNativeSummary.text }}</el-tag>
              <el-button type="primary" size="small" :loading="busy" :disabled="ycyNativeDevices.length === 0" @click="ycyNativeConnectAll">全部连接</el-button>
              <el-button size="small" :loading="busy" @click="ycyNativeRescan">重新扫描</el-button>
            </div>
            <p class="op-hint">本机已通过电脑蓝牙直接连接，可同时连多台，掉线会自动重连。下方每台可单独连接或断开。</p>
            <el-alert
              v-if="ycyNativeDevices.length === 0"
              class="hint"
              type="info"
              :closable="false"
              :title="ycyNativeBtHint"
            />
            <div v-else class="ycy-native-list">
              <el-card
                v-for="d in ycyNativeDevices"
                :key="d.id"
                shadow="hover"
                class="ycy-native-card"
                :class="{ 'ycy-native-card--ready': d.ready }"
              >
                <div class="ycy-native-card__head">
                  <el-icon v-if="d.ready" class="ycy-native-card__icon ycy-native-card__icon--ok"><CircleCheck /></el-icon>
                  <el-icon v-else class="ycy-native-card__icon ycy-native-card__icon--wait"><Loading /></el-icon>
                  <div class="ycy-native-card__title">
                    <div class="ycy-native-card__name">{{ brandLabel('ycy', d.name) }}</div>
                  </div>
                  <el-tag
                    :type="d.ready ? 'success' : ycyNativePending.includes(d.id) ? 'warning' : 'info'"
                    size="small"
                    effect="light"
                  >{{ d.ready ? '已连接' : ycyNativePending.includes(d.id) ? '连接中' : '待连接' }}</el-tag>
                  <el-tag type="info" size="small" effect="plain">{{ ycyTypeLabel(d.name) }}</el-tag>
                  <el-tag
                    v-if="d.ready"
                    :type="d.battery == null ? 'info' : (d.battery <= 20 ? 'danger' : d.battery <= 50 ? 'warning' : 'success')"
                    size="small"
                    effect="plain"
                    style="margin-left: 4px"
                  >电量 {{ d.battery == null ? '—' : d.battery + '%' }}</el-tag>
                </div>
                <div class="ycy-native-card__actions">
                  <el-button v-if="d.ready" type="danger" plain size="small" :loading="busy" @click="ycyNativeDisconnect(d)">断开连接</el-button>
                  <el-button v-else type="primary" size="small" :loading="busy" @click="ycyNativeConnect(d)">连接设备</el-button>
                </div>
              </el-card>
            </div>

            <!-- 排查：显示全部附近设备（含未命名），确认“为什么只看到 N 台”、找出灌肠机等未命名设备 -->
            <div class="diag">
              <div class="discover-row" style="margin-top: 8px">
                <el-button size="small" text bg @click="ycyShowAll = !ycyShowAll">{{ ycyShowAll ? '收起全部列表' : '排查：显示全部附近设备' }}</el-button>
                <span class="op-hint" style="margin: 0">桥共扫到 {{ ycyAllDevices.length }} 台附近蓝牙设备，其中已识别役次元 {{ ycyNativeDevices.length }} 台；其余多为手机/家电等无关设备，或广播无名字的未命名设备。</span>
              </div>
              <div v-if="ycyShowAll" class="diag-list">
                <div v-for="d in ycyAllDevices" :key="d.id" class="diag-item" :class="{ 'diag-item--matched': YCY_RE.test(d.name || '') }">
                  <span class="diag-name">{{ d.name || '未命名设备' }}</span>
                  <span class="diag-meta">{{ d.name ? '' : (d.id.slice(0, 8) + ' · ') }}RSSI {{ d.rssi }}</span>
                  <el-tag v-if="YCY_RE.test(d.name || '')" type="success" size="small" effect="plain">已识别</el-tag>
                  <el-tag v-else type="info" size="small" effect="plain">未识别</el-tag>
                  <el-tag :type="d.ready ? 'success' : 'info'" size="small">{{ d.ready ? '已连' : '待连' }}</el-tag>
                  <el-button v-if="!d.ready" size="small" type="primary" plain :loading="busy" @click="ycyNativeConnect(d)">连接</el-button>
                  <el-button v-else size="small" plain :loading="busy" @click="ycyNativeDisconnect(d)">断开</el-button>
                </div>
              </div>
            </div>
            </template>

            <!-- 浏览器直连（网页蓝牙 Web Bluetooth，非 macOS 自动选用） -->
            <template v-else-if="ycyMode === 'webble'">
              <div class="discover-row">
                <el-tag :type="ycyWebbleHint.type" size="small" effect="light">{{ ycyWebbleHint.text }}</el-tag>
                <el-button type="primary" size="small" :loading="scanningYcyWebble" :disabled="!webbleSupported" @click="ycyWebbleConnect">连接设备</el-button>
                <el-button v-if="scanningYcyWebble" size="small" @click="ycyWebbleCancelScan">取消</el-button>
              </div>
              <div v-if="ycyWebbleCandidates.length" class="candidate-list">
                <div v-for="c in ycyWebbleCandidates" :key="c.id" class="candidate-item">
                  <div class="candidate-info">
                    <span class="candidate-name">{{ brandLabel('ycy', c.name) }}</span>
                    <span class="candidate-meta">{{ c.name }}</span>
                  </div>
                  <el-button size="small" type="primary" @click="ycyWebblePick(c)">选择</el-button>
                </div>
              </div>
              <p class="op-hint">浏览器通过电脑蓝牙直接连接役次元：点“连接设备”后在系统蓝牙选择器里挑选即可，连上自动显示电量与设备类型，可同时连多台。需使用 Chrome / Edge 等支持网页蓝牙的浏览器，且页面须通过 https 或本机 localhost 打开。Windows / Linux / Android 均可使用。</p>
              <el-alert
                v-if="!webbleSupported"
                class="hint"
                type="warning"
                :closable="false"
                title="当前浏览器不支持网页蓝牙直连，请改用 Chrome / Edge 打开本页。"
              />
              <el-alert
                v-else-if="ycyWebbleDevices.length === 0"
                class="hint"
                type="info"
                :closable="false"
                title="点击“连接设备”以选择并连接附近的役次元设备（电击主机 / 杯 / 灌肠机均可）。"
              />
              <div v-else class="ycy-native-list">
                <el-card
                  v-for="d in ycyWebbleDevices"
                  :key="d.id"
                  shadow="hover"
                  class="ycy-native-card"
                  :class="{ 'ycy-native-card--ready': d.ready }"
                >
                  <div class="ycy-native-card__head">
                    <el-icon class="ycy-native-card__icon ycy-native-card__icon--ok"><CircleCheck /></el-icon>
                    <div class="ycy-native-card__title">
                      <div class="ycy-native-card__name">{{ brandLabel('ycy', d.name) }}</div>
                    </div>
                    <el-tag type="success" size="small" effect="light">已连接</el-tag>
                    <el-tag type="info" size="small" effect="plain">{{ ycyTypeLabel(d.name) }}</el-tag>
                    <el-tag
                      v-if="d.ready"
                      :type="d.battery == null ? 'info' : (d.battery <= 20 ? 'danger' : d.battery <= 50 ? 'warning' : 'success')"
                      size="small"
                      effect="plain"
                      style="margin-left: 4px"
                    >电量 {{ d.battery == null ? '—' : d.battery + '%' }}</el-tag>
                  </div>
                  <div v-if="/FJB/i.test(d.name || '')" class="control-grid">
                    <div class="control-field">
                      <label>旋转 {{ webbleCtl(d.id).stroke }}</label>
                      <el-slider v-model="webbleCtl(d.id).stroke" :min="0" :max="40" />
                    </div>
                    <div class="control-field">
                      <label>震动 {{ webbleCtl(d.id).vibe }}</label>
                      <el-slider v-model="webbleCtl(d.id).vibe" :min="0" :max="20" />
                    </div>
                    <div class="control-field">
                      <label>第三轴 {{ webbleCtl(d.id).axis }}</label>
                      <el-slider v-model="webbleCtl(d.id).axis" :min="0" :max="20" />
                    </div>
                    <div class="control-actions">
                      <el-button type="primary" size="small" :loading="opLoading[`fjb:${d.id}`]" @click="ycyWebbleFjbApply(d)">应用</el-button>
                      <el-button size="small" :loading="opLoading[`fjbStop:${d.id}`]" @click="ycyWebbleFjbStop(d)">停止</el-button>
                    </div>
                  </div>
                  <div class="ycy-native-card__actions">
                    <el-button type="danger" plain size="small" :loading="busy" @click="ycyWebbleDisconnect(d)">断开连接</el-button>
                  </div>
                </el-card>
              </div>
            </template>
          </template>

          <!-- 远程桥接 -->
          <template v-else>
            <div class="discover-row">
              <el-input v-model="ycyBridgeCode" placeholder="连接码（设备编号加空格加口令）" class="addr-input" />
            </div>
            <div class="discover-row">
              <el-select v-model="ycyBridgeType" size="small" class="type-select" placeholder="设备类型">
                <el-option label="电击器" value="YCY_EMS" />
                <el-option label="玩具 / 电机" value="YCY_TOY" />
                <el-option label="杯" value="YCY_CUP" />
                <el-option label="灌肠机" value="YCY_ENEMA" />
              </el-select>
            </div>
            <div class="discover-row">
              <el-input v-model="ycyBridgeHost" placeholder="桥接地址（设备桥接服务 IP，留空默认 127.0.0.1）" class="addr-input" />
              <el-input v-model="ycyBridgePort" placeholder="端口" class="port-input" />
              <el-button type="primary" :loading="busy" @click="connectYcyBridge">连接</el-button>
            </div>
            <p class="op-hint">远程桥接：依赖设备自带的桥接服务。在其运行后，填入连接码、选好设备类型、填好服务地址与端口即可控制。杯、灌肠机等非电击设备请选对应类型，连接后通过“玩法编号”触发设备里已存好的玩法。</p>
          </template>
        </el-card>

        <!-- 已连接的役次元设备：连上即可试控 -->
        <div class="brand-col__devices">
          <div v-if="!ycyConnected.length" class="brand-col__empty">还没有连接中的役次元设备，连上后可在这里试控</div>

          <div v-for="dev in ycyConnected" :key="dev.deviceId" class="device-card">
            <div class="device-card__head">
              <div>
                <span class="device-card__name">{{ brandLabel('ycy', dev.name) }}</span>
                <el-tag size="small" class="tag-brand">役次元</el-tag>
                <el-tag v-if="dev.type" size="small" type="warning">{{ dev.typeLabel || TYPE_LABEL[dev.type] || dev.type }}</el-tag>
              </div>
              <el-button size="small" :icon="Close" @click="disconnectDevice(dev)">断开</el-button>
            </div>

            <!-- 远程桥接 控制 -->
            <div v-if="dev.mode === 'bridge'" class="control-grid">
              <div class="control-field">
                <label>玩法编号</label>
                <el-input v-model="ctl(dev).commandId" size="small" placeholder="设备里已存的玩法编号" class="control-input" />
                <span class="op-hint">触发设备里已存好的玩法，在框里填写对应的编号</span>
              </div>
              <div class="control-actions">
                <el-button type="primary" size="small" :loading="opLoading[`ycyTrigger:${dev.deviceId}`]" @click="ycyTrigger(dev)">触发</el-button>
                <el-button size="small" :loading="opLoading[`ycyStop:${dev.deviceId}`]" @click="ycyStop(dev)">全部停止</el-button>
              </div>
              <div class="control-hint">“触发”按编号运行对应玩法；“全部停止”让设备立刻停下。</div>
            </div>

            <!-- 电击器 控制 -->
            <div v-else-if="ycyPanelType(dev) === 'YCY_EMS'" class="control-grid">
              <div class="control-field">
                <label>左通道强度 {{ ctl(dev).aStrength }}</label>
                <el-slider v-model="ctl(dev).aStrength" :min="0" :max="100" />
                <span class="op-hint">左边电击通道的强弱</span>
              </div>
              <div class="control-field">
                <label>右通道强度 {{ ctl(dev).bStrength }}</label>
                <el-slider v-model="ctl(dev).bStrength" :min="0" :max="100" />
                <span class="op-hint">右边电击通道的强弱</span>
              </div>
              <div class="control-field">
                <label>波形</label>
                <el-select v-model="ctl(dev).wave" size="small" class="control-input">
                  <el-option v-for="w in 16" :key="w" :label="`波形 ${w}`" :value="w" />
                </el-select>
                <span class="op-hint">选择电击的波形样式</span>
              </div>
              <div class="control-actions">
                <el-button type="primary" size="small" :loading="opLoading[`ycyEms:${dev.deviceId}`]" @click="ycyEmsApply(dev)">应用</el-button>
                <el-button size="small" :loading="opLoading[`ycyStop:${dev.deviceId}`]" @click="ycyStop(dev)">全部停止</el-button>
              </div>
            </div>

            <!-- FJB-03 杯：6 字节旋转/震动/第三轴 -->
            <div v-else-if="ycyPanelType(dev) === 'YCY_CUP'" class="control-grid">
              <div class="control-field">
                <label>旋转 {{ ctl(dev).stroke }}</label>
                <el-slider v-model="ctl(dev).stroke" :min="0" :max="40" />
              </div>
              <div class="control-field">
                <label>震动 {{ ctl(dev).vibe }}</label>
                <el-slider v-model="ctl(dev).vibe" :min="0" :max="20" />
              </div>
              <div class="control-field">
                <label>第三轴 {{ ctl(dev).axis }}</label>
                <el-slider v-model="ctl(dev).axis" :min="0" :max="20" />
              </div>
              <div class="control-actions">
                <el-button type="primary" size="small" :loading="opLoading[`ycyFjb:${dev.deviceId}`]" @click="ycyFjbApply(dev)">应用</el-button>
                <el-button size="small" :loading="opLoading[`ycyStop:${dev.deviceId}`]" @click="ycyFjbStop(dev)">停止</el-button>
              </div>
            </div>

            <!-- 玩具 / 电机 控制 -->
            <div v-else-if="ycyPanelType(dev) === 'YCY_TOY'" class="control-grid">
              <div class="control-field">
                <label>速度 {{ ctl(dev).speed }}</label>
                <el-slider v-model="ctl(dev).speed" :min="0" :max="100" />
                <span class="op-hint">电机转动的快慢</span>
              </div>
              <div class="control-field">
                <label>模式</label>
                <el-select v-model="ctl(dev).mode" size="small" class="control-input">
                  <el-option v-for="m in 4" :key="m" :label="`模式 ${m}`" :value="m" />
                </el-select>
                <span class="op-hint">电机的运行方式</span>
              </div>
              <div class="control-actions">
                <el-button type="primary" size="small" :loading="opLoading[`ycyToy:${dev.deviceId}`]" @click="ycyToyApply(dev)">应用</el-button>
                <el-button size="small" :loading="opLoading[`ycyStop:${dev.deviceId}`]" @click="ycyStop(dev)">停止</el-button>
              </div>
            </div>

            <div v-else-if="ycyPanelType(dev) === 'YCY_ENEMA'" class="control-grid">
              <div class="control-field">
                <label>泵动作</label>
                <el-select v-model="ctl(dev).scene" size="small" class="control-input">
                  <el-option label="注水" value="guan" />
                  <el-option label="抽气" value="add" />
                  <el-option label="排气" value="cut" />
                </el-select>
              </div>
              <div class="control-actions">
                <el-button type="primary" size="small" :loading="opLoading[`ycyPump:${dev.deviceId}`]" @click="ycyPumpApply(dev)">应用</el-button>
                <el-button size="small" :loading="opLoading[`ycyPumpS:${dev.deviceId}`]" @click="ycyPumpStop(dev)">停止</el-button>
              </div>
            </div>
          </div>
        </div>
      </section>
      </el-tab-pane>

      <el-tab-pane label="支持设备" name="support">
        <el-card shadow="never" class="section-card">
          <h3 class="support-h">已测试</h3>
          <ul class="support-list">
            <li v-for="item in testedDevices" :key="item">{{ item }}</li>
          </ul>
          <h3 class="support-h">理论支持</h3>
          <ul class="support-list">
            <li v-for="item in theoreticalDevices" :key="item">{{ item }}</li>
          </ul>
          <p class="op-hint">如需更多支持设备请联系客服</p>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="moreOpen" :title="moreTitle" width="560px" class="add-dialog">
      <template v-if="moreKind === 'native'">
        <p class="op-hint">本机桥接仅 macOS 可用，用电脑蓝牙经原生程序连接。</p>
        <template v-if="isMac">
          <h4>郊狼</h4>
          <div class="discover-row">
            <el-tag :type="dglabNativeSummary.type" size="small">{{ dglabNativeSummary.text }}</el-tag>
            <el-button type="primary" size="small" :loading="busy" :disabled="!dglabNativeDevices.length" @click="dglabNativeConnectAll">全部连接</el-button>
            <el-button size="small" :loading="busy" @click="dglabNativeRescan">重新扫描</el-button>
          </div>
          <h4>役次元</h4>
          <div class="discover-row">
            <el-tag :type="ycyNativeSummary.type" size="small">{{ ycyNativeSummary.text }}</el-tag>
            <el-button type="primary" size="small" :loading="busy" :disabled="!ycyNativeDevices.length" @click="ycyNativeConnectAll">全部连接</el-button>
            <el-button size="small" :loading="busy" @click="ycyNativeRescan">重新扫描</el-button>
          </div>
        </template>
        <el-alert v-else type="info" :closable="false" title="当前系统不是 Mac，请用「蓝牙连接」。" />
      </template>
      <template v-else-if="moreKind === 'dglab-phone'">
        <div class="discover-row">
          <el-input v-model="dglabHost" placeholder="手机上显示的地址" class="addr-input" />
          <el-input v-model="dglabPort" placeholder="端口" class="port-input" />
          <el-button type="primary" :loading="scanningDglab" @click="discoverDglab">探测</el-button>
        </div>
        <p class="op-hint">在配套手机软件打开娱乐模式，填入地址和端口后探测。</p>
        <div v-for="c in dglabCandidates" :key="c.suggestedDeviceId" class="candidate-item">
          <span class="candidate-name">{{ c.host }}:{{ c.port }}</span>
          <el-button size="small" type="primary" :disabled="!c.reachable || busy" @click="connectDglab(c)">连接</el-button>
        </div>
      </template>
      <template v-else-if="moreKind === 'ycy-bridge'">
        <div class="discover-row">
          <el-input v-model="ycyBridgeCode" placeholder="连接码（设备编号加空格加口令）" class="addr-input" />
        </div>
        <div class="discover-row">
          <el-select v-model="ycyBridgeType" size="small" class="type-select">
            <el-option label="电击器" value="YCY_EMS" />
            <el-option label="玩具 / 电机" value="YCY_TOY" />
            <el-option label="杯" value="YCY_CUP" />
            <el-option label="灌肠机" value="YCY_ENEMA" />
          </el-select>
        </div>
        <div class="discover-row">
          <el-input v-model="ycyBridgeHost" placeholder="桥接地址，留空为本机" class="addr-input" />
          <el-input v-model="ycyBridgePort" placeholder="端口" class="port-input" />
          <el-button type="primary" :loading="busy" @click="connectYcyBridge">连接</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 添加设备 对话框 -->
    <el-dialog v-model="addDialog" :title="`添加${BRAND_LABEL[addBrand]}设备`" width="480px" class="add-dialog">
      <el-radio-group v-model="addMethod" size="small" class="add-method">
        <el-radio-button v-if="addShowLocal" value="local">本机直连</el-radio-button>
        <el-radio-button value="remote">{{ addRemoteLabel }}</el-radio-button>
      </el-radio-group>

      <!-- 本机直连：从已扫描到的设备里挑一台连接 -->
      <div v-if="addMethod === 'local'" class="add-body">
        <div class="discover-row">
          <el-button size="small" :loading="busy" @click="addRescan">重新扫描</el-button>
          <span class="op-hint" style="margin: 0">选择下方设备即可连接，可同时连接多台。</span>
        </div>
        <div v-if="addNativeList.length === 0" class="brand-col__empty">
          暂未扫描到{{ BRAND_LABEL[addBrand] }}设备，请点“重新扫描”，并确认设备已开机、本机蓝牙已打开。
        </div>
        <div v-else class="candidate-list">
          <div v-for="d in addNativeList" :key="d.id" class="candidate-item">
            <div class="candidate-info">
              <span class="candidate-name">{{ brandLabel(addBrand, d.name) }}</span>
              <span class="candidate-meta">{{ d.ready ? '已连接' : '待连接' }}</span>
            </div>
            <el-button size="small" :type="d.ready ? 'info' : 'primary'" :disabled="d.ready" :loading="busy" @click="addNativeConnect(d)">
              {{ d.ready ? '已连接' : '连接' }}
            </el-button>
          </div>
        </div>
      </div>

      <!-- 手机连接（郊狼） -->
      <div v-else-if="addBrand === 'dglab' && addMethod === 'remote'" class="add-body">
        <div class="discover-row">
          <el-input v-model="dglabHost" placeholder="手机上显示的地址" class="addr-input" />
          <el-input v-model="dglabPort" placeholder="端口" class="port-input" />
          <el-button type="primary" :loading="scanningDglab" @click="discoverDglab">探测</el-button>
        </div>
        <p class="op-hint">手机连接：在配套手机软件里打开“娱乐模式”，屏幕上会显示本机地址和端口，填好后点“探测”即可发现设备。</p>
        <div v-if="dglabCandidates.length" class="candidate-list">
          <div v-for="c in dglabCandidates" :key="c.suggestedDeviceId" class="candidate-item">
            <div class="candidate-info">
              <span class="candidate-name">{{ brandLabel('dglab', c.suggestedName) }}</span>
              <span class="candidate-meta">{{ c.host }}:{{ c.port }}
                <el-tag v-if="c.reachable" type="success" size="small">可达</el-tag>
                <el-tag v-else type="danger" size="small">不可达</el-tag>
              </span>
            </div>
            <el-button size="small" type="primary" :disabled="!c.reachable || busy" @click="connectDglab(c)">连接</el-button>
          </div>
        </div>
      </div>

      <!-- 远程桥接（役次元） -->
      <div v-else-if="addBrand === 'ycy' && addMethod === 'remote'" class="add-body">
        <div class="discover-row">
          <el-input v-model="ycyBridgeCode" placeholder="连接码（设备编号加空格加口令）" class="addr-input" />
        </div>
        <div class="discover-row">
          <el-select v-model="ycyBridgeType" size="small" class="type-select" placeholder="设备类型">
            <el-option label="电击器" value="YCY_EMS" />
            <el-option label="玩具 / 电机" value="YCY_TOY" />
            <el-option label="杯" value="YCY_CUP" />
            <el-option label="灌肠机" value="YCY_ENEMA" />
          </el-select>
        </div>
        <div class="discover-row">
          <el-input v-model="ycyBridgeHost" placeholder="桥接地址，本机直连留空即可" class="addr-input" />
          <el-input v-model="ycyBridgePort" placeholder="端口" class="port-input" />
          <el-button type="primary" :loading="busy" @click="connectYcyBridge">连接</el-button>
        </div>
        <p class="op-hint">远程桥接：依赖设备自带的桥接服务。在其运行后，填入连接码、选好设备类型、填好服务地址与端口即可控制。</p>
      </div>

      <template #footer>
        <el-button size="small" @click="addDialog = false">完成</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, Connection, Switch, Close, CircleCheck, Loading, Plus, ArrowDown } from '@element-plus/icons-vue'
import * as brandsApi from '../api/brands'
import * as ycyBridge from '../api/ycyBridge'
import type { BrandDevice, DiscoverCandidate } from '../api/brands'
import type { YcyBridgeDevice } from '../api/ycyBridge'
import * as dglabBridge from '../api/dglabBridge'
import type { DglabBridgeDevice } from '../api/dglabBridge'
import * as brandBle from '../web-ble/brandBle'
import * as ycyBle from '../web-ble/ycyBle'

// 品牌中文显示名（按页面要求显示：郊狼 / 役次元）。
const BRAND_LABEL: Record<string, string> = {
  dglab: '郊狼',
  ycy: '役次元',
}
const TYPE_LABEL: Record<string, string> = {
  DGLAB: '郊狼',
  DGLAB_V2: '郊狼（直连版）',
  YCY_EMS: '电击主机',
  YCY_TOY: '电机/玩具',
  YCY_CUP: '杯',
  YCY_ENEMA: '灌肠机',
}

// 设备名映射为友好中文名（仅显示层，不改连接/电量逻辑）
function brandLabel(brand: string, rawName?: string | null): string {
  const name = (rawName || '').trim()
  const up = name.toUpperCase()
  if (brand === 'dglab') {
    if (up.startsWith('D-LAB') || up.startsWith('DG-LAB')) return '郊狼2.0'
    if (up.startsWith('47L')) return '郊狼3.0'
    return name || '郊狼'
  }
  if (brand === 'ycy') {
    // 按广播名/设备名识别设备类型，映射到中文友好名：
    // 杯(FJB)、灌肠机(YISK/灌肠/ENEMA/GLJ/GLS)、电击主机(DJ)；其余役次元家族统称“役次元设备”
    if (/FJB/i.test(name)) return '杯'
    if (/(YISK|灌肠|ENEMA|GLJ|GLS)/i.test(name)) return '灌肠机'
    if (/DJ/i.test(name)) return '电击主机'
    if (/(YSKJ|YOKO|YOKONEX|YCY|YYC|YICIYUAN)/i.test(name)) return '役次元设备'
    return '役次元主机2.0'
  }
  return name || brand
}

// 役次元设备类型标签（与 brandLabel 一致的识别规则），用于卡片上的小标签
function ycyTypeLabel(rawName?: string | null): string {
  const n = rawName || ''
  if (/FJB/i.test(n)) return '杯'
  if (/(YISK|灌肠|ENEMA|GLJ|GLS)/i.test(n)) return '灌肠机'
  if (/DJ/i.test(n)) return '电击主机'
  if (/(YSKJ|YOKO|YOKONEX|YCY|YYC|YICIYUAN)/i.test(n)) return '役次元设备'
  return '役次元主机'
}

const activeBrand = ref<'dglab' | 'ycy'>('dglab')
const pageTab = ref<'connect' | 'support'>('connect')
const moreOpen = ref(false)
const moreKind = ref<'native' | 'dglab-phone' | 'ycy-bridge'>('native')
const moreTitle = computed(() => {
  if (moreKind.value === 'native') return '本机桥接'
  if (moreKind.value === 'dglab-phone') return '郊狼手机连接'
  return '役次元远程桥接'
})
const testedDevices = [
  '役次元 YCY-FJB-03 杯（网页蓝牙）',
]
const theoreticalDevices = [
  '郊狼 2.0 / 3.0（网页蓝牙、本机桥接、手机娱乐模式）',
  '役次元电击主机（网页蓝牙 / 远程桥接）',
  '役次元电机 / 玩具（网页蓝牙 / 远程桥接）',
  '役次元灌肠机（网页蓝牙 / 远程桥接）',
]
const busy = ref(false)
const refreshing = ref(false)

// 郊狼 发现
const isMac = computed(() => /Mac/i.test(navigator.userAgent || navigator.platform || ''))
// 连接模式（用户用切换按钮选）：本机桥接(native, mac) / 网页蓝牙(webble) / 手机连接(phone)
// mac 默认本机桥接（Swift 桥，由 Electron 主进程监管（崩溃自启）稳定）；网页蓝牙为功能最全通道（直连 GATT，可下发原始强度/通道/帧/泵控制）。
const dglabMode = ref<'native' | 'webble' | 'phone'>(isMac.value ? 'native' : 'webble')
const dglabHost = ref('')
const dglabPort = ref('60536')
const scanningDglab = ref(false)
const dglabCandidates = ref<DiscoverCandidate[]>([])

// 郊狼 本机直连（原生桥 dglab_bridge :3002，绕开 macOS Web Bluetooth 对 3.0 的限制）
const dglabNativeDevices = ref<DglabBridgeDevice[]>([])
// 桥扫到的全部附近设备（含未命名 name=null 的），用于排查“为什么只有 N 台可见”
const dglabAllDevices = ref<DglabBridgeDevice[]>([])
const dglabShowAll = ref(false)
const dglabNativeBtOn = ref(true)
// 本机桥进程是否在运行（fetch 127.0.0.1:3002 能否到达）。
// 与 bluetoothOn 区分：桥未连接 ≠ 蓝牙未开启，避免误报“蓝牙关闭”。
const dglabBridgeUp = ref(true)
const dglabNativePending = ref<string[]>([])
const dglabNativeEver = ref<string[]>([])
const dglabNativeManual = ref<string[]>([])
const dglabNativeTimer = ref<number | null>(null)
// 郊狼设备名关键字（含 3.0 的 47L 前缀与 2.0 的 D-LAB/DG-LAB）
const DGLAB_RE = /D-LAB|DG-LAB|47L|COYOTE|YSKJ|ESTIM/i

// 郊狼 浏览器直连（网页蓝牙 Web Bluetooth，跨平台：Windows / Linux / Android 的 Edge / Chrome）
// macOS 下郊狼 3.0 私有 GATT 枚举受限，故 macOS 不暴露此模式（改走原生桥）。
interface DglabWebbleDevice { id: string; name: string; battery?: number | null; ready: boolean }
const webbleSupported = computed(() => brandBle.isSupported())
const dglabWebbleDevices = ref<DglabWebbleDevice[]>([])
const scanningWebble = ref(false)
const dglabWebbleUnlisten = new Map<string, () => void>()
const dglabWebbleHint = computed(() => {
  if (!webbleSupported.value) return { type: 'warning' as const, text: '浏览器不支持' }
  const n = dglabWebbleDevices.value.length
  return { type: (n ? 'success' : 'info') as const, text: n ? `已连接 ${n} 台` : '待连接' }
})
const dglabWebbleCandidates = ref<Array<{ id: string; name: string }>>([])
let dglabScanUnsub: (() => void) | null = null
function dglabWebbleCancelScan() {
  brandBle.cancelSelection().catch(() => {})
}
async function dglabWebblePick(c: { id: string; name: string }) {
  try { await brandBle.selectDevice(c.id) } catch (e: any) { ElMessage.error(e?.message || '选择失败') }
}
async function dglabWebbleConnect() {
  if (!webbleSupported.value) { ElMessage.warning('当前浏览器不支持网页蓝牙直连'); return }
  scanningWebble.value = true
  dglabWebbleCandidates.value = []
  dglabScanUnsub = brandBle.onScanResults((list) => { dglabWebbleCandidates.value = list })
  try {
    const meta = await brandBle.scanAndConnect()
    const id = meta.id
    if (!dglabWebbleDevices.value.find((d) => d.id === id)) {
      dglabWebbleDevices.value.push({ id, name: meta.name, battery: null, ready: true })
    }
    const un = brandBle.onBattery(id, (b) => {
      const dev = dglabWebbleDevices.value.find((d) => d.id === id)
      if (dev) dev.battery = b
    })
    dglabWebbleUnlisten.set(id, un)
    await refreshConnected()
    ElMessage.success('已连接 ' + brandLabel('dglab', meta.name))
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (!/cancel|Cancelled|User cancelled|NavigatorUserAgent/i.test(msg)) ElMessage.error(msg || '连接失败')
  } finally {
    dglabScanUnsub?.(); dglabScanUnsub = null
    dglabWebbleCandidates.value = []
    scanningWebble.value = false
  }
}
async function dglabWebbleApply(d: DglabWebbleDevice) {
  const s = webbleCtl(d.id)
  await withLoading(`dglabW:${d.id}`, async () => {
    await brandsApi.control(d.id, 'setPattern', { pattern: '经典', intensity: s.intensity ?? 60, ticks: -1 })
    ElMessage.success('已下发')
  }).catch((e: any) => { ElMessage.error(e?.message || '下发失败') })
}
async function dglabWebbleStop(d: DglabWebbleDevice) {
  await withLoading(`dglabWS:${d.id}`, async () => {
    await brandsApi.control(d.id, 'stop')
  }).catch((e: any) => { ElMessage.error(e?.message || '停止失败') })
}
async function dglabWebbleDisconnect(d: DglabWebbleDevice) {
  busy.value = true
  try {
    if (!window.brandBleApi) {
      try { await brandBle.sendStop(d.id) } catch (_) {}
    } else {
      await brandsApi.disconnect(d.id)
    }
    await brandBle.disconnect(d.id)
    dglabWebbleUnlisten.get(d.id)?.()
    dglabWebbleUnlisten.delete(d.id)
    dglabWebbleDevices.value = dglabWebbleDevices.value.filter((x) => x.id !== d.id)
    ElMessage.success('已断开')
  } catch (e: any) {
    ElMessage.error(e?.message || '断开失败')
  } finally {
    busy.value = false
  }
}

// 役次元 连接模式（用户用切换按钮选）：本机桥接(native, mac) / 网页蓝牙(webble) / 远程桥接(bridge)
// mac 默认本机桥接（Swift 桥，由 Electron 主进程监管（崩溃自启）稳定）；网页蓝牙为功能最全通道（直连 GATT，可下发原始强度/通道/帧/泵控制）。
const ycyMode = ref<'native' | 'webble' | 'bridge'>(isMac.value ? 'native' : 'webble')

// 添加设备 对话框
const addDialog = ref(false)
const addBrand = ref<'dglab' | 'ycy'>('dglab')
const addMethod = ref<'local' | 'remote'>('remote')
const addShowLocal = computed(() => isMac.value) // 本机直连（原生桥）仅 macOS 可用
const addRemoteLabel = computed(() => (addBrand.value === 'dglab' ? '手机连接' : '远程桥接'))
const addNativeList = computed(() =>
  addBrand.value === 'dglab' ? dglabNativeDevices.value : ycyNativeDevices.value
)
function openAdd(brand: 'dglab' | 'ycy') {
  addBrand.value = brand
  addMethod.value = 'remote'
  addDialog.value = true
}
async function addRescan() {
  if (addBrand.value === 'dglab') await dglabNativeRescan()
  else await ycyNativeRescan()
}
async function addNativeConnect(d: DglabBridgeDevice | YcyBridgeDevice) {
  if (addBrand.value === 'dglab') await dglabNativeConnect(d as DglabBridgeDevice)
  else await ycyNativeConnect(d as YcyBridgeDevice)
}
const ycyBridgeCode = ref('')
const ycyBridgeHost = ref('')
const ycyBridgePort = ref('3001')
const ycyBridgeType = ref<'YCY_EMS' | 'YCY_TOY' | 'YCY_CUP' | 'YCY_ENEMA'>('YCY_EMS')

const backendDevices = ref<BrandDevice[]>([])
const connectedDevices = computed<BrandDevice[]>(() => backendDevices.value)
// 按品牌拆分，分别在各栏目展示
const dglabConnected = computed<BrandDevice[]>(() => connectedDevices.value.filter((d) => d.brand === 'dglab'))
const ycyConnected = computed<BrandDevice[]>(() => connectedDevices.value.filter((d) => d.brand === 'ycy'))
const allConnected = computed<BrandDevice[]>(() => connectedDevices.value)

// 统计
const totalCount = computed(() =>
  dglabNativeDevices.value.length + dglabWebbleDevices.value.length + ycyNativeDevices.value.length + ycyWebbleDevices.value.length + backendDevices.value.length
)
const onlineCount = computed(() => connectedDevices.value.filter((d) => d.connected).length)
const offlineCount = computed(() => connectedDevices.value.filter((d) => !d.connected).length)

// 自动刷新
const autoRefreshEnabled = ref(true)
const autoRefreshTimer = ref<number | null>(null)
function startAutoRefresh() {
  stopAutoRefresh()
  autoRefreshTimer.value = window.setInterval(() => {
    if (!document.hidden) refreshConnected()
  }, 3000)
}
function stopAutoRefresh() {
  if (autoRefreshTimer.value) {
    clearInterval(autoRefreshTimer.value)
    autoRefreshTimer.value = null
  }
}
const controlState = reactive<Record<string, Record<string, any>>>({})
const opLoading = reactive<Record<string, boolean>>({})
function withLoading(key: string, fn: () => Promise<void>) {
  opLoading[key] = true
  return fn().finally(() => { opLoading[key] = false })
}
function webbleCtl(id: string) {
  if (!controlState[id]) controlState[id] = { stroke: 15, vibe: 0, axis: 0, intensity: 60 }
  return controlState[id]
}

function ycyPanelType(dev: { type?: string; name?: string }) {
  if (dev.type && TYPE_LABEL[dev.type]) return dev.type
  const n = String(dev.name || '')
  if (/灌肠|enema|glj|yisk/i.test(n)) return 'YCY_ENEMA'
  if (/杯|cup|fjb/i.test(n)) return 'YCY_CUP'
  if (/toy|玩具|tdd/i.test(n)) return 'YCY_TOY'
  if (/dj|ems|电击/i.test(n)) return 'YCY_EMS'
  return 'YCY_EMS'
}
function ctl(dev: BrandDevice) {
  if (!controlState[dev.deviceId]) {
    controlState[dev.deviceId] = {
      pattern: '经典', intensity: 60, ticks: -1,
      commandId: '', aStrength: 40, bStrength: 40, wave: 1,
      speed: 60, mode: 1, stroke: 15, vibe: 0, axis: 0, scene: 'guan',
      v2AStrength: 0, v2BStrength: 0, v2Ax: 5, v2Ay: 200, v2Bx: 5, v2By: 200,
    }
  }
  return controlState[dev.deviceId]
}

const dglabPatterns = ['经典', '心跳', '潮汐', '渐强', '随机', '脉冲', '波浪', '电击']

async function refreshConnected() {
  refreshing.value = true
  try {
    backendDevices.value = await brandsApi.listDevices()
  } catch (_) {
    // 后端（brands API）不可用时静默忽略：本机直连走原生桥、不依赖后端；
    // 仅手机连接模式需要后端，其探测/连接会单独报错提示。
  } finally {
    refreshing.value = false
  }
}

async function discoverDglab() {
  if (!dglabHost.value) { ElMessage.warning('请先填写手机上显示的地址'); return }
  scanningDglab.value = true
  try {
    const res = await brandsApi.discover('dglab', { host: dglabHost.value, port: dglabPort.value })
    dglabCandidates.value = res.devices
  } catch (e: any) {
    ElMessage.error(e?.message || '探测失败')
  } finally {
    scanningDglab.value = false
  }
}

async function connectDglab(c: DiscoverCandidate) {
  busy.value = true
  try {
    await brandsApi.connect({
      brand: 'dglab',
      deviceId: c.suggestedDeviceId,
      name: c.suggestedName,
      host: c.host,
      port: c.port,
    })
    ElMessage.success('郊狼设备已连接')
    await refreshConnected()
  } catch (e: any) {
    ElMessage.error(e?.message || '连接失败')
  } finally {
    busy.value = false
  }
}

// ===== 郊狼 本机直连（原生桥 dglab_bridge :3002，仅 macOS 回退用） =====
const dglabNativeSummary = computed(() => {
  // 桥未连接：是进程没跑（浏览器开发 / 客户端未拉起），不是蓝牙关了
  if (!dglabBridgeUp.value) return { type: 'warning' as const, text: '本机桥未连接（请用客户端打开，或切到“网页蓝牙”）' }
  const total = dglabNativeDevices.value.length
  const connected = dglabNativeDevices.value.filter((d) => d.ready).length
  if (total === 0) return { type: 'info' as const, text: dglabNativeBtOn.value ? '搜索中' : '蓝牙未开启' }
  return { type: (connected === total ? 'success' : 'warning') as const, text: `已连接 ${connected}/${total}` }
})
const dglabNativeBtHint = computed(() => {
  if (!dglabBridgeUp.value) return '本机桥（原生桥进程）未运行：请通过客户端打开本程序，或在本页切到“网页蓝牙”模式。'
  return dglabNativeBtOn.value ? '正在搜索附近的郊狼设备…' : '蓝牙未开启，请确认本机蓝牙已打开。'
})
function dglabNativeMarkPending(id: string) {
  if (!dglabNativePending.value.includes(id)) dglabNativePending.value.push(id)
  const tid = id
  setTimeout(() => { dglabNativePending.value = dglabNativePending.value.filter((x) => x !== tid) }, 8000)
}
async function dglabNativeAuto() {
  // 仅在本机直连（原生桥，macOS）下自动连接，避免与其他平台的网页蓝牙冲突
  if (!isMac.value) return
  for (const d of dglabNativeDevices.value) {
    if (d.ready) {
      if (!dglabNativeEver.value.includes(d.id)) dglabNativeEver.value.push(d.id)
      dglabNativeManual.value = dglabNativeManual.value.filter((x) => x !== d.id)
      dglabNativePending.value = dglabNativePending.value.filter((x) => x !== d.id)
      continue
    }
    // 自动连上所有发现的郊狼设备（桥已按品牌过滤，出现的都是郊狼）；
    // 仅用户手动断开过的设备（dglabNativeManual）不自动重连。
    if (!dglabNativeManual.value.includes(d.id) && !dglabNativePending.value.includes(d.id)) {
      dglabNativeMarkPending(d.id)
      dglabBridge.connect(d.id).catch(() => {})
    }
  }
}
async function dglabNativeRefresh() {
  try {
    const st = await dglabBridge.getStatus()
    const all = (st.devices || []).slice().sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))
    // 桥的 bluetoothOn 标志在 macOS 上不可靠（btleplug StateUpdate 不触发）；
    // 以“是否真扫到设备”为真相：只要有设备，蓝牙必然已开启，不误报“蓝牙未开启”。
    // 与役次元(YCY)的判断逻辑保持一致。
    dglabBridgeUp.value = true
    dglabNativeBtOn.value = st.bluetoothOn || all.length > 0
    dglabAllDevices.value = all
    dglabNativeDevices.value = all.filter((d) => DGLAB_RE.test(d.name || ''))
    await dglabNativeAuto()
  } catch (_) {
    // 桥进程未运行（浏览器开发环境 / 客户端未拉起）≠ 蓝牙未开启，不据此误报。
    dglabBridgeUp.value = false
    if (dglabNativeDevices.value.length === 0) dglabNativeBtOn.value = false
  }
}
async function dglabNativeConnect(d: DglabBridgeDevice) {
  busy.value = true
  try {
    dglabNativeManual.value = dglabNativeManual.value.filter((x) => x !== d.id)
    dglabNativeMarkPending(d.id)
    await dglabBridge.connect(d.id)
    ElMessage.success('已发起连接')
    await dglabNativeRefresh()
  } catch (e: any) {
    ElMessage.error(e?.message || '连接失败')
  } finally {
    busy.value = false
  }
}
async function dglabNativeDisconnect(d: DglabBridgeDevice) {
  busy.value = true
  try {
    await dglabBridge.disconnect(d.id)
    if (!dglabNativeManual.value.includes(d.id)) dglabNativeManual.value.push(d.id)
    dglabNativeEver.value = dglabNativeEver.value.filter((x) => x !== d.id)
    ElMessage.success('已断开')
    await dglabNativeRefresh()
  } catch (e: any) {
    ElMessage.error(e?.message || '断开失败')
  } finally {
    busy.value = false
  }
}
async function dglabNativeConnectAll() {
  busy.value = true
  try {
    dglabNativeManual.value = []
    for (const d of dglabNativeDevices.value) {
      if (!d.ready && !dglabNativePending.value.includes(d.id)) {
        dglabNativeMarkPending(d.id)
        dglabBridge.connect(d.id).catch(() => {})
      }
    }
    ElMessage.info('已对全部发现的设备发起连接')
    await dglabNativeRefresh()
  } catch (e: any) {
    ElMessage.error(e?.message || '连接失败')
  } finally {
    busy.value = false
  }
}
async function dglabNativeRescan() {
  busy.value = true
  try {
    dglabNativeManual.value = []
    await dglabBridge.rescan()
    ElMessage.info('已重新扫描')
    await dglabNativeRefresh()
  } catch (e: any) {
    ElMessage.error(e?.message || '扫描失败')
  } finally {
    busy.value = false
  }
}
function startDglabNativeTimer() {
  stopDglabNativeTimer()
  dglabNativeTimer.value = window.setInterval(() => {
    if (!document.hidden) dglabNativeRefresh()
  }, 2000)
}
function stopDglabNativeTimer() {
  if (dglabNativeTimer.value) {
    clearInterval(dglabNativeTimer.value)
    dglabNativeTimer.value = null
  }
}

async function connectYcyBridge() {
  if (!ycyBridgeCode.value) { ElMessage.warning('请填写连接码'); return }
  busy.value = true
  try {
    await brandsApi.connect({
      brand: 'ycy',
      mode: 'bridge',
      type: ycyBridgeType.value,
      connectCode: ycyBridgeCode.value,
      host: ycyBridgeHost.value || '127.0.0.1',
      port: ycyBridgePort.value,
    })
    ElMessage.success('役次元（远程桥接）已连接')
    await refreshConnected()
  } catch (e: any) {
    ElMessage.error(e?.message || '连接失败')
  } finally {
    busy.value = false
  }
}

// 役次元 - 本机直连（多设备），经本地蓝牙桥 3001
const ycyNativeDevices = ref<YcyBridgeDevice[]>([])
// 桥扫到的全部附近设备（含未命名 name=null 的），用于排查“为什么只有 N 台可见”
const ycyAllDevices = ref<YcyBridgeDevice[]>([])
const ycyShowAll = ref(false)
const ycyNativeBtOn = ref(true)
// 本机桥进程是否在运行（fetch 127.0.0.1:3001 能否到达）。
const ycyBridgeUp = ref(true)
const ycyNativePending = ref<string[]>([])
const ycyNativeEver = ref<string[]>([])
const ycyNativeManual = ref<string[]>([])
const ycyNativeTimer = ref<number | null>(null)
// 役次元全系设备名关键字：电击主机(DJ)、杯(FJB)、灌肠机(灌肠/ENEMA/GLJ)，以及 YCY/YYC/YSKJ/YOKO 等系列
const YCY_RE = /YCY|YYC|YSKJ|YOKO|YOKONEX|YISK|DJ-V2|YICIYUAN|DJ|FJB|灌肠|ENEMA|GLJ/i

const ycyNativeSummary = computed(() => {
  if (!ycyBridgeUp.value) return { type: 'warning' as const, text: '本机桥未连接（请用客户端打开，或切到“网页蓝牙”）' }
  const total = ycyNativeDevices.value.length
  const connected = ycyNativeDevices.value.filter((d) => d.ready).length
  if (total === 0) return { type: 'info' as const, text: ycyNativeBtOn.value ? '搜索中' : '蓝牙未开启' }
  return { type: (connected === total ? 'success' : 'warning') as const, text: `已连接 ${connected}/${total}` }
})
const ycyNativeBtHint = computed(() => {
  if (!ycyBridgeUp.value) return '本机桥（原生桥进程）未运行：请通过客户端打开本程序，或在本页切到“网页蓝牙”模式。'
  return ycyNativeBtOn.value ? '正在搜索附近的役次元设备…' : '蓝牙未开启，请确认本机蓝牙已打开。'
})
function ycyNativeMarkPending(id: string) {
  if (!ycyNativePending.value.includes(id)) ycyNativePending.value.push(id)
  const tid = id
  setTimeout(() => { ycyNativePending.value = ycyNativePending.value.filter((x) => x !== tid) }, 8000)
}
async function ycyNativeAuto() {
  // 自动连接所有发现的役次元设备（杯/灌肠机/电击主机等多台），
  // 仅跳过用户手动断开过的设备；与郊狼本机直连保持一致的多设备逻辑。
  for (const d of ycyNativeDevices.value) {
    if (d.ready) {
      if (!ycyNativeEver.value.includes(d.id)) ycyNativeEver.value.push(d.id)
      ycyNativeManual.value = ycyNativeManual.value.filter((x) => x !== d.id)
      ycyNativePending.value = ycyNativePending.value.filter((x) => x !== d.id)
      continue
    }
    if (!ycyNativeManual.value.includes(d.id) && !ycyNativePending.value.includes(d.id)) {
      ycyNativeMarkPending(d.id)
      ycyBridge.connect(d.id).catch(() => {})
    }
  }
}
async function ycyNativeRefresh() {
  try {
    const st = await ycyBridge.getStatus()
    const all = (st.devices || []).slice().sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))
    // 桥的 bluetoothOn 标志不可靠（曾出现“签名变导致 bluetoothOn=false”但仍能扫到设备）；
    // 以“是否真扫到设备”为真相：只要有设备，蓝牙必然已开启，不误报“蓝牙未开启”。
    ycyBridgeUp.value = true
    ycyNativeBtOn.value = st.bluetoothOn || all.length > 0
    ycyAllDevices.value = all
    ycyNativeDevices.value = all.filter((d) => YCY_RE.test(d.name || ''))
    await ycyNativeAuto()
  } catch (_) {
    ycyBridgeUp.value = false
    if (ycyNativeDevices.value.length === 0) ycyNativeBtOn.value = false
  }
}
async function ycyNativeConnect(d: YcyBridgeDevice) {
  busy.value = true
  try {
    ycyNativeManual.value = ycyNativeManual.value.filter((x) => x !== d.id)
    ycyNativeMarkPending(d.id)
    await ycyBridge.connect(d.id)
    ElMessage.success('已发起连接')
    await ycyNativeRefresh()
  } catch (e: any) {
    ElMessage.error(e?.message || '连接失败')
  } finally {
    busy.value = false
  }
}
async function ycyNativeDisconnect(d: YcyBridgeDevice) {
  busy.value = true
  try {
    await ycyBridge.disconnect(d.id)
    if (!ycyNativeManual.value.includes(d.id)) ycyNativeManual.value.push(d.id)
    ycyNativeEver.value = ycyNativeEver.value.filter((x) => x !== d.id)
    ElMessage.success('已断开')
    await ycyNativeRefresh()
  } catch (e: any) {
    ElMessage.error(e?.message || '断开失败')
  } finally {
    busy.value = false
  }
}
async function ycyNativeConnectAll() {
  busy.value = true
  try {
    ycyNativeManual.value = []
    for (const d of ycyNativeDevices.value) {
      if (!d.ready && !ycyNativePending.value.includes(d.id)) {
        ycyNativeMarkPending(d.id)
        ycyBridge.connect(d.id).catch(() => {})
      }
    }
    ElMessage.info('已对全部发现的设备发起连接')
    await ycyNativeRefresh()
  } catch (e: any) {
    ElMessage.error(e?.message || '连接失败')
  } finally {
    busy.value = false
  }
}
async function ycyNativeRescan() {
  busy.value = true
  try {
    ycyNativeManual.value = []
    await ycyBridge.rescan()
    ElMessage.info('已重新扫描')
    await ycyNativeRefresh()
  } catch (e: any) {
    ElMessage.error(e?.message || '扫描失败')
  } finally {
    busy.value = false
  }
}
function startYcyNativeTimer() {
  stopYcyNativeTimer()
  ycyNativeTimer.value = window.setInterval(() => {
    if (!document.hidden) ycyNativeRefresh()
  }, 2000)
}
function stopYcyNativeTimer() {
  if (ycyNativeTimer.value) {
    clearInterval(ycyNativeTimer.value)
    ycyNativeTimer.value = null
  }
}

// 役次元 浏览器直连（网页蓝牙 Web Bluetooth，跨平台：Windows / Linux / Android 的 Edge / Chrome）
// 同一套设备名识别 / 类型标签 / 电量展示逻辑，与 macOS 原生桥一致；仅连接通道不同。
interface YcyWebbleDevice { id: string; name: string; battery?: number | null; ready: boolean }
const ycyWebbleDevices = ref<YcyWebbleDevice[]>([])
const ycyWebbleCandidates = ref<Array<{ id: string; name: string }>>([])
let ycyScanUnsub: (() => void) | null = null
const scanningYcyWebble = ref(false)
function ycyWebbleCancelScan() {
  brandBle.cancelSelection().catch(() => {})
}
function startBleConnect(kind: string | number) {
  if (kind === 'dglab') dglabWebbleConnect()
  else ycyWebbleConnect()
}
function openMoreConnect(kind: string | number) {
  moreKind.value = kind as 'native' | 'dglab-phone' | 'ycy-bridge'
  moreOpen.value = true
  if (kind === 'native' && isMac.value) {
    dglabNativeRescan()
    ycyNativeRescan()
  }
}
async function ycyWebblePick(c: { id: string; name: string }) {
  try { await brandBle.selectDevice(c.id) } catch (e: any) { ElMessage.error(e?.message || '选择失败') }
}
const ycyWebbleUnlisten = new Map<string, () => void>()
const ycyWebbleHint = computed(() => {
  if (!webbleSupported.value) return { type: 'warning' as const, text: '浏览器不支持' }
  const n = ycyWebbleDevices.value.length
  return { type: (n ? 'success' : 'info') as const, text: n ? `已连接 ${n} 台` : '待连接' }
})
async function ycyWebbleConnect() {
  if (!webbleSupported.value) { ElMessage.warning('当前浏览器不支持网页蓝牙直连'); return }
  scanningYcyWebble.value = true
  ycyWebbleCandidates.value = []
  ycyScanUnsub = brandBle.onScanResults((list) => { ycyWebbleCandidates.value = list })
  try {
    if (window.ycyBleApi?.isSupported()) {
      const meta = await window.ycyBleApi.connect()
      await refreshConnected()
      ElMessage.success('已连接 ' + brandLabel('ycy', meta.name))
      return
    }
    const meta = await ycyBle.scanAndConnect()
    const id = meta.id
    if (!ycyWebbleDevices.value.find((d) => d.id === id)) {
      ycyWebbleDevices.value.push({ id, name: meta.name, battery: (meta as any).battery ?? null, ready: true })
    }
    const un = ycyBle.onBattery(id, (b) => {
      const dev = ycyWebbleDevices.value.find((d) => d.id === id)
      if (dev) dev.battery = b
    })
    ycyWebbleUnlisten.set(id, un)
    ElMessage.success('已连接 ' + brandLabel('ycy', meta.name))
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (!/cancel|Cancelled|User cancelled|NavigatorUserAgent/i.test(msg)) ElMessage.error(msg || '连接失败')
  } finally {
    ycyScanUnsub?.(); ycyScanUnsub = null
    ycyWebbleCandidates.value = []
    scanningYcyWebble.value = false
  }
}
async function ycyWebbleFjbApply(d: YcyWebbleDevice) {
  const s = webbleCtl(d.id)
  await withLoading(`fjb:${d.id}`, async () => {
    await ycyBle.sendFjb03(d.id, { stroke: s.stroke, vibe: s.vibe, axis: s.axis })
    ElMessage.success('已下发')
  }).catch((e: any) => { ElMessage.error(e?.message || '下发失败') })
}
async function ycyWebbleFjbStop(d: YcyWebbleDevice) {
  await withLoading(`fjbStop:${d.id}`, async () => {
    await ycyBle.sendFjb03(d.id, { stroke: 0, vibe: 0, axis: 0 })
  }).catch((e: any) => { ElMessage.error(e?.message || '停止失败') })
}
async function ycyWebbleDisconnect(d: YcyWebbleDevice) {
  busy.value = true
  try {
    if (window.ycyBleApi) {
      await brandsApi.disconnect(d.id)
    } else if (/(YISK|灌肠|ENEMA|GLJ|GLS)/i.test(d.name || '')) {
      try { await ycyBle.sendPumpEncrypted(d.id, { protocol: 'v1', scene: 'stop' }) } catch (_) {}
    } else if (/FJB/i.test(d.name || '')) {
      try { await ycyBle.sendFjb03(d.id, { stroke: 0, vibe: 0, axis: 0 }) } catch (_) {}
    } else {
      try { await ycyBle.sendEmsStop(d.id) } catch (_) {}
    }
    await ycyBle.disconnect(d.id)
    ycyWebbleUnlisten.get(d.id)?.()
    ycyWebbleUnlisten.delete(d.id)
    ycyWebbleDevices.value = ycyWebbleDevices.value.filter((x) => x.id !== d.id)
    ElMessage.success('已断开')
  } catch (e: any) {
    ElMessage.error(e?.message || '断开失败')
  } finally {
    busy.value = false
  }
}

async function dglabApply(dev: BrandDevice) {
  const s = ctl(dev)
  await withLoading(`dglabApply:${dev.deviceId}`, async () => {
    if (!window.brandBleApi) {
      await brandBle.sendPattern(dev.deviceId, s.intensity)
    } else {
      await brandsApi.control(dev.deviceId, 'setPattern', { pattern: s.pattern, intensity: s.intensity, ticks: s.ticks })
    }
    ElMessage.success('已下发波形')
  }).catch((e: any) => { ElMessage.error(e?.message || '下发失败') })
}

async function dglabStop(dev: BrandDevice) {
  await withLoading(`dglabStop:${dev.deviceId}`, async () => {
    if (!window.brandBleApi) await brandBle.sendStop(dev.deviceId)
    else await brandsApi.control(dev.deviceId, 'stop')
  }).catch((e: any) => { ElMessage.error(e?.message || '停止失败') })
}

async function dglabMaxPrompt(dev: BrandDevice) {
  await withLoading(`dglabMax:${dev.deviceId}`, async () => {
    if (!window.brandBleApi) {
      ElMessage.warning('原版 V2 直连不支持调整 App 强度上限')
      return
    }
    await brandsApi.control(dev.deviceId, 'setMaxIntensity', { delta: 10 })
  }).catch((e: any) => { ElMessage.error(e?.message || '操作失败') })
}

async function ycyTrigger(dev: BrandDevice) {
  const s = ctl(dev)
  if (!s.commandId) { ElMessage.warning('请填写玩法编号'); return }
  await withLoading(`ycyTrigger:${dev.deviceId}`, async () => {
    await brandsApi.control(dev.deviceId, 'trigger', { commandId: s.commandId })
  }).catch((e: any) => { ElMessage.error(e?.message || '触发失败') })
}

async function ycyStop(dev: BrandDevice) {
  await withLoading(`ycyStop:${dev.deviceId}`, async () => {
    if (!window.ycyBleApi) {
      const type = ycyPanelType(dev)
      if (type === 'YCY_TOY') await ycyBle.sendMotor(dev.deviceId, 0)
      else if (type === 'YCY_CUP') await ycyBle.sendFjb03(dev.deviceId, { stroke: 0, vibe: 0, axis: 0 })
      else if (type === 'YCY_ENEMA') await ycyBle.sendPumpEncrypted(dev.deviceId, { protocol: 'v1', scene: 'stop' })
      else await ycyBle.sendEmsStop(dev.deviceId)
      ElMessage.success('已停止')
      return
    }
    await brandsApi.control(dev.deviceId, 'ycyStop')
  }).catch((e: any) => { ElMessage.error(e?.message || '停止失败') })
}

async function ycyEmsApply(dev: BrandDevice) {
  const s = ctl(dev)
  await withLoading(`ycyEms:${dev.deviceId}`, async () => {
    if (!window.ycyBleApi) {
      await ycyBle.sendEmsStrength(dev.deviceId, { channel: 'A', value: s.aStrength, wave: s.wave })
      await ycyBle.sendEmsStrength(dev.deviceId, { channel: 'B', value: s.bStrength, wave: s.wave })
    } else {
      // 波形更新必须带当前强度，避免生成 0 强度帧。
      await brandsApi.control(dev.deviceId, 'setStrength', { channel: 'A', value: s.aStrength, wave: s.wave })
      await brandsApi.control(dev.deviceId, 'setStrength', { channel: 'B', value: s.bStrength, wave: s.wave })
    }
    ElMessage.success('已下发')
  }).catch((e: any) => { ElMessage.error(e?.message || '下发失败') })
}

async function ycyFjbApply(dev: BrandDevice) {
  const s = ctl(dev)
  await withLoading(`ycyFjb:${dev.deviceId}`, async () => {
    if (!window.ycyBleApi) await ycyBle.sendFjb03(dev.deviceId, { stroke: s.stroke, vibe: s.vibe, axis: s.axis })
    else await brandsApi.control(dev.deviceId, 'setFjb', { stroke: s.stroke, vibe: s.vibe, axis: s.axis })
    ElMessage.success('已下发')
  }).catch((e: any) => { ElMessage.error(e?.message || '下发失败') })
}
async function ycyFjbStop(dev: BrandDevice) {
  await withLoading(`ycyStop:${dev.deviceId}`, async () => {
    if (!window.ycyBleApi) await ycyBle.sendFjb03(dev.deviceId, { stroke: 0, vibe: 0, axis: 0 })
    else await brandsApi.control(dev.deviceId, 'setFjb', { stroke: 0, vibe: 0, axis: 0 })
  }).catch((e: any) => { ElMessage.error(e?.message || '停止失败') })
}

async function ycyPumpApply(dev: BrandDevice) {
  const s = ctl(dev)
  await withLoading(`ycyPump:${dev.deviceId}`, async () => {
    if (!window.ycyBleApi) {
      await ycyBle.sendPumpEncrypted(dev.deviceId, { protocol: 'v1', scene: s.scene || 'guan' })
      ElMessage.success('已下发')
      return
    }
    const res = await fetch(`/api/devices/${encodeURIComponent(dev.deviceId)}/capabilities/pump/actions/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: s.scene || 'guan' }),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || '下发失败')
    ElMessage.success('已下发')
  }).catch((e: any) => { ElMessage.error(e?.message || '下发失败') })
}
async function ycyPumpStop(dev: BrandDevice) {
  await withLoading(`ycyPumpS:${dev.deviceId}`, async () => {
    if (!window.ycyBleApi) {
      await ycyBle.sendPumpEncrypted(dev.deviceId, { protocol: 'v1', scene: 'stop' })
      ElMessage.success('已停止')
      return
    }
    const res = await fetch(`/api/devices/${encodeURIComponent(dev.deviceId)}/capabilities/pump/actions/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || '停止失败')
  }).catch((e: any) => { ElMessage.error(e?.message || '停止失败') })
}
async function ycyToyApply(dev: BrandDevice) {
  const s = ctl(dev)
  await withLoading(`ycyToy:${dev.deviceId}`, async () => {
    if (!window.ycyBleApi) {
      await ycyBle.sendMotor(dev.deviceId, Math.round((s.speed / 100) * 20))
    } else {
      await brandsApi.control(dev.deviceId, 'setSpeed', { motor: 'A', speed: Math.round((s.speed / 100) * 20) })
      await brandsApi.control(dev.deviceId, 'setToyMode', { motor: 'A', mode: s.mode })
    }
    ElMessage.success('已下发')
  }).catch((e: any) => { ElMessage.error(e?.message || '下发失败') })
}

async function disconnectDevice(dev: BrandDevice) {
  try {
    await brandsApi.disconnect(dev.deviceId)
    ElMessage.success('已断开')
    await refreshConnected()
  } catch (e: any) { ElMessage.error(e?.message || '断开失败') }
}

async function probeBridgeAndPickDefault() {
  // 浏览器开发环境（如 localhost:5173）没有 Electron 监管本机桥进程，原生桥 fetch 会失败。
  // 向“原设备端设备列表（网页蓝牙）”学习：探测到桥不可达且网页蓝牙可用时，一次性回退到网页蓝牙，
  // 避免一直误报“蓝牙关闭”。桥可达（如正式客户端）时保持本机桥接。
  const probe = async (port: number): Promise<boolean> => {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 800)
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: ctrl.signal })
      clearTimeout(timer)
      return res.ok
    } catch {
      return false
    }
  }
  const [yUp, dUp] = await Promise.all([probe(3001), probe(3002)])
  ycyBridgeUp.value = yUp
  dglabBridgeUp.value = dUp
  if (ycyMode.value === 'native' && !yUp && webbleSupported.value) ycyMode.value = 'webble'
  if (dglabMode.value === 'native' && !dUp && webbleSupported.value) dglabMode.value = 'webble'
}

onMounted(() => {
  refreshConnected()
  if (autoRefreshEnabled.value) startAutoRefresh()
  if (isMac.value) startYcyNativeTimer()
  if (isMac.value) startDglabNativeTimer()
  probeBridgeAndPickDefault()
})
onUnmounted(() => { stopAutoRefresh(); stopYcyNativeTimer(); stopDglabNativeTimer() })
</script>

<style scoped>
.brands-page { display: flex; flex-direction: column; gap: 16px; }
.page-header { display: flex; align-items: baseline; gap: 12px; }
.page-title { font-size: 18px; font-weight: 700; color: var(--text-primary); margin: 0; }
.page-sub { color: var(--text-muted); font-size: 13px; }
.section-card { background-color: var(--bg-card, var(--bg-app)); }
.card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.mode-switch { flex-shrink: 0; }
.add-method { margin-bottom: 14px; }
.add-body { display: flex; flex-direction: column; gap: 6px; }
.discover-row { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.addr-input { flex: 1; min-width: 180px; }
.type-select { width: 160px; }
.port-input { width: 110px; }
.hint { margin-bottom: 12px; }
.op-hint { color: var(--text-muted); font-size: 12px; line-height: 1.6; margin: 0; }
.brand-tabs { margin-top: 4px; }
.brand-col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.brand-col__head { display: flex; flex-direction: column; gap: 4px; }
.brand-col__name { font-size: 16px; font-weight: 700; color: var(--text-primary); margin: 0; }
.brand-col__desc { color: var(--text-muted); font-size: 12px; line-height: 1.6; margin: 0; }
.brand-col__devices { display: flex; flex-direction: column; gap: 12px; }
.brand-col__empty { color: var(--text-muted); font-size: 13px; padding: 12px; border: 1px dashed var(--border-subtle); border-radius: 8px; text-align: center; }
.candidate-list { display: flex; flex-direction: column; gap: 8px; }
.candidate-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border: 1px solid var(--border-subtle); border-radius: 8px;
  background-color: var(--bg-app);
}
.candidate-info { display: flex; flex-direction: column; gap: 2px; }
.candidate-name { color: var(--text-primary); font-weight: 600; }
.candidate-meta { color: var(--text-muted); font-size: 12px; display: flex; align-items: center; gap: 6px; }
.device-card { border: 1px solid var(--border-subtle); border-radius: 10px; padding: 14px; background-color: var(--bg-app); }
.device-card__head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.device-card__name { color: var(--text-primary); font-weight: 700; margin-right: 8px; }
.tag-brand { margin-right: 6px; }
.control-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; align-items: end; }
.control-field { display: flex; flex-direction: column; gap: 6px; }
.control-field label { color: var(--text-muted); font-size: 12px; }
.control-input { width: 100%; }
.control-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.control-hint { grid-column: 1 / -1; color: var(--text-muted); font-size: 12px; }
.control-hint code { background: rgba(255,255,255,0.06); padding: 1px 5px; border-radius: 4px; }
.ycy-native-list { display: flex; flex-direction: column; gap: 12px; }
.ycy-native-card { background-color: var(--bg-app); }
.ycy-native-card--ready { border-color: var(--el-color-success); }
.ycy-native-card__head { display: flex; align-items: center; gap: 12px; }
.ycy-native-card__icon { font-size: 28px; }
.ycy-native-card__icon--ok { color: var(--el-color-success); }
.ycy-native-card__icon--wait { color: var(--text-muted); animation: rotating 1.4s linear infinite; }
.ycy-native-card__title { flex: 1; min-width: 0; }
.ycy-native-card__name { font-size: 15px; font-weight: 600; color: var(--text-primary); }
.ycy-native-card__meta { margin-top: 12px; }
.ycy-native-card__actions { display: flex; gap: 8px; margin-top: 12px; }
.diag { margin-top: 8px; border-top: 1px dashed var(--border-subtle); padding-top: 10px; }
.diag-list { display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow: auto; }
.diag-item {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 10px; border: 1px solid var(--border-subtle); border-radius: 8px;
  background-color: var(--bg-app); font-size: 13px;
}
.diag-item--matched { border-color: var(--el-color-success); }
.diag-name { color: var(--text-primary); font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }
.diag-meta { color: var(--text-muted); font-size: 12px; }
@keyframes rotating { from { transform: rotate(0); } to { transform: rotate(360deg); } }
.stats-card { background-color: var(--bg-card, var(--bg-app)); }
.stats-card--compact { padding: 0; }
.stats-card--compact :deep(.el-card__body) { padding: 8px 14px; }
.stat-mini { font-size: 13px; color: var(--text-muted); }
.stat-mini.online-stat { color: var(--el-color-success); }
.stat-mini.offline-stat { color: var(--el-color-info); }
.stats-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.stats-actions { margin-left: auto; display: flex; align-items: center; gap: 12px; }
.connect-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.support-h { font-size: 14px; margin: 12px 0 6px; color: var(--text-primary); }
.support-list { margin: 0 0 12px 18px; padding: 0; color: var(--text-primary); line-height: 1.8; }
</style>
