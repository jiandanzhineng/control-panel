<template>
  <div class="brands-page">
    <div class="page-header">
      <h2 class="page-title">品牌设备</h2>
      <span class="page-sub">郊狼（DGLab）与役次元（YCY）设备的发现、连接与操控</span>
    </div>

    <el-tabs v-model="activeBrand" class="brand-tabs">
      <!-- ============ 郊狼 DGLab ============ -->
      <el-tab-pane label="郊狼 DGLab" name="dglab">
        <el-card shadow="never" class="section-card">
          <template #header>
            <div class="card-header">
              <span>发现与连接</span>
              <el-button
                size="small"
                :icon="Refresh"
                :loading="scanningDglab"
                @click="discoverDglab"
              >扫描</el-button>
            </div>
          </template>
          <div class="discover-row">
            <el-input v-model="dglabHost" placeholder="手机 IP（娱乐模式显示的地址）" class="addr-input" />
            <el-input v-model="dglabPort" placeholder="端口" class="port-input" />
            <el-button type="primary" :loading="scanningDglab" @click="discoverDglab">探测</el-button>
          </div>
          <el-alert
            class="hint"
            type="info"
            :closable="false"
            title="在 DG-Lab App 内开启「娱乐模式」后，会显示本机 IP 与端口（默认 60536）。填入后点击探测即可发现。"
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
        </el-card>
      </el-tab-pane>

      <!-- ============ 役次元 YCY ============ -->
      <el-tab-pane label="役次元 YCY" name="ycy">
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
              <el-input v-model="ycyBridgeHost" placeholder="桥接服务 IP" class="addr-input" />
              <el-input v-model="ycyBridgePort" placeholder="端口" class="port-input" />
              <el-button type="primary" :loading="busy" @click="connectYcyBridge">连接</el-button>
            </div>
            <el-alert class="hint" type="info" :closable="false"
              title="桥接模式依赖 YCY API-bridge（公开仓库 YCY-YOKONEX/API-bridge）。在其运行后填入连接码与服务地址即可控制。" />
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
                  <span class="candidate-meta">{{ c.name }} · RSSI {{ c.rssi ?? '—' }}</span>
                </div>
                <el-button size="small" type="primary" :disabled="busy" @click="connectYcyBle(c)">连接</el-button>
              </div>
            </div>
          </template>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- ============ 已连接设备 ============ -->
    <el-card shadow="never" class="section-card">
      <template #header>
        <div class="card-header">
          <span>已连接设备（{{ connectedDevices.length }}）</span>
          <el-button size="small" :icon="Refresh" :loading="refreshing" @click="refreshConnected">刷新</el-button>
        </div>
      </template>

      <el-empty v-if="!connectedDevices.length" description="暂无已连接的品牌设备" />

      <div v-for="dev in connectedDevices" :key="dev.deviceId" class="device-card">
        <div class="device-card__head">
          <div>
            <span class="device-card__name">{{ dev.name || dev.deviceId }}</span>
            <el-tag size="small" class="tag-brand">{{ dev.brand === 'dglab' ? '郊狼' : '役次元' }}</el-tag>
            <el-tag v-if="dev.mode" size="small" type="info">{{ dev.mode }}</el-tag>
            <el-tag v-if="dev.type" size="small" type="warning">{{ dev.type }}</el-tag>
          </div>
          <el-button size="small" :icon="Close" @click="disconnectDevice(dev)">断开</el-button>
        </div>

        <!-- 郊狼控制 -->
        <div v-if="dev.brand === 'dglab'" class="control-grid">
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
            <el-button type="primary" size="small" @click="dglabApply(dev)">应用</el-button>
            <el-button size="small" @click="dglabStop(dev)">停止</el-button>
            <el-button size="small" @click="dglabMaxPrompt(dev)">强度上限 +10</el-button>
          </div>
        </div>

        <!-- 役次元 桥接控制 -->
        <div v-else-if="dev.brand === 'ycy' && dev.mode === 'bridge'" class="control-grid">
          <div class="control-field">
            <label>指令 ID</label>
            <el-input v-model="ctl(dev).commandId" size="small" placeholder="如 player_hurt" class="control-input" />
          </div>
          <div class="control-actions">
            <el-button type="primary" size="small" @click="ycyTrigger(dev)">触发指令</el-button>
            <el-button size="small" @click="ycyStop(dev)">全部停止</el-button>
          </div>
          <div class="control-hint">桥接模式以 App 内已配置指令触发；全局停止为 <code>_stop_all</code>。</div>
        </div>

        <!-- 役次元 BLE 电击器 -->
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
            <el-button type="primary" size="small" @click="ycyEmsApply(dev)">应用</el-button>
            <el-button size="small" @click="ycyStop(dev)">全部停止</el-button>
          </div>
        </div>

        <!-- 役次元 BLE 玩具/电机 -->
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
            <el-button type="primary" size="small" @click="ycyToyApply(dev)">应用</el-button>
            <el-button size="small" @click="ycyStop(dev)">停止</el-button>
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, Connection, Switch, Close } from '@element-plus/icons-vue'
import * as brandsApi from '../api/brands'
import type { BrandDevice, DiscoverCandidate } from '../api/brands'

const activeBrand = ref<'dglab' | 'ycy'>('dglab')
const busy = ref(false)
const refreshing = ref(false)

// 郊狼发现
const dglabHost = ref('')
const dglabPort = ref('60536')
const scanningDglab = ref(false)
const dglabCandidates = ref<DiscoverCandidate[]>([])

// 役次元
const ycyMode = ref<'bridge' | 'ble'>('bridge')
const ycyBridgeCode = ref('')
const ycyBridgeHost = ref('127.0.0.1')
const ycyBridgePort = ref('3001')
const scanningBle = ref(false)
const bleCandidates = ref<DiscoverCandidate[]>([])

const connectedDevices = ref<BrandDevice[]>([])
const controlState = reactive<Record<string, Record<string, any>>>({})

function ctl(dev: BrandDevice) {
  if (!controlState[dev.deviceId]) {
    controlState[dev.deviceId] = {
      pattern: '经典', intensity: 60, ticks: -1,
      commandId: '', aStrength: 40, bStrength: 40, wave: 1,
      speed: 60, mode: 1,
    }
  }
  return controlState[dev.deviceId]
}

const dglabPatterns = ['经典', '心跳', '潮汐', '渐强', '随机', '脉冲', '波浪', '电击']

async function refreshConnected() {
  refreshing.value = true
  try {
    connectedDevices.value = await brandsApi.listDevices()
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
    ElMessage.success('郊狼设备已连接')
    await refreshConnected()
  } catch (e: any) {
    ElMessage.error(e?.message || '连接失败')
  } finally {
    busy.value = false
  }
}

async function connectYcyBridge() {
  if (!ycyBridgeCode.value) { ElMessage.warning('请填写连接码'); return }
  busy.value = true
  try {
    await brandsApi.connect({
      brand: 'ycy',
      mode: 'bridge',
      connectCode: ycyBridgeCode.value,
      host: ycyBridgeHost.value,
      port: ycyBridgePort.value,
    })
    ElMessage.success('役次元（桥接）已连接')
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
    if (!res.devices.length) ElMessage.info('未发现役次元 BLE 设备')
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
    ElMessage.success('役次元（BLE）已连接')
    await refreshConnected()
  } catch (e: any) {
    ElMessage.error(e?.message || '连接失败')
  } finally {
    busy.value = false
  }
}

async function dglabApply(dev: BrandDevice) {
  const s = ctl(dev)
  try {
    await brandsApi.control(dev.deviceId, 'setPattern', { pattern: s.pattern, intensity: s.intensity, ticks: s.ticks })
    ElMessage.success('已下发波形')
  } catch (e: any) { ElMessage.error(e?.message || '下发失败') }
}

async function dglabStop(dev: BrandDevice) {
  try { await brandsApi.control(dev.deviceId, 'stop') } catch (e: any) { ElMessage.error(e?.message || '停止失败') }
}

async function dglabMaxPrompt(dev: BrandDevice) {
  try { await brandsApi.control(dev.deviceId, 'setMaxIntensity', { delta: 10 }) } catch (e: any) { ElMessage.error(e?.message || '操作失败') }
}

async function ycyTrigger(dev: BrandDevice) {
  const s = ctl(dev)
  if (!s.commandId) { ElMessage.warning('请填写指令 ID'); return }
  try { await brandsApi.control(dev.deviceId, 'trigger', { commandId: s.commandId }) } catch (e: any) { ElMessage.error(e?.message || '触发失败') }
}

async function ycyStop(dev: BrandDevice) {
  try { await brandsApi.control(dev.deviceId, 'ycyStop') } catch (e: any) { ElMessage.error(e?.message || '停止失败') }
}

async function ycyEmsApply(dev: BrandDevice) {
  const s = ctl(dev)
  try {
    await brandsApi.control(dev.deviceId, 'setStrength', { channel: 'A', value: s.aStrength })
    await brandsApi.control(dev.deviceId, 'setStrength', { channel: 'B', value: s.bStrength })
    await brandsApi.control(dev.deviceId, 'setMode', { channel: 'A', mode: s.wave })
    ElMessage.success('已下发')
  } catch (e: any) { ElMessage.error(e?.message || '下发失败') }
}

async function ycyToyApply(dev: BrandDevice) {
  const s = ctl(dev)
  try {
    await brandsApi.control(dev.deviceId, 'setSpeed', { motor: 'A', speed: Math.round((s.speed / 100) * 20) })
    await brandsApi.control(dev.deviceId, 'setToyMode', { motor: 'A', mode: s.mode })
    ElMessage.success('已下发')
  } catch (e: any) { ElMessage.error(e?.message || '下发失败') }
}

async function disconnectDevice(dev: BrandDevice) {
  try {
    await brandsApi.disconnect(dev.deviceId)
    ElMessage.success('已断开')
    await refreshConnected()
  } catch (e: any) { ElMessage.error(e?.message || '断开失败') }
}

onMounted(refreshConnected)
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
