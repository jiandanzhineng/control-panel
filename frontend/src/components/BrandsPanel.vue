<template>
  <div class="brands-page">
    <el-card shadow="never" class="stats-card stats-card--compact">
      <div class="stats-row">
        <span class="stat-mini">{{ t('brands.devices', { n: totalCount }) }}</span>
        <span class="stat-mini online-stat">{{ t('brands.online', { n: onlineCount }) }}</span>
        <span class="stat-mini offline-stat">{{ t('brands.offline', { n: offlineCount }) }}</span>
        <div class="stats-actions">
          <el-checkbox v-model="autoRefreshEnabled" @change="(v: any) => v ? startAutoRefresh() : stopAutoRefresh()">{{ t('brands.autoRefresh') }}</el-checkbox>
          <el-button size="small" :icon="Refresh" :loading="refreshing" @click="refreshConnected">{{ t('common.refresh') }}</el-button>
        </div>
      </div>
    </el-card>

    <el-tabs v-model="pageTab" class="brand-tabs">
      <el-tab-pane :label="t('brands.connect')" name="connect">
        <el-card shadow="never" class="section-card">
          <div class="connect-bar">
            <el-button type="primary" :loading="scanningWebble || scanningYcyWebble" @click="startBleConnect">
              {{ t('brands.bleConnect') }}
            </el-button>
            <el-dropdown trigger="click" @command="openMoreConnect">
              <el-button>
                {{ t('brands.moreWays') }}
                <el-icon class="el-icon--right"><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="native">{{ t('brands.native') }}</el-dropdown-item>
                  <el-dropdown-item command="dglab-phone">{{ t('brands.dglabPhone') }}</el-dropdown-item>
                  <el-dropdown-item command="ycy-bridge">{{ t('brands.ycyRemote') }}</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-button v-if="scanningWebble || scanningYcyWebble" size="small" @click="cancelBleScan">{{ t('brands.cancelScan') }}</el-button>
            <el-checkbox v-model="bleAutoConnect" @change="onBleAutoConnectChange">{{ t('brands.autoSaved') }}</el-checkbox>
            <el-checkbox v-model="bleAutoConnectAll" @change="onBleAutoConnectAllChange">{{ t('brands.autoAll') }}</el-checkbox>
          </div>
          <p class="op-hint">{{ t('brands.autoHint') }}</p>
        </el-card>

        <div v-if="ycyWebbleCandidates.length" class="candidate-list">
          <div v-for="c in ycyWebbleCandidates" :key="c.id" class="candidate-item">
            <div class="candidate-info">
              <span class="candidate-name">{{ brandLabel(classifyBleBrand(c.name), c.name) }}</span>
              <span class="candidate-meta">{{ BRAND_LABEL[classifyBleBrand(c.name)] || t('brands.ycy') }} · {{ c.name }}</span>
            </div>
            <el-button size="small" type="primary" @click="ycyWebblePick(c)">{{ t('brands.select') }}</el-button>
          </div>
        </div>

        <div class="brand-col__devices">
          <div v-if="!allConnected.length" class="brand-col__empty">{{ t('brands.empty') }}</div>
          <div v-for="dev in allConnected" :key="dev.deviceId" class="device-card">
            <div class="device-card__head">
              <div>
                <span class="device-card__name">{{ brandLabel(dev.brand, dev.name) }}</span>
                <el-tag size="small" class="tag-brand">{{ BRAND_LABEL[dev.brand] || dev.brand }}</el-tag>
                <el-tag v-if="dev.type" size="small" type="warning">{{ TYPE_LABEL[dev.type] || ycyPanelType(dev) }}</el-tag>
              </div>
              <el-button size="small" :icon="Close" @click="disconnectDevice(dev)">{{ t('brands.disconnect') }}</el-button>
            </div>
            <div v-if="dev.brand === 'dglab'" class="control-grid">
              <div class="control-field">
                <label>{{ t('brands.intensity', { n: ctl(dev).intensity }) }}</label>
                <el-slider v-model="ctl(dev).intensity" :min="0" :max="100" />
              </div>
              <div class="control-actions">
                <el-button type="primary" size="small" :loading="opLoading[`dglabApply:${dev.deviceId}`]" @click="dglabApply(dev)">{{ t('brands.apply') }}</el-button>
                <el-button size="small" :loading="opLoading[`dglabStop:${dev.deviceId}`]" @click="dglabStop(dev)">{{ t('brands.stop') }}</el-button>
              </div>
            </div>
            <div v-else-if="ycyPanelType(dev) === 'SOSEXY_PID0004'" class="control-stack">
              <div class="control-row">
                <div class="control-field"><label>{{ t('brands.totalStrength', { n: ctl(dev).sosexyStrength }) }}</label><el-slider v-model="ctl(dev).sosexyStrength" :min="0" :max="255" /></div>
                <div class="control-actions"><el-button type="primary" size="small" :loading="opLoading[`sosexyStrength:${dev.deviceId}`]" @click="sosexyStrengthApply(dev)">{{ t('brands.vibeSuck') }}</el-button></div>
              </div>
              <div class="control-row">
                <div class="control-field"><label>{{ t('brands.vibration', { n: ctl(dev).sosexyVibration }) }}</label><el-slider v-model="ctl(dev).sosexyVibration" :min="0" :max="100" /></div>
                <div class="control-actions"><el-button size="small" :loading="opLoading[`sosexyVibration:${dev.deviceId}`]" @click="sosexyVibrationApply(dev)">{{ t('brands.applyVibe') }}</el-button></div>
              </div>
              <div class="control-row">
                <div class="control-field"><label>{{ t('brands.suction', { n: ctl(dev).sosexySuction }) }}</label><el-slider v-model="ctl(dev).sosexySuction" :min="0" :max="100" /></div>
                <div class="control-actions"><el-button size="small" :loading="opLoading[`sosexySuction:${dev.deviceId}`]" @click="sosexySuctionApply(dev)">{{ t('brands.applySuck') }}</el-button></div>
              </div>
              <div class="control-row">
                <div class="control-field"><label>{{ t('brands.shock', { n: ctl(dev).sosexyShock }) }}</label><el-slider v-model="ctl(dev).sosexyShock" :min="0" :max="100" /></div>
                <div class="control-actions">
                  <el-button type="danger" size="small" :loading="opLoading[`sosexyShock:${dev.deviceId}`]" @click="sosexyShockApply(dev)">{{ t('brands.applyShock') }}</el-button>
                  <el-button size="small" :loading="opLoading[`sosexyQuery:${dev.deviceId}`]" @click="sosexyQuery(dev)">{{ t('brands.query') }}</el-button>
                  <el-button size="small" :loading="opLoading[`sosexyStop:${dev.deviceId}`]" @click="sosexyStop(dev)">{{ t('brands.stopAll') }}</el-button>
                </div>
              </div>
            </div>
            <div v-else-if="ycyPanelType(dev) === 'YCY_CUP'" class="control-grid">
              <div class="control-field"><label>{{ t('brands.rotate', { n: ctl(dev).stroke }) }}</label><el-slider v-model="ctl(dev).stroke" :min="0" :max="255" /></div>
              <div class="control-field"><label>{{ t('brands.vibe', { n: ctl(dev).vibe }) }}</label><el-slider v-model="ctl(dev).vibe" :min="0" :max="255" /></div>
              <div class="control-field"><label>{{ t('brands.axis', { n: ctl(dev).axis }) }}</label><el-slider v-model="ctl(dev).axis" :min="0" :max="255" /></div>
              <div class="control-actions">
                <el-button type="primary" size="small" :loading="opLoading[`ycyFjb:${dev.deviceId}`]" @click="ycyFjbApply(dev)">{{ t('brands.apply') }}</el-button>
                <el-button size="small" :loading="opLoading[`ycyStop:${dev.deviceId}`]" @click="ycyFjbStop(dev)">{{ t('brands.stop') }}</el-button>
              </div>
            </div>
            <div v-else-if="ycyPanelType(dev) === 'YCY_EMS'" class="control-grid">
              <div class="control-field"><label>{{ t('brands.left', { n: ctl(dev).aStrength }) }}</label><el-slider v-model="ctl(dev).aStrength" :min="0" :max="255" /></div>
              <div class="control-field"><label>{{ t('brands.right', { n: ctl(dev).bStrength }) }}</label><el-slider v-model="ctl(dev).bStrength" :min="0" :max="255" /></div>
              <div class="control-actions">
                <el-button type="primary" size="small" :loading="opLoading[`ycyEms:${dev.deviceId}`]" @click="ycyEmsApply(dev)">{{ t('brands.apply') }}</el-button>
                <el-button size="small" :loading="opLoading[`ycyStop:${dev.deviceId}`]" @click="ycyStop(dev)">{{ t('brands.stop') }}</el-button>
              </div>
            </div>
            <div v-else-if="ycyPanelType(dev) === 'YCY_TOY'" class="control-grid">
              <div class="control-field"><label>{{ t('brands.speed', { n: ctl(dev).speed }) }}</label><el-slider v-model="ctl(dev).speed" :min="0" :max="255" /></div>
              <div class="control-actions">
                <el-button type="primary" size="small" :loading="opLoading[`ycyToy:${dev.deviceId}`]" @click="ycyToyApply(dev)">{{ t('brands.apply') }}</el-button>
                <el-button size="small" :loading="opLoading[`ycyStop:${dev.deviceId}`]" @click="ycyStop(dev)">{{ t('brands.stop') }}</el-button>
              </div>
            </div>
            <div v-else-if="ycyPanelType(dev) === 'YCY_ENEMA'" class="control-grid">
              <div class="control-actions">
                <el-button type="primary" size="small" :loading="opLoading[`ycyPump:${dev.deviceId}`]" @click="ycyPumpApply(dev)">{{ t('brands.startPump') }}</el-button>
                <el-button size="small" :loading="opLoading[`ycyPumpS:${dev.deviceId}`]" @click="ycyPumpStop(dev)">{{ t('brands.stop') }}</el-button>
              </div>
            </div>
            <div v-else-if="dev.mode === 'bridge'" class="control-grid">
              <div class="control-field"><label>{{ t('brands.playId') }}</label><el-input v-model="ctl(dev).commandId" size="small" /></div>
              <div class="control-actions">
                <el-button type="primary" size="small" @click="ycyTrigger(dev)">{{ t('brands.trigger') }}</el-button>
                <el-button size="small" @click="ycyStop(dev)">{{ t('brands.stop') }}</el-button>
              </div>
            </div>
          </div>
        </div>

      </el-tab-pane>

      <el-tab-pane :label="t('brands.support')" name="support">
        <el-card shadow="never" class="section-card">
          <h3 class="support-h">{{ t('brands.tested') }}</h3>
          <ul class="support-list">
            <li v-for="item in testedDevices" :key="item">{{ item }}</li>
          </ul>
          <h3 class="support-h">{{ t('brands.theoretical') }}</h3>
          <ul class="support-list">
            <li v-for="item in theoreticalDevices" :key="item">{{ item }}</li>
          </ul>
          <p class="op-hint">{{ t('brands.moreSupport') }}</p>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="moreOpen" :title="moreTitle" width="560px" class="add-dialog">
      <template v-if="moreKind === 'native'">
        <p class="op-hint">{{ t('brands.nativeHint') }}</p>
        <template v-if="isMac">
          <h4>{{ t('brands.dglab') }}</h4>
          <div class="discover-row">
            <el-tag :type="dglabNativeSummary.type" size="small">{{ dglabNativeSummary.text }}</el-tag>
            <el-button type="primary" size="small" :loading="busy" :disabled="!dglabNativeDevices.length" @click="dglabNativeConnectAll">{{ t('brands.connectAll') }}</el-button>
            <el-button size="small" :loading="busy" @click="dglabNativeRescan">{{ t('brands.rescan') }}</el-button>
          </div>
          <h4>{{ t('brands.ycy') }}</h4>
          <div class="discover-row">
            <el-tag :type="ycyNativeSummary.type" size="small">{{ ycyNativeSummary.text }}</el-tag>
            <el-button type="primary" size="small" :loading="busy" :disabled="!ycyNativeDevices.length" @click="ycyNativeConnectAll">{{ t('brands.connectAll') }}</el-button>
            <el-button size="small" :loading="busy" @click="ycyNativeRescan">{{ t('brands.rescan') }}</el-button>
          </div>
        </template>
        <el-alert v-else type="info" :closable="false" :title="t('brands.notMac')" />
      </template>
      <template v-else-if="moreKind === 'dglab-phone'">
        <div class="discover-row">
          <el-input v-model="dglabHost" :placeholder="t('brands.phoneAddr')" class="addr-input" />
          <el-input v-model="dglabPort" :placeholder="t('brands.port')" class="port-input" />
          <el-button type="primary" :loading="scanningDglab" @click="discoverDglab">{{ t('brands.probe') }}</el-button>
        </div>
        <p class="op-hint">{{ t('brands.phoneHint') }}</p>
        <div v-for="c in dglabCandidates" :key="c.suggestedDeviceId" class="candidate-item">
          <span class="candidate-name">{{ c.host }}:{{ c.port }}</span>
          <el-button size="small" type="primary" :disabled="!c.reachable || busy" @click="connectDglab(c)">{{ t('brands.connectBtn') }}</el-button>
        </div>
      </template>
      <template v-else-if="moreKind === 'ycy-bridge'">
        <div class="discover-row">
          <el-input v-model="ycyBridgeCode" :placeholder="t('brands.codePlaceholder')" class="addr-input" />
        </div>
        <div class="discover-row">
          <el-select v-model="ycyBridgeType" size="small" class="type-select">
            <el-option :label="t('brands.ems')" value="YCY_EMS" />
            <el-option :label="t('brands.toy')" value="YCY_TOY" />
            <el-option :label="t('brands.cup')" value="YCY_CUP" />
            <el-option :label="t('brands.enema')" value="YCY_ENEMA" />
          </el-select>
        </div>
        <div class="discover-row">
          <el-input v-model="ycyBridgeHost" :placeholder="t('brands.bridgeHost')" class="addr-input" />
          <el-input v-model="ycyBridgePort" :placeholder="t('brands.port')" class="port-input" />
          <el-button type="primary" :loading="busy" @click="connectYcyBridge">{{ t('brands.connectBtn') }}</el-button>
        </div>
      </template>
    </el-dialog>

  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { Refresh, Close, ArrowDown } from '@element-plus/icons-vue'
import * as brandsApi from '../api/brands'
import * as devicesApi from '../api/devices'
import * as ycyBridge from '../api/ycyBridge'
import type { BrandDevice, DiscoverCandidate } from '../api/brands'
import type { YcyBridgeDevice } from '../api/ycyBridge'
import * as dglabBridge from '../api/dglabBridge'
import type { DglabBridgeDevice } from '../api/dglabBridge'
import * as brandBle from '../web-ble/brandBle'
import * as ycyBle from '../web-ble/ycyBle'

const { t, tm } = useI18n()

const BRAND_LABEL = computed<Record<string, string>>(() => ({
  dglab: t('brands.brandDglab'),
  ycy: t('brands.brandYcy'),
  sosexy: t('brands.brandSosexy'),
}))
const TYPE_LABEL = computed<Record<string, string>>(() => ({
  DGLAB: t('brands.typeDglab'),
  DGLAB_V2: t('brands.typeDglabV2'),
  YCY_EMS: t('brands.typeEms'),
  YCY_TOY: t('brands.typeToy'),
  YCY_CUP: t('brands.typeCup'),
  YCY_ENEMA: t('brands.typeEnema'),
  SOSEXY_PID0004: t('brands.typeBobobei'),
}))

// 设备名映射为友好中文名（仅显示层，不改连接/电量逻辑）
function brandLabel(brand: string, rawName?: string | null): string {
  const name = (rawName || '').trim()
  const up = name.toUpperCase()
  if (brand === 'dglab') {
    if (up.startsWith('D-LAB') || up.startsWith('DG-LAB')) return t('brands.dglab20')
    if (up.startsWith('47L')) return t('brands.dglab30')
    return name || t('brands.dglab')
  }
  if (brand === 'sosexy') return t('brands.bobobei')
  if (brand === 'ycy') {
    if (/FJB/i.test(name)) return t('brands.cup')
    if (/(YISK|灌肠|ENEMA|GLJ|GLS)/i.test(name)) return t('brands.enema')
    if (/DJ/i.test(name)) return t('brands.typeEms')
    if (/(YSKJ|YOKO|YOKONEX|YCY|YYC|YICIYUAN)/i.test(name)) return t('brands.ycyDevice')
    return t('brands.ycyHost')
  }
  return name || brand
}

function ycyTypeLabel(rawName?: string | null): string {
  const n = rawName || ''
  if (/FJB/i.test(n)) return t('brands.cup')
  if (/(YISK|灌肠|ENEMA|GLJ|GLS)/i.test(n)) return t('brands.enema')
  if (/DJ/i.test(n)) return t('brands.typeEms')
  if (/(YSKJ|YOKO|YOKONEX|YCY|YYC|YICIYUAN)/i.test(n)) return t('brands.ycyDevice')
  return t('brands.ycyHostShort')
}

const activeBrand = ref<'dglab' | 'ycy'>('dglab')
const pageTab = ref<'connect' | 'support'>('connect')
const moreOpen = ref(false)
const moreKind = ref<'native' | 'dglab-phone' | 'ycy-bridge'>('native')
const moreTitle = computed(() => {
  if (moreKind.value === 'native') return t('brands.native')
  if (moreKind.value === 'dglab-phone') return t('brands.dglabPhone')
  return t('brands.ycyRemote')
})
const testedDevices = computed(() => {
  const v = tm('brands.testedList')
  return Array.isArray(v) ? (v as string[]) : []
})
const theoreticalDevices = computed(() => {
  const v = tm('brands.theoreticalList')
  return Array.isArray(v) ? (v as string[]) : []
})
const busy = ref(false)
const refreshing = ref(false)
const bleAutoConnect = ref(true)
const bleAutoConnectAll = ref(true)

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
  if (!webbleSupported.value) return { type: 'warning' as const, text: t('brands.unsupportedBrowser') }
  const n = dglabWebbleDevices.value.length
  return { type: (n ? 'success' : 'info') as const, text: n ? t('brands.connectedCount', { n }) : t('brands.waitingConnect') }
})
const dglabWebbleCandidates = ref<Array<{ id: string; name: string }>>([])
let dglabScanUnsub: (() => void) | null = null
function dglabWebbleCancelScan() {
  brandBle.cancelSelection().catch(() => {})
}
async function dglabWebblePick(c: { id: string; name: string }) {
  try { await brandBle.selectDevice(c.id) } catch (e: any) { ElMessage.error(e?.message || t('brands.selectFailed')) }
}
async function dglabWebbleConnect() {
  if (!webbleSupported.value) { ElMessage.warning(t('brands.webbleUnsupported')); return }
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
    ElMessage.success(t('brands.connectedNamed', { name: brandLabel('dglab', meta.name) }))
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (!/cancel|Cancelled|User cancelled|NavigatorUserAgent/i.test(msg)) ElMessage.error(msg || t('brands.connectFailed'))
  } finally {
    dglabScanUnsub?.(); dglabScanUnsub = null
    dglabWebbleCandidates.value = []
    scanningWebble.value = false
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
const addRemoteLabel = computed(() => (addBrand.value === 'dglab' ? t('brands.dglabPhone') : t('brands.ycyRemote')))
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

function ycyPanelType(dev: { type?: string; name?: string }) {
  if (dev.type && TYPE_LABEL.value[dev.type]) return dev.type
  const n = String(dev.name || '')
  if (/SOSEXY|啵啵贝/i.test(n)) return 'SOSEXY_PID0004'
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
      commandId: '', aStrength: 102, bStrength: 102, wave: 1,
      speed: 153, mode: 1, stroke: 96, vibe: 0, axis: 0, scene: 'guan',
      sosexyStrength: 0, sosexyVibration: 0, sosexySuction: 0, sosexyShock: 0,
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
  if (!dglabHost.value) { ElMessage.warning(t('brands.fillPhoneAddr')); return }
  scanningDglab.value = true
  try {
    const res = await brandsApi.discover('dglab', { host: dglabHost.value, port: dglabPort.value })
    dglabCandidates.value = res.devices
  } catch (e: any) {
    ElMessage.error(e?.message || t('brands.probeFailed'))
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
    ElMessage.success(t('brands.dglabConnected'))
    await refreshConnected()
  } catch (e: any) {
    ElMessage.error(e?.message || t('brands.connectFailed'))
  } finally {
    busy.value = false
  }
}

// ===== 郊狼 本机直连（原生桥 dglab_bridge :3002，仅 macOS 回退用） =====
const dglabNativeSummary = computed(() => {
  // 桥未连接：是进程没跑（浏览器开发 / 客户端未拉起），不是蓝牙关了
  if (!dglabBridgeUp.value) return { type: 'warning' as const, text: t('brands.nativeDown') }
  const total = dglabNativeDevices.value.length
  const connected = dglabNativeDevices.value.filter((d) => d.ready).length
  if (total === 0) return { type: 'info' as const, text: dglabNativeBtOn.value ? t('brands.searching') : t('brands.btOff') }
  return { type: (connected === total ? 'success' : 'warning') as const, text: t('brands.connectedRatio', { connected, total }) }
})
const dglabNativeBtHint = computed(() => {
  if (!dglabBridgeUp.value) return t('brands.nativeNotRunning')
  return dglabNativeBtOn.value ? t('brands.searchingDglab') : t('brands.btOffHint')
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
    await brandsApi.connect({
      brand: 'dglab', mode: 'native', address: d.id, name: d.name,
      port: 3002,
    })
    ElMessage.success(t('brands.connectStarted'))
    await dglabNativeRefresh()
  } catch (e: any) {
    ElMessage.error(e?.message || t('brands.connectFailed'))
  } finally {
    busy.value = false
  }
}
async function dglabNativeDisconnect(d: DglabBridgeDevice) {
  busy.value = true
  try {
    try { await brandsApi.disconnect(brandsApi.macDeviceId(d.id)) } catch (_) {}
    if (!dglabNativeManual.value.includes(d.id)) dglabNativeManual.value.push(d.id)
    dglabNativeEver.value = dglabNativeEver.value.filter((x) => x !== d.id)
    ElMessage.success(t('brands.disconnectedOk'))
    await dglabNativeRefresh()
  } catch (e: any) {
    ElMessage.error(e?.message || t('brands.disconnectFailed'))
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
    ElMessage.info(t('brands.connectAllStarted'))
    await dglabNativeRefresh()
  } catch (e: any) {
    ElMessage.error(e?.message || t('brands.connectFailed'))
  } finally {
    busy.value = false
  }
}
async function dglabNativeRescan() {
  busy.value = true
  try {
    dglabNativeManual.value = []
    await dglabBridge.rescan()
    ElMessage.info(t('brands.rescanned'))
    await dglabNativeRefresh()
  } catch (e: any) {
    ElMessage.error(e?.message || t('brands.scanFailed'))
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
  if (!ycyBridgeCode.value) { ElMessage.warning(t('brands.fillCode')); return }
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
    ElMessage.success(t('brands.ycyRemoteConnected'))
    await refreshConnected()
  } catch (e: any) {
    ElMessage.error(e?.message || t('brands.connectFailed'))
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
  if (!ycyBridgeUp.value) return { type: 'warning' as const, text: t('brands.nativeDown') }
  const total = ycyNativeDevices.value.length
  const connected = ycyNativeDevices.value.filter((d) => d.ready).length
  if (total === 0) return { type: 'info' as const, text: ycyNativeBtOn.value ? t('brands.searching') : t('brands.btOff') }
  return { type: (connected === total ? 'success' : 'warning') as const, text: t('brands.connectedRatio', { connected, total }) }
})
const ycyNativeBtHint = computed(() => {
  if (!ycyBridgeUp.value) return t('brands.nativeNotRunning')
  return ycyNativeBtOn.value ? t('brands.searchingYcy') : t('brands.btOffHint')
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
    await brandsApi.connect({
      brand: 'ycy', mode: 'native', address: d.id, name: d.name,
      port: 3001,
      type: ycyPanelType({ name: d.name }),
    })
    ElMessage.success(t('brands.connectStarted'))
    await ycyNativeRefresh()
  } catch (e: any) {
    ElMessage.error(e?.message || t('brands.connectFailed'))
  } finally {
    busy.value = false
  }
}
async function ycyNativeDisconnect(d: YcyBridgeDevice) {
  busy.value = true
  try {
    try { await brandsApi.disconnect(brandsApi.macDeviceId(d.id)) } catch (_) {}
    if (!ycyNativeManual.value.includes(d.id)) ycyNativeManual.value.push(d.id)
    ycyNativeEver.value = ycyNativeEver.value.filter((x) => x !== d.id)
    ElMessage.success(t('brands.disconnectedOk'))
    await ycyNativeRefresh()
  } catch (e: any) {
    ElMessage.error(e?.message || t('brands.disconnectFailed'))
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
    ElMessage.info(t('brands.connectAllStarted'))
    await ycyNativeRefresh()
  } catch (e: any) {
    ElMessage.error(e?.message || t('brands.connectFailed'))
  } finally {
    busy.value = false
  }
}
async function ycyNativeRescan() {
  busy.value = true
  try {
    ycyNativeManual.value = []
    await ycyBridge.rescan()
    ElMessage.info(t('brands.rescanned'))
    await ycyNativeRefresh()
  } catch (e: any) {
    ElMessage.error(e?.message || t('brands.scanFailed'))
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
const ycyWebbleCandidates = ref<Array<{ id: string; name: string; address?: string; deviceId?: string; brand?: string }>>([])
let ycyScanUnsub: (() => void) | null = null
const scanningYcyWebble = ref(false)
function ycyWebbleCancelScan() {
  brandBle.cancelSelection().catch(() => {})
}
function classifyBleBrand(name?: string): 'dglab' | 'ycy' | 'sosexy' {
  const n = String(name || '').toUpperCase()
  if (['D-LAB', 'DG-LAB', 'COYOTE', '47L', 'ESTIM'].some((k) => n.includes(k))) return 'dglab'
  if (n.includes('SOSEXY') || name?.includes('啵啵贝') || name?.includes('繁野')) return 'sosexy'
  return 'ycy'
}
function cancelBleScan() {
  dglabWebbleCancelScan()
  ycyWebbleCancelScan()
}
async function startBleConnect() {
  scanningYcyWebble.value = true
  ycyWebbleCandidates.value = []
  try {
    const [y, d, s] = await Promise.all([
      brandsApi.discover('ycy', { mode: 'native' }),
      brandsApi.discover('dglab', { mode: 'native' }),
      brandsApi.discover('sosexy', { mode: 'native' }),
    ])
    const list = [...(y.devices || []), ...(d.devices || []), ...(s.devices || [])]
    ycyWebbleCandidates.value = list.map((c) => ({
      id: c.address || c.deviceId || '',
      name: c.name || c.suggestedName || '',
      address: c.address,
      deviceId: c.deviceId,
      brand: c.brand,
    }))
    if (!list.length) ElMessage.info(t('brands.noNearby'))
  } catch (e: any) {
    ElMessage.error(e?.message || t('brands.scanFailed'))
  } finally {
    scanningYcyWebble.value = false
  }
}
function openMoreConnect(kind: string | number) {
  moreKind.value = kind as 'native' | 'dglab-phone' | 'ycy-bridge'
  moreOpen.value = true
  if (kind === 'native' && isMac.value) {
    dglabNativeRescan()
    ycyNativeRescan()
  }
}
async function ycyWebblePick(c: { id: string; name: string; address?: string; deviceId?: string; brand?: string }) {
  try {
    const brand = classifyBleBrand(c.name)
    await brandsApi.connect({
      brand,
      mode: 'native',
      address: c.address || c.id,
      name: c.name,
      deviceId: c.deviceId,
      ...(brand === 'dglab' ? {} : { type: ycyPanelType({ name: c.name }) }),
    })
    ycyWebbleCandidates.value = []
    await refreshConnected()
    ElMessage.success(t('brands.connectedNamed', { name: brandLabel(brand, c.name) }))
  } catch (e: any) { ElMessage.error(e?.message || t('brands.connectFailed')) }
}
const ycyWebbleUnlisten = new Map<string, () => void>()
const ycyWebbleHint = computed(() => {
  if (!webbleSupported.value) return { type: 'warning' as const, text: t('brands.unsupportedBrowser') }
  const n = ycyWebbleDevices.value.length
  return { type: (n ? 'success' : 'info') as const, text: n ? t('brands.connectedCount', { n }) : t('brands.waitingConnect') }
})
async function ycyWebbleConnect() {
  if (!webbleSupported.value) { ElMessage.warning(t('brands.webbleUnsupported')); return }
  scanningYcyWebble.value = true
  ycyWebbleCandidates.value = []
  ycyScanUnsub = brandBle.onScanResults((list) => { ycyWebbleCandidates.value = list })
  try {
    if (window.ycyBleApi?.isSupported()) {
      const meta = await window.ycyBleApi.connect()
      await refreshConnected()
      ElMessage.success(t('brands.connectedNamed', { name: brandLabel('ycy', meta.name) }))
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
    ElMessage.success(t('brands.connectedNamed', { name: brandLabel('ycy', meta.name) }))
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (!/cancel|Cancelled|User cancelled|NavigatorUserAgent/i.test(msg)) ElMessage.error(msg || t('brands.connectFailed'))
  } finally {
    ycyScanUnsub?.(); ycyScanUnsub = null
    ycyWebbleCandidates.value = []
    scanningYcyWebble.value = false
  }
}
async function dglabApply(dev: BrandDevice) {
  const s = ctl(dev)
  await withLoading(`dglabApply:${dev.deviceId}`, async () => {
    await devicesApi.invokeCapability(dev.deviceId, 'shock', 'start', { voltage: s.intensity })
    ElMessage.success(t('brands.sent'))
  }).catch((e: any) => { ElMessage.error(e?.message || t('brands.sendFailed')) })
}

async function dglabStop(dev: BrandDevice) {
  await withLoading(`dglabStop:${dev.deviceId}`, async () => {
    await devicesApi.invokeCapability(dev.deviceId, 'shock', 'stop', {})
  }).catch((e: any) => { ElMessage.error(e?.message || t('brands.stopFailed')) })
}

async function ycyTrigger(dev: BrandDevice) {
  const s = ctl(dev)
  if (!s.commandId) { ElMessage.warning(t('brands.fillPlayId')); return }
  await withLoading(`ycyTrigger:${dev.deviceId}`, async () => {
    await devicesApi.executeDeviceOperation(dev.deviceId, 'trigger', { commandId: s.commandId })
  }).catch((e: any) => { ElMessage.error(e?.message || t('brands.triggerFailed')) })
}

async function ycyStop(dev: BrandDevice) {
  await withLoading(`ycyStop:${dev.deviceId}`, async () => {
    const type = ycyPanelType(dev)
    if (type === 'SOSEXY_PID0004') await devicesApi.executeDeviceOperation(dev.deviceId, 'stop', {})
    else if (type === 'YCY_TOY') await devicesApi.invokeCapability(dev.deviceId, 'strength', 'stop', {})
    else if (dev.mode === 'bridge') await devicesApi.executeDeviceOperation(dev.deviceId, 'stop', {})
    else await devicesApi.invokeCapability(dev.deviceId, 'estim', 'stop', {})
    ElMessage.success(t('brands.stopped'))
  }).catch((e: any) => { ElMessage.error(e?.message || t('brands.stopFailed')) })
}

async function sosexyStrengthApply(dev: BrandDevice) {
  await withLoading(`sosexyStrength:${dev.deviceId}`, async () => {
    await devicesApi.invokeCapability(dev.deviceId, 'strength', 'set', { value: ctl(dev).sosexyStrength })
    ElMessage.success(t('brands.sent'))
  }).catch((e: any) => { ElMessage.error(e?.message || t('brands.sendFailed')) })
}
async function sosexyVibrationApply(dev: BrandDevice) {
  await withLoading(`sosexyVibration:${dev.deviceId}`, async () => {
    await devicesApi.invokeCapability(dev.deviceId, 'vibration', 'set', { value: ctl(dev).sosexyVibration })
    ElMessage.success(t('brands.sent'))
  }).catch((e: any) => { ElMessage.error(e?.message || t('brands.sendFailed')) })
}
async function sosexySuctionApply(dev: BrandDevice) {
  await withLoading(`sosexySuction:${dev.deviceId}`, async () => {
    await devicesApi.invokeCapability(dev.deviceId, 'suction', 'set', { value: ctl(dev).sosexySuction })
    ElMessage.success(t('brands.sent'))
  }).catch((e: any) => { ElMessage.error(e?.message || t('brands.sendFailed')) })
}
async function sosexyShockApply(dev: BrandDevice) {
  await withLoading(`sosexyShock:${dev.deviceId}`, async () => {
    await devicesApi.invokeCapability(dev.deviceId, 'shock', 'start', { voltage: ctl(dev).sosexyShock })
    ElMessage.success(t('brands.sent'))
  }).catch((e: any) => { ElMessage.error(e?.message || t('brands.sendFailed')) })
}
async function sosexyStop(dev: BrandDevice) {
  await withLoading(`sosexyStop:${dev.deviceId}`, async () => {
    await devicesApi.executeDeviceOperation(dev.deviceId, 'stop', {})
    ElMessage.success(t('brands.stopped'))
  }).catch((e: any) => { ElMessage.error(e?.message || t('brands.stopFailed')) })
}
async function sosexyQuery(dev: BrandDevice) {
  await withLoading(`sosexyQuery:${dev.deviceId}`, async () => {
    await devicesApi.executeDeviceOperation(dev.deviceId, 'queryStatus', {})
    ElMessage.success(t('brands.statusRequested'))
  }).catch((e: any) => { ElMessage.error(e?.message || t('brands.queryFailed')) })
}

async function ycyEmsApply(dev: BrandDevice) {
  const s = ctl(dev)
  await withLoading(`ycyEms:${dev.deviceId}`, async () => {
    await devicesApi.invokeCapability(dev.deviceId, 'estim', 'set', { channel: 'A', intensity: s.aStrength, wave: s.wave })
    await devicesApi.invokeCapability(dev.deviceId, 'estim', 'set', { channel: 'B', intensity: s.bStrength, wave: s.wave })
    ElMessage.success(t('brands.sent'))
  }).catch((e: any) => { ElMessage.error(e?.message || t('brands.sendFailed')) })
}

async function ycyFjbApply(dev: BrandDevice) {
  const s = ctl(dev)
  await withLoading(`ycyFjb:${dev.deviceId}`, async () => {
    await devicesApi.invokeCapability(dev.deviceId, 'motors', 'set', {
      channels: {
        stroke: { value: s.stroke, direction: 1 },
        vibe: { value: s.vibe },
        axis: { value: s.axis },
      },
    })
    ElMessage.success(t('brands.sent'))
  }).catch((e: any) => { ElMessage.error(e?.message || t('brands.sendFailed')) })
}
async function ycyFjbStop(dev: BrandDevice) {
  await withLoading(`ycyStop:${dev.deviceId}`, async () => {
    await devicesApi.invokeCapability(dev.deviceId, 'motors', 'stop', {})
  }).catch((e: any) => { ElMessage.error(e?.message || t('brands.stopFailed')) })
}

async function ycyPumpApply(dev: BrandDevice) {
  const s = ctl(dev)
  await withLoading(`ycyPump:${dev.deviceId}`, async () => {
    await devicesApi.invokeCapability(dev.deviceId, 'pump', 'start', { scene: s.scene || 'guan' })
    ElMessage.success(t('brands.sent'))
  }).catch((e: any) => { ElMessage.error(e?.message || t('brands.sendFailed')) })
}
async function ycyPumpStop(dev: BrandDevice) {
  await withLoading(`ycyPumpS:${dev.deviceId}`, async () => {
    await devicesApi.invokeCapability(dev.deviceId, 'pump', 'stop', {})
  }).catch((e: any) => { ElMessage.error(e?.message || t('brands.stopFailed')) })
}
async function ycyToyApply(dev: BrandDevice) {
  const s = ctl(dev)
  await withLoading(`ycyToy:${dev.deviceId}`, async () => {
    await devicesApi.invokeCapability(dev.deviceId, 'strength', 'set', { value: s.speed })
    ElMessage.success(t('brands.sent'))
  }).catch((e: any) => { ElMessage.error(e?.message || t('brands.sendFailed')) })
}

async function disconnectDevice(dev: BrandDevice) {
  try {
    await brandsApi.disconnect(dev.deviceId)
    ElMessage.success(t('brands.disconnectedOk'))
    await refreshConnected()
  } catch (e: any) { ElMessage.error(e?.message || t('brands.disconnectFailed')) }
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

async function onBleAutoConnectChange(v: boolean | string | number) {
  bleAutoConnect.value = v === true
  try { await brandsApi.setSettings({ autoConnect: bleAutoConnect.value }) } catch (_) {}
}
async function onBleAutoConnectAllChange(v: boolean | string | number) {
  bleAutoConnectAll.value = v === true
  try { await brandsApi.setSettings({ autoConnectAll: bleAutoConnectAll.value }) } catch (_) {}
}
async function loadBleAutoConnect() {
  try {
    const s = await brandsApi.getSettings()
    bleAutoConnect.value = s.autoConnect !== false
    bleAutoConnectAll.value = s.autoConnectAll !== false
  } catch (_) {
    bleAutoConnect.value = true
    bleAutoConnectAll.value = true
  }
}

onMounted(() => {
  refreshConnected()
  if (autoRefreshEnabled.value) startAutoRefresh()
  if (isMac.value) startYcyNativeTimer()
  if (isMac.value) startDglabNativeTimer()
  probeBridgeAndPickDefault()
  loadBleAutoConnect()
})
onUnmounted(() => {
  stopAutoRefresh(); stopYcyNativeTimer(); stopDglabNativeTimer()
})
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
.device-card { border: 1px solid var(--border-subtle); border-radius: 10px; padding: 14px; background-color: var(--bg-app); min-width: 0; }
.device-card__head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; gap: 8px; flex-wrap: wrap; }
.device-card__name { color: var(--text-primary); font-weight: 700; margin-right: 8px; }
.tag-brand { margin-right: 6px; }
.control-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; align-items: end; }
.control-stack { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.control-row { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; min-width: 0; }
.control-row .control-field { flex: 1 1 180px; min-width: 0; }
.control-row .control-actions { flex: 0 1 auto; }
.control-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.control-field label { color: var(--text-muted); font-size: 12px; }
.control-field :deep(.el-slider) { width: 100%; min-width: 0; }
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
