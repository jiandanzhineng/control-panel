<template>
  <div class="brands-page">
    <div class="page-header">
      <h2 class="page-title">品牌设备</h2>
      <span class="page-sub">蓝牙体感设备与遥控蓝牙设备的发现、连接与操控</span>
    </div>

    <el-tabs v-model="activeBrand" class="brand-tabs">
      <!-- ============ 蓝牙体感设备 ============ -->
      <el-tab-pane label="蓝牙体感设备" name="dglab">
        <el-card shadow="never" class="section-card">
          <template #header>
            <div class="card-header">
              <span>发现与连接</span>
              <el-radio-group v-model="dglabMode" size="small">
                <el-radio-button value="ws">娱乐模式（App WiFi）</el-radio-button>
                <el-radio-button value="webble">蓝牙直连（V2）</el-radio-button>
              </el-radio-group>
            </div>
          </template>

          <!-- 娱乐模式（App WebSocket） -->
          <template v-if="dglabMode === 'ws'">
            <div class="discover-row">
              <el-input v-model="dglabHost" placeholder="手机 IP（娱乐模式显示的地址）" class="addr-input" />
              <el-input v-model="dglabPort" placeholder="端口" class="port-input" />
              <el-button type="primary" :loading="scanningDglab" @click="discoverDglab">探测</el-button>
            </div>
            <el-alert
              class="hint"
              type="info"
              :closable="false"
              title="在设备配套 App 内开启「娱乐模式」后，会显示本机 IP 与端口（默认 60536）。填入后点击探测即可发现。"
            />
            <div v-if="dglabCandidates.length" class="candidate-list">
              <div
                v-for="c in dglabCandidates"
                :key="c.suggestedDeviceId"
                class="candidate-item"
              >
                <div class="candidate-info">
                  <span class="candidate-name">{{ c.suggestedName }}</span>
                  <span class="candidate-meta">{{ c.host }}:{{ c.port }}
                    <el-tag v-if="c.reachable" type="success" size="small">可达</el-tag>
                    <el-tag v-else type="danger" size="small">不可达</el-tag>
                  </span>
                </div>
                <el-button
                  size="small"
                  type="primary"
                  :disabled="!c.reachable || busy"
                  @click="connectDglab(c)"
                >连接</el-button>
              </div>
            </div>
          </template>

          <!-- 蓝牙体感设备（直连版）Web Bluetooth 直连 -->
          <template v-else>
            <el-alert
              class="hint"
              type="info"
              :closable="false"
              title="通过 Web Bluetooth 直连蓝牙体感设备（直连版）。支持 Windows / Linux / Android / macOS 的 Chromium 内核浏览器（Edge / Chrome）。连接后可在下方「已连接设备」区直接调控强度与波形。"
            />
            <div class="discover-row">
              <el-button type="primary" :loading="scanningV2" @click="connectDglabV2">连接（选择蓝牙设备）</el-button>
              <el-button v-if="v2Candidates.length && !scanningV2" @click="cancelV2Scan">取消</el-button>
            </div>
            <div v-if="v2Candidates.length" class="candidate-list">
              <div
                v-for="c in v2Candidates"
                :key="c.id"
                class="candidate-item"
              >
                <div class="candidate-info">
                  <span class="candidate-name">蓝牙体感设备（直连）</span>
                  <span class="candidate-meta">{{ c.id }}</span>
                </div>
                <el-button size="small" type="primary" @click="pickV2(c)">选择</el-button>
              </div>
            </div>
          </template>
        </el-card>
      </el-tab-pane>

      <!-- ============ 遥控蓝牙设备 ============ -->
      <el-tab-pane label="遥控蓝牙设备" name="ycy">
        <el-card shadow="never" class="section-card">
          <template #header>
            <div class="card-header">
              <span>连接模式</span>
              <el-radio-group v-model="ycyMode" size="small">
                <el-radio-button value="bridge">桥接（API-bridge）</el-radio-button>
                <el-radio-button value="ble">蓝牙直连（BLE）</el-radio-button>
              </el-radio-group>
            </div>
          </template>

          <!-- 桥接模式 -->
          <template v-if="ycyMode === 'bridge'">
            <div class="discover-row">
              <el-input v-model="ycyBridgeCode" placeholder="连接码（UID 空格 Token）" class="addr-input" />
            </div>
            <div class="discover-row">
              <el-select v-model="ycyBridgeType" size="small" class="type-select" placeholder="设备类型">
                <el-option label="电击器" value="YCY_EMS" />
                <el-option label="玩具/电机" value="YCY_TOY" />
                <el-option label="杯" value="YCY_CUP" />
                <el-option label="灌肠机" value="YCY_ENEMA" />
              </el-select>
            </div>
            <div class="discover-row">
              <el-input v-model="ycyBridgeHost" placeholder="桥接服务 IP" class="addr-input" />
              <el-input v-model="ycyBridgePort" placeholder="端口" class="port-input" />
              <el-button type="primary" :loading="busy" @click="connectYcyBridge">连接</el-button>
            </div>
            <el-alert class="hint" type="info" :closable="false"
              title="桥接模式依赖设备 API-bridge 服务。在其运行后填入连接码与服务地址即可控制；杯 / 灌肠机等非电击设备请选择对应类型，连接后通过「指令 ID」触发 App 内已配置的玩法。" />
          </template>

          <!-- BLE 模式 -->
          <template v-else>
            <div class="discover-row">
              <el-button type="primary" :loading="scanningBle" @click="scanYcyBle">扫描附近设备</el-button>
            </div>
            <div v-if="bleCandidates.length" class="candidate-list">
              <div v-for="c in bleCandidates" :key="c.deviceId" class="candidate-item">
                <div class="candidate-info">
                  <span class="candidate-name">{{ c.suggestedName }}</span>
                  <span class="candidate-meta">RSSI {{ c.rssi ?? '—' }}</span>
                </div>
                <el-button size="small" type="primary" :disabled="busy" @click="connectYcyBle(c)">连接</el-button>
              </div>
            </div>
          </template>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- ============ 统计 + 自动刷新（与原设备页一致） ============ -->
    <el-card shadow="never" class="stats-card">
      <div class="stats-row">
        <el-statistic title="品牌设备总数" :value="totalCount" />
        <el-statistic title="在线设备" :value="onlineCount" class="online-stat" />
        <el-statistic title="离线设备" :value="offlineCount" class="offline-stat" />
        <div class="stats-actions">
          <el-checkbox v-model="autoRefreshEnabled" @change="(v: any) => v ? startAutoRefresh() : stopAutoRefresh()">自动刷新</el-checkbox>
          <el-button size="small" :icon="Refresh" :loading="refreshing" @click="refreshConnected">刷新</el-button>
        </div>
      </div>
    </el-card>

    <!-- ============ 已连接设备 ============ -->
    <el-card shadow="never" class="section-card">
      <template #header>
        <div class="card-header">
          <span>已连接设备（{{ connectedDevices.length }}）</span>
        </div>
      </template>

      <el-empty v-if="!connectedDevices.length" description="暂无已连接的品牌设备" />

      <div v-for="dev in connectedDevices" :key="dev.deviceId" class="device-card">
        <div class="device-card__head">
          <div>
            <span class="device-card__name">{{ dev.name || dev.deviceId }}</span>
            <el-tag size="small" class="tag-brand">{{ dev.brandLabel || BRAND_LABEL[dev.brand] || dev.brand }}</el-tag>
            <el-tag v-if="dev.mode" size="small" type="info">{{ dev.mode }}</el-tag>
            <el-tag v-if="dev.type" size="small" type="warning">{{ dev.typeLabel || TYPE_LABEL[dev.type] || dev.type }}</el-tag>
          </div>
          <el-button size="small" :icon="Close" @click="disconnectDevice(dev)">断开</el-button>
        </div>

        <!-- 蓝牙体感设备 娱乐模式控制 -->
        <div v-if="dev.brand === 'dglab' && dev.mode !== 'webble'" class="control-grid">
          <div class="control-field">
            <label>波形</label>
            <el-select v-model="ctl(dev).pattern" size="small" class="control-input">
              <el-option v-for="p in dglabPatterns" :key="p" :label="p" :value="p" />
            </el-select>
          </div>
          <div class="control-field">
            <label>强度 {{ ctl(dev).intensity }}</label>
            <el-slider v-model="ctl(dev).intensity" :min="0" :max="100" />
          </div>
          <div class="control-field">
            <label>时长</label>
            <el-select v-model="ctl(dev).ticks" size="small" class="control-input">
              <el-option label="循环" :value="-1" />
              <el-option label="播放一遍" :value="0" />
            </el-select>
          </div>
          <div class="control-actions">
            <el-button type="primary" size="small" :loading="opLoading[`dglabApply:${dev.deviceId}`]" @click="dglabApply(dev)">应用</el-button>
            <el-button size="small" :loading="opLoading[`dglabStop:${dev.deviceId}`]" @click="dglabStop(dev)">停止</el-button>
            <el-button size="small" :loading="opLoading[`dglabMax:${dev.deviceId}`]" @click="dglabMaxPrompt(dev)">强度上限 +10</el-button>
          </div>
        </div>

        <!-- 蓝牙体感设备（直连版）蓝牙直连控制 -->
        <div v-else-if="dev.brand === 'dglab' && dev.mode === 'webble'" class="control-grid">
          <div class="control-field">
            <label>通道 A 强度 {{ ctl(dev).v2AStrength }}</label>
            <el-slider v-model="ctl(dev).v2AStrength" :min="0" :max="100" />
          </div>
          <div class="control-field">
            <label>通道 B 强度 {{ ctl(dev).v2BStrength }}</label>
            <el-slider v-model="ctl(dev).v2BStrength" :min="0" :max="100" />
          </div>
          <div class="control-field">
            <label>通道 A 波形 频率X {{ ctl(dev).v2Ax }} / 强度Y {{ ctl(dev).v2Ay }}</label>
            <el-slider v-model="ctl(dev).v2Ay" :min="0" :max="1023" />
            <el-slider v-model="ctl(dev).v2Ax" :min="0" :max="31" />
          </div>
          <div class="control-field">
            <label>通道 B 波形 频率X {{ ctl(dev).v2Bx }} / 强度Y {{ ctl(dev).v2By }}</label>
            <el-slider v-model="ctl(dev).v2By" :min="0" :max="1023" />
            <el-slider v-model="ctl(dev).v2Bx" :min="0" :max="31" />
          </div>
          <div class="control-field">
            <label>电量</label>
            <span class="candidate-meta">{{ dev.data?.battery ?? '—' }}%</span>
          </div>
          <div class="control-field">
            <label>强度位排布（标定用）</label>
            <el-select v-model="v2Layout" size="small" class="control-input" @change="onV2LayoutChange">
              <el-option label="布局方案 A（经验参考，默认）" value="coyote2" />
              <el-option label="布局方案 B（官方文档）" value="official" />
            </el-select>
            <div class="control-hint">两种写法对强度数据包的位排布不同，需用真机实测确认哪种正确。切换即时生效并记忆。</div>
          </div>
          <div class="control-actions">
            <el-button type="primary" size="small" :loading="opLoading[`v2Apply:${dev.deviceId}`]" @click="dglabV2Apply(dev)">应用</el-button>
            <el-button size="small" :loading="opLoading[`v2Stop:${dev.deviceId}`]" @click="dglabV2Stop(dev)">停止</el-button>
            <el-button size="small" :loading="opLoading[`v2Battery:${dev.deviceId}`]" @click="dglabV2ReadBattery(dev)">读取电量</el-button>
          </div>
          <div class="control-hint">强度按 0–100 映射至硬件 0–2047；波形频率 = X + Y（X 0–31，Y 0–1023）。</div>
        </div>

        <!-- 遥控蓝牙设备 桥接控制 -->
        <div v-else-if="dev.brand === 'ycy' && dev.mode === 'bridge'" class="control-grid">
          <div class="control-field">
            <label>指令 ID</label>
            <el-input v-model="ctl(dev).commandId" size="small" placeholder="如 player_hurt" class="control-input" />
          </div>
          <div class="control-actions">
            <el-button type="primary" size="small" :loading="opLoading[`ycyTrigger:${dev.deviceId}`]" @click="ycyTrigger(dev)">触发指令</el-button>
            <el-button size="small" :loading="opLoading[`ycyStop:${dev.deviceId}`]" @click="ycyStop(dev)">全部停止</el-button>
          </div>
          <div class="control-hint">桥接模式以 App 内已配置指令触发；全局停止为 <code>_stop_all</code>。</div>
        </div>

        <!-- 遥控蓝牙设备 BLE 电击器 -->
        <div v-else-if="dev.brand === 'ycy' && dev.mode === 'ble' && dev.type === 'YCY_EMS'" class="control-grid">
          <div class="control-field">
            <label>通道 A 强度 {{ ctl(dev).aStrength }}</label>
            <el-slider v-model="ctl(dev).aStrength" :min="0" :max="100" />
          </div>
          <div class="control-field">
            <label>通道 B 强度 {{ ctl(dev).bStrength }}</label>
            <el-slider v-model="ctl(dev).bStrength" :min="0" :max="100" />
          </div>
          <div class="control-field">
            <label>波形</label>
            <el-select v-model="ctl(dev).wave" size="small" class="control-input">
              <el-option v-for="w in 17" :key="w" :label="`波形 ${w}`" :value="w" />
            </el-select>
          </div>
          <div class="control-actions">
            <el-button type="primary" size="small" :loading="opLoading[`ycyEms:${dev.deviceId}`]" @click="ycyEmsApply(dev)">应用</el-button>
            <el-button size="small" :loading="opLoading[`ycyStop:${dev.deviceId}`]" @click="ycyStop(dev)">全部停止</el-button>
          </div>
        </div>

        <!-- 遥控蓝牙设备 BLE 玩具/电机 -->
        <div v-else-if="dev.brand === 'ycy' && dev.mode === 'ble' && dev.type === 'YCY_TOY'" class="control-grid">
          <div class="control-field">
            <label>速度 {{ ctl(dev).speed }}</label>
            <el-slider v-model="ctl(dev).speed" :min="0" :max="100" />
          </div>
          <div class="control-field">
            <label>模式</label>
            <el-select v-model="ctl(dev).mode" size="small" class="control-input">
              <el-option v-for="m in 4" :key="m" :label="`模式 ${m}`" :value="m" />
            </el-select>
          </div>
          <div class="control-actions">
            <el-button type="primary" size="small" :loading="opLoading[`ycyToy:${dev.deviceId}`]" @click="ycyToyApply(dev)">应用</el-button>
            <el-button size="small" :loading="opLoading[`ycyStop:${dev.deviceId}`]" @click="ycyStop(dev)">停止</el-button>
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, Connection, Switch, Close } from '@element-plus/icons-vue'
import * as brandsApi from '../api/brands'
import * as brandBle from '../web-ble/brandBle'
import type { BrandDevice, DiscoverCandidate } from '../api/brands'
import type { BrandBleCandidate } from '../web-ble/brandBle'

// 品牌 / 类型的中文脱敏显示名（与后端 backend/brands/brandLabels.js 保持一致）。
// 仅用于展示，不暴露真实商业品牌名；内部路由码（dglab/ycy/DGLAB/YCY_*）保持不变。
const BRAND_LABEL: Record<string, string> = {
  dglab: '蓝牙体感设备',
  ycy: '遥控蓝牙设备',
}
const TYPE_LABEL: Record<string, string> = {
  DGLAB: '蓝牙体感设备',
  DGLAB_V2: '蓝牙体感设备（直连版）',
  YCY_EMS: '电击型设备',
  YCY_TOY: '电机型设备',
  YCY_CUP: '杯型设备',
  YCY_ENEMA: '灌肠型设备',
}

const activeBrand = ref<'dglab' | 'ycy'>('dglab')
const busy = ref(false)
const refreshing = ref(false)

// 蓝牙体感设备发现
const dglabMode = ref<'ws' | 'webble'>('ws')
const dglabHost = ref('')
const dglabPort = ref('60536')
const scanningDglab = ref(false)
const dglabCandidates = ref<DiscoverCandidate[]>([])

// 蓝牙体感设备（直连版）Web Bluetooth 直连
const scanningV2 = ref(false)
const v2Candidates = ref<BrandBleCandidate[]>([])
  // 网页版（非 Electron）下本地直接连的 V2 设备
const localV2 = ref<{ id: string; name: string; connected: boolean; battery?: number } | null>(null)
// V2 强度位排布（标定用，localStorage 记忆）
const v2Layout = ref<'official' | 'coyote2'>('coyote2')

// 遥控蓝牙设备
const ycyMode = ref<'bridge' | 'ble'>('bridge')
const ycyBridgeCode = ref('')
const ycyBridgeHost = ref('127.0.0.1')
const ycyBridgePort = ref('3001')
// 桥接连接时指定的设备类型（区分电击器 / 玩具电机 / 杯 / 灌肠机）
const ycyBridgeType = ref<'YCY_EMS' | 'YCY_TOY' | 'YCY_CUP' | 'YCY_ENEMA'>('YCY_EMS')
const scanningBle = ref(false)
const bleCandidates = ref<DiscoverCandidate[]>([])

const backendDevices = ref<BrandDevice[]>([])
const connectedDevices = computed<BrandDevice[]>(() => {
  if (localV2.value) {
    const local: BrandDevice = {
      deviceId: localV2.value.id,
      brand: 'dglab',
      mode: 'webble',
      kind: 'brand',
      type: 'DGLAB',
      name: localV2.value.name,
      connected: true,
      metadata: { connectionType: 'brandBle' },
      data: { battery: localV2.value.battery },
    }
    return [...backendDevices.value, local]
  }
  return backendDevices.value
})
// 与原设备页一致的统计：总数 / 在线 / 离线
const totalCount = computed(() => connectedDevices.value.length)
const onlineCount = computed(() => connectedDevices.value.filter((d) => d.connected).length)
const offlineCount = computed(() => connectedDevices.value.filter((d) => !d.connected).length)

// 自动刷新（与原设备页一致：可开关的轮询兜底，推送为主、拉取为辅）
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

// 操作 loading 态（与原设备页 operationLoading 对齐）
const opLoading = reactive<Record<string, boolean>>({})
function withLoading(key: string, fn: () => Promise<void>) {
  opLoading[key] = true
  return fn().finally(() => { opLoading[key] = false })
}

function ctl(dev: BrandDevice) {
  if (!controlState[dev.deviceId]) {
    controlState[dev.deviceId] = {
      pattern: '经典', intensity: 60, ticks: -1,
      commandId: '', aStrength: 40, bStrength: 40, wave: 1,
      speed: 60, mode: 1,
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
  } catch (e: any) {
    ElMessage.error(e?.message || '获取设备列表失败')
  } finally {
    refreshing.value = false
  }
}

async function discoverDglab() {
  if (!dglabHost.value) { ElMessage.warning('请先填写手机 IP'); return }
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
    ElMessage.success('蓝牙体感设备已连接')
    await refreshConnected()
  } catch (e: any) {
    ElMessage.error(e?.message || '连接失败')
  } finally {
    busy.value = false
  }
}

async function connectDglabV2() {
  if (!brandBle.isSupported()) {
    ElMessage.warning('当前客户端不支持 Web Bluetooth（需 Windows / Linux / Android 版，或 macOS 的 Edge/Chrome）')
    return
  }
  // Electron 路径：经主进程 IPC（两步：扫描候选 + 选择）
  if (window.brandBleApi) {
    scanningV2.value = true
    const off = brandBle.onScanResults((devices) => { v2Candidates.value = devices })
    try {
      // 注意：必须走 scanAndConnect（内部为 window.brandBleApi.connect，经 select-bluetooth-device
      // 推送候选并由 pickV2 选择），brandBle 模块本身未导出 connect，误用会整体失败。
      await brandBle.scanAndConnect()
      v2Candidates.value = []
      ElMessage.success('蓝牙体感设备（直连版）已连接')
      await refreshConnected()
    } catch (e: any) {
      ElMessage.error(e?.  message || '连接失败')
    } finally {
      scanningV2.value = false
      off()
    }
    return
  }
  // 纯网页路径：浏览器原生 Web Bluetooth 弹窗选设备（localhost 可用）
  try {
    const meta = await brandBle.scanAndConnect()
    localV2.value = { id: meta.id, name: meta.name, connected: true }
    brandBle.onBattery((value) => {
      if (localV2.value) localV2.value.battery = value
    })
    ElMessage.success('蓝牙体感设备（直连版）已连接（网页直连）')
    await refreshConnected()
  } catch (e: any) {
    ElMessage.error(e?.message || '连接失败')
  }
}

function pickV2(c: BrandBleCandidate) {
  brandBle.selectDevice(c.id)
}

async function cancelV2Scan() {
  v2Candidates.value = []
  try { await brandBle.cancelSelection() } catch (_) {}
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
      host: ycyBridgeHost.value,
      port: ycyBridgePort.value,
    })
    ElMessage.success('遥控蓝牙设备（桥接）已连接')
    await refreshConnected()
  } catch (e: any) {
    ElMessage.error(e?.message || '连接失败')
  } finally {
    busy.value = false
  }
}

async function scanYcyBle() {
  scanningBle.value = true
  try {
    const res = await brandsApi.discover('ycy', { mode: 'ble', timeoutMs: 5000 })
    bleCandidates.value = res.devices
    if (!res.devices.length) ElMessage.info('未发现遥控蓝牙设备')
  } catch (e: any) {
    ElMessage.error(e?.message || '扫描失败（可能需要 noble 蓝牙依赖）')
  } finally {
    scanningBle.value = false
  }
}

async function connectYcyBle(c: DiscoverCandidate) {
  busy.value = true
  try {
    await brandsApi.connect({
      brand: 'ycy',
      mode: 'ble',
      deviceId: c.deviceId,
      name: c.suggestedName,
    })
    ElMessage.success('遥控蓝牙设备（BLE）已连接')
    await refreshConnected()
  } catch (e: any) {
    ElMessage.error(e?.message || '连接失败')
  } finally {
    busy.value = false
  }
}

async function dglabApply(dev: BrandDevice) {
  const s = ctl(dev)
  await withLoading(`dglabApply:${dev.deviceId}`, async () => {
    await brandsApi.control(dev.deviceId, 'setPattern', { pattern: s.pattern, intensity: s.intensity, ticks: s.ticks })
    ElMessage.success('已下发波形')
  }).catch((e: any) => { ElMessage.error(e?.message || '下发失败') })
}

async function dglabStop(dev: BrandDevice) {
  await withLoading(`dglabStop:${dev.deviceId}`, async () => {
    await brandsApi.control(dev.deviceId, 'stop')
  }).catch((e: any) => { ElMessage.error(e?.message || '停止失败') })
}

async function dglabMaxPrompt(dev: BrandDevice) {
  await withLoading(`dglabMax:${dev.deviceId}`, async () => {
    await brandsApi.control(dev.deviceId, 'setMaxIntensity', { delta: 10 })
  }).catch((e: any) => { ElMessage.error(e?.message || '操作失败') })
}

const V2_STRENGTH_HW_MAX = 2047
async function dglabV2Apply(dev: BrandDevice) {
  const s = ctl(dev)
  const a = Math.round((s.v2AStrength / 100) * V2_STRENGTH_HW_MAX)
  const b = Math.round((s.v2BStrength / 100) * V2_STRENGTH_HW_MAX)
  await withLoading(`v2Apply:${dev.deviceId}`, async () => {
    if (window.brandBleApi) {
      // Electron 路径：经后端 REST → 主进程 IPC 下发
      await brandsApi.control(dev.deviceId, 'v2SetStrength', { a, b })
      await brandsApi.control(dev.deviceId, 'v2SetWaveform', { channel: 'A', x: s.v2Ax, y: s.v2Ay })
      await brandsApi.control(dev.deviceId, 'v2SetWaveform', { channel: 'B', x: s.v2Bx, y: s.v2By })
    } else {
      // 网页版：直接经浏览器原生 Web Bluetooth 写 GATT
      await brandBle.sendOps(brandBle.packStrengthOps(a, b))
      await brandBle.sendOps(brandBle.packWaveformOps('A', s.v2Ax, s.v2Ay))
      await brandBle.sendOps(brandBle.packWaveformOps('B', s.v2Bx, s.v2By))
    }
    ElMessage.success('已下发')
  }).catch((e: any) => { ElMessage.error(e?.message || '下发失败') })
}

async function dglabV2Stop(dev: BrandDevice) {
  await withLoading(`v2Stop:${dev.deviceId}`, async () => {
    if (window.brandBleApi) {
      await brandsApi.control(dev.deviceId, 'v2Stop')
    } else {
      await brandBle.sendOps(brandBle.packStrengthOps(0, 0))
    }
    ElMessage.success('已停止')
  }).catch((e: any) => { ElMessage.error(e?.message || '停止失败') })
}

async function dglabV2ReadBattery(dev: BrandDevice) {
  await withLoading(`v2Battery:${dev.deviceId}`, async () => {
    if (window.brandBleApi) {
      await brandsApi.control(dev.deviceId, 'v2ReadBattery')
    } else {
      await brandBle.sendOps([{ characteristic: 'battery', read: true }])
    }
    ElMessage.success('已请求读取电量')
  }).catch((e: any) => { ElMessage.error(e?.message || '读取失败') })
}

async function ycyTrigger(dev: BrandDevice) {
  const s = ctl(dev)
  if (!s.commandId) { ElMessage.warning('请填写指令 ID'); return }
  await withLoading(`ycyTrigger:${dev.deviceId}`, async () => {
    await brandsApi.control(dev.deviceId, 'trigger', { commandId: s.commandId })
  }).catch((e: any) => { ElMessage.error(e?.message || '触发失败') })
}

async function ycyStop(dev: BrandDevice) {
  await withLoading(`ycyStop:${dev.deviceId}`, async () => {
    await brandsApi.control(dev.deviceId, 'ycyStop')
  }).catch((e: any) => { ElMessage.error(e?.message || '停止失败') })
}

async function ycyEmsApply(dev: BrandDevice) {
  const s = ctl(dev)
  await withLoading(`ycyEms:${dev.deviceId}`, async () => {
    await brandsApi.control(dev.deviceId, 'setStrength', { channel: 'A', value: s.aStrength })
    await brandsApi.control(dev.deviceId, 'setStrength', { channel: 'B', value: s.bStrength })
    await brandsApi.control(dev.deviceId, 'setMode', { channel: 'A', mode: s.wave })
    ElMessage.success('已下发')
  }).catch((e: any) => { ElMessage.error(e?.message || '下发失败') })
}

async function ycyToyApply(dev: BrandDevice) {
  const s = ctl(dev)
  await withLoading(`ycyToy:${dev.deviceId}`, async () => {
    await brandsApi.control(dev.deviceId, 'setSpeed', { motor: 'A', speed: Math.round((s.speed / 100) * 20) })
    await brandsApi.control(dev.deviceId, 'setToyMode', { motor: 'A', mode: s.mode })
    ElMessage.success('已下发')
  }).catch((e: any) => { ElMessage.error(e?.message || '下发失败') })
}

async function disconnectDevice(dev: BrandDevice) {
  try {
    if (localV2.value && dev.deviceId === localV2.value.id) {
      await brandBle.disconnect(dev.deviceId)
      localV2.value = null
      ElMessage.success('已断开')
      return
    }
    await brandsApi.disconnect(dev.deviceId)
    ElMessage.success('已断开')
    await refreshConnected()
  } catch (e: any) { ElMessage.error(e?.message || '断开失败') }
}

// V2 强度位排布（标定用）：从后端读取并应用 localStorage 覆盖，切换时记忆
const V2_LAYOUT_KEY = 'dglab_v2_strength_layout'
async function loadV2Layout() {
  const saved = localStorage.getItem(V2_LAYOUT_KEY)
  if (saved === 'official' || saved === 'coyote2') v2Layout.value = saved
  try {
    const res = await brandsApi.getV2Layout()
    // 若本地选择未与服务端一致，以本地为准写回（标定期间以前端为准）
    if (v2Layout.value !== res.layout) {
      await brandsApi.setV2Layout(v2Layout.value)
    }
  } catch (_) { /* 后端不支持时静默，仍按本地值下发命令 */ }
}
async function onV2LayoutChange(layout: 'official' | 'coyote2') {
  localStorage.setItem(V2_LAYOUT_KEY, layout)
  try {
    await brandsApi.setV2Layout(layout)
    ElMessage.success(`V2 强度位排布已切换为 ${layout}`)
  } catch (e: any) {
    ElMessage.error(e?.message || '切换失败')
  }
}

onMounted(() => {
  refreshConnected()
  loadV2Layout()
  if (autoRefreshEnabled.value) startAutoRefresh()
})
onUnmounted(() => { stopAutoRefresh() })
</script>

<style scoped>
.brands-page { display: flex; flex-direction: column; gap: 16px; }
.page-header { display: flex; align-items: baseline; gap: 12px; }
.page-title { font-size: 18px; font-weight: 700; color: var(--text-primary); margin: 0; }
.page-sub { color: var(--text-muted); font-size: 13px; }
.section-card { background-color: var(--bg-card, var(--bg-app)); }
.card-header { display: flex; align-items: center; justify-content: space-between; }
.discover-row { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.addr-input { flex: 1; min-width: 200px; }
.type-select { width: 160px; }
.port-input { width: 110px; }
.hint { margin-bottom: 12px; }
.candidate-list { display: flex; flex-direction: column; gap: 8px; }
.candidate-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border: 1px solid var(--border-subtle); border-radius: 8px;
  background-color: var(--bg-app);
}
.candidate-info { display: flex; flex-direction: column; gap: 2px; }
.candidate-name { color: var(--text-primary); font-weight: 600; }
.candidate-meta { color: var(--text-muted); font-size: 12px; display: flex; align-items: center; gap: 6px; }
.device-card { border: 1px solid var(--border-subtle); border-radius: 10px; padding: 14px; margin-bottom: 12px; background-color: var(--bg-app); }
.device-card__head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.device-card__name { color: var(--text-primary); font-weight: 700; margin-right: 8px; }
.tag-brand { margin-right: 6px; }
.control-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; align-items: end; }
.control-field { display: flex; flex-direction: column; gap: 6px; }
.control-field label { color: var(--text-muted); font-size: 12px; }
.control-input { width: 100%; }
.control-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.control-hint { grid-column: 1 / -1; color: var(--text-muted); font-size: 12px; }
.control-hint code { background: rgba(255,255,255,0.06); padding: 1px 5px; border-radius: 4px; }
</style>
