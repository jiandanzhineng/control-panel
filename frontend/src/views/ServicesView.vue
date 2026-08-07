<template>
  <div class="page">
    <header class="page-head">
      <p class="section-label">服务管理</p>
      <h1 class="page-title">网络与服务</h1>
      <p class="page-desc">mDNS 发现、MQTT 服务与客户端连接的统一管理入口。</p>
    </header>

    <div class="card-grid">
      <section class="card">
        <div class="card-head">
          <h2>mDNS 服务</h2>
          <el-tag size="small" :type="mdnsStatus.running ? 'success' : 'info'">{{ mdnsStatusText }}</el-tag>
        </div>
        <div class="stat-rows">
          <p v-if="currentMdnsIp"><span class="k">当前 IP</span><span class="v mono">{{ currentMdnsIp }}</span></p>
          <p v-if="mdnsError" class="error">{{ mdnsError }}</p>
        </div>
        <div class="row actions">
          <el-button type="primary" size="small" :loading="mdnsBusy" @click="startMdns">启动 mDNS</el-button>
          <el-button size="small" :disabled="mdnsBusy" @click="stopMdns">暂停</el-button>
          <el-button size="small" text :loading="mdnsStatusLoading" @click="refreshMdnsStatus">刷新状态</el-button>
          <span v-if="mdnsStatusError" class="error">{{ mdnsStatusError }}</span>
          <span v-if="mdnsStatusUpdated" class="ok">已更新</span>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>MQTT 服务</h2>
          <el-tag size="small" :type="mqttStatus.running ? 'success' : (mqttStatus.starting ? 'warning' : 'info')">
            {{ mqttStatus.running ? '运行中' : (mqttStatus.starting ? '启动中' : '已停止') }}
          </el-tag>
        </div>
        <div class="stat-rows">
          <p v-if="mqttStatus.port"><span class="k">端口</span><span class="v mono">{{ mqttStatus.port }}</span></p>
          <p v-if="mqttError" class="error">{{ mqttError }}</p>
        </div>
        <div class="row actions">
          <el-button type="primary" size="small" :loading="mqttBusy" @click="startMqtt">启动 MQTT</el-button>
          <el-button size="small" :disabled="mqttBusy" @click="stopMqtt">暂停</el-button>
          <el-button size="small" text :loading="mqttStatusLoading" @click="refreshMqttStatus">刷新状态</el-button>
          <span v-if="mqttStatusError" class="error">{{ mqttStatusError }}</span>
          <span v-if="mqttStatusUpdated" class="ok">已更新</span>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>MQTT 客户端</h2>
          <el-tag size="small" :type="mqttClientStatus.connected ? 'success' : (mqttClientStatus.connecting ? 'warning' : 'info')">
            {{ mqttClientStatus.connected ? '已连接' : (mqttClientStatus.connecting ? '连接中' : '未连接') }}
          </el-tag>
        </div>
        <div class="stat-rows">
          <p v-if="mqttClientStatus.url"><span class="k">Broker</span><span class="v mono">{{ mqttClientStatus.url }}</span></p>
          <p v-if="mqttClientStatus.clientId"><span class="k">Client ID</span><span class="v mono">{{ mqttClientStatus.clientId }}</span></p>
          <p v-if="mqttClientStatus.subscriptions?.length"><span class="k">订阅主题</span><span class="v mono">{{ mqttClientStatus.subscriptions.join(', ') }}</span></p>
          <p v-if="mqttClientStatus.lastError" class="error">最后错误：{{ mqttClientStatus.lastError }}</p>
        </div>
        <div class="row actions">
          <el-button size="small" text :loading="mqttClientLoading" @click="loadMqttClientStatus">刷新状态</el-button>
          <span v-if="mqttClientError" class="error">{{ mqttClientError }}</span>
        </div>
      </section>
    </div>

    <section class="card dev-card">
      <div class="card-head">
        <h2>开发者：外部本地游戏放行</h2>
        <el-switch
          v-model="devAccessEnabled"
          :disabled="devAccessBusy"
          active-text="允许"
          inactive-text="关闭"
          inline-prompt
          @change="saveDevAccess"
        />
      </div>
      <p class="muted" style="margin-top:0;">
        开启后，本机浏览器里任意端口的本地网页（localhost / 127.0.0.1）以及下方显式添加的来源，
        可直接连接本机后台试玩自研游戏。关闭时仅面板自身可访问控制接口。
      </p>
      <p class="warn-text">
        ⚠ 安全提示：这会让你浏览器访问过的本地页面具备控制真实设备的能力，仅在本机开发调试时开启，用完请关闭。
      </p>
      <div class="row">
        <span v-if="devAccessSaved" class="ok">已保存</span>
        <span v-if="devAccessError" class="error">{{ devAccessError }}</span>
      </div>

      <div v-if="devAccessEnabled" class="dev-origins">
        <div class="row">
          <input
            v-model="newOrigin"
            type="text"
            placeholder="额外来源，如 http://192.168.1.10:8080"
            class="origin-input"
            @keyup.enter="addOrigin"
          />
          <el-button size="small" :disabled="devAccessBusy" @click="addOrigin">添加来源</el-button>
        </div>
        <ul class="origin-list">
          <li v-for="o in devAccessOrigins" :key="o">
            <span class="mono">{{ o }}</span>
            <button class="link-btn" @click="removeOrigin(o)" :disabled="devAccessBusy">移除</button>
          </li>
          <li v-if="!devAccessOrigins.length" class="muted">（本地任意端口已自动放行，如需非回环地址可在此添加）</li>
        </ul>
        <p class="muted hint">
          游戏页接入方式：引用
          <code>&lt;script src="http://127.0.0.1:5278/bridge-api/device-api-bridge.js"&gt;&lt;/script&gt;</code>，
          脚本会自动连回后台 <code>/bridge</code>。
        </p>
      </div>
    </section>

    <!-- 悬浮日志组件 -->
    <div class="floating-log">
      <RealTimeLog
        :module-filter="['emqx', 'mqtt', 'mdns']"
        height="120px"
        :compact="true"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue';
import RealTimeLog from '@/components/RealTimeLog.vue';

// mDNS 状态（对象形式）
const mdnsStatus = ref<{ ip?: string; pid?: number; running: boolean }>({ running: false });

const mdnsBusy = ref(false);
const mdnsError = ref('');
const currentMdnsIp = computed(() => mdnsStatus.value.ip || '');
const mdnsStatusText = computed(() => (mdnsStatus.value.running ? '运行中' : '已停止'));

const mdnsStatusLoading = ref(false);
const mdnsStatusError = ref('');
const mdnsStatusUpdated = ref(false);
// MQTT 状态
const mqttStatus = ref<{ running: boolean; starting?: boolean; pid?: number; port?: number }>({ running: false });
const mqttBusy = ref(false);
const mqttError = ref('');
const mqttStatusLoading = ref(false);
const mqttStatusError = ref('');
const mqttStatusUpdated = ref(false);

// MQTT 客户端状态
const mqttClientStatus = ref<{ url?: string; clientId?: string; connected: boolean; connecting: boolean; subscriptions?: string[]; handlerCount?: number; lastError?: string | null }>({ connected: false, connecting: false });
const mqttClientLoading = ref(false);
const mqttClientError = ref('');

// 开发者：外部本地游戏放行
const devAccessEnabled = ref(false);
const devAccessOrigins = ref<string[]>([]);
const newOrigin = ref('');
const devAccessBusy = ref(false);
const devAccessError = ref('');
const devAccessSaved = ref(false);

async function loadDevAccess() {
  try {
    const res = await fetch('/api/dev-access');
    if (!res.ok) return;
    const data = await res.json();
    devAccessEnabled.value = !!data.enabled;
    devAccessOrigins.value = Array.isArray(data.origins) ? data.origins : [];
  } catch {}
}

async function saveDevAccess() {
  devAccessBusy.value = true;
  devAccessError.value = '';
  devAccessSaved.value = false;
  try {
    const res = await fetch('/api/dev-access', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: devAccessEnabled.value, origins: devAccessOrigins.value }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data?.error?.message || data.message || '保存失败');
    devAccessEnabled.value = !!data.enabled;
    devAccessOrigins.value = Array.isArray(data.origins) ? data.origins : [];
    devAccessSaved.value = true;
    setTimeout(() => (devAccessSaved.value = false), 1500);
  } catch (e: any) {
    devAccessError.value = e?.message || '保存失败';
    // 保存失败时回读真实状态，避免开关与后端不一致
    await loadDevAccess();
  } finally {
    devAccessBusy.value = false;
  }
}

function addOrigin() {
  const val = newOrigin.value.trim();
  if (!val) return;
  try {
    const origin = new URL(val).origin;
    if (!devAccessOrigins.value.includes(origin)) {
      devAccessOrigins.value.push(origin);
    }
    newOrigin.value = '';
    saveDevAccess();
  } catch {
    devAccessError.value = '无效的来源地址，需形如 http://host:port';
  }
}

function removeOrigin(o: string) {
  devAccessOrigins.value = devAccessOrigins.value.filter((x) => x !== o);
  saveDevAccess();
}

async function loadMdnsStatus() {
  try {
    const res = await fetch('/api/mdns/status');
    if (res.ok) {
      mdnsStatus.value = await res.json();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function refreshMdnsStatus() {
  mdnsStatusLoading.value = true;
  mdnsStatusError.value = '';
  mdnsStatusUpdated.value = false;
  try {
    const ok = await loadMdnsStatus();
    if (!ok) throw new Error('状态获取失败');
    mdnsStatusUpdated.value = true;
  } catch (e: any) {
    mdnsStatusError.value = e?.message || '状态获取失败';
  } finally {
    mdnsStatusLoading.value = false;
    setTimeout(() => (mdnsStatusUpdated.value = false), 1500);
  }
}

async function startMdns() {
  mdnsBusy.value = true;
  mdnsError.value = '';
  try {
    const res = await fetch('/api/mdns/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || 'mDNS 启动失败');
    await loadMdnsStatus();
  } catch (e: any) {
    mdnsError.value = e?.message || 'mDNS 启动失败';
  } finally {
    mdnsBusy.value = false;
  }
}

async function stopMdns() {
  mdnsBusy.value = true;
  mdnsError.value = '';
  try {
    const res = await fetch('/api/mdns/unpublish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || 'mDNS 暂停失败');
    await loadMdnsStatus();
  } catch (e: any) {
    mdnsError.value = e?.message || 'mDNS 暂停失败';
  } finally {
    mdnsBusy.value = false;
  }
}

async function loadMqttStatus() {
  try {
    const res = await fetch('/api/mqtt/status');
    if (res.ok) mqttStatus.value = await res.json();
  } catch {}
}

async function refreshMqttStatus() {
  mqttStatusLoading.value = true;
  mqttStatusError.value = '';
  mqttStatusUpdated.value = false;
  try {
    const res = await fetch('/api/mqtt/status');
    if (!res.ok) throw new Error('状态获取失败');
    mqttStatus.value = await res.json();
    mqttStatusUpdated.value = true;
  } catch (e: any) {
    mqttStatusError.value = e?.message || '状态获取失败';
  } finally {
    mqttStatusLoading.value = false;
    setTimeout(() => (mqttStatusUpdated.value = false), 1500);
  }
}

async function loadMqttClientStatus() {
  mqttClientLoading.value = true;
  mqttClientError.value = '';
  try {
    const res = await fetch('/api/mqtt-client/status');
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || '状态获取失败');
    mqttClientStatus.value = data;
  } catch (e: any) {
    mqttClientError.value = e?.message || '状态获取失败';
  } finally {
    mqttClientLoading.value = false;
  }
}

async function startMqtt() {
  mqttBusy.value = true;
  mqttError.value = '';
  try {
    const res = await fetch('/api/mqtt/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: 1883, bind: '0.0.0.0' }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || 'MQTT 启动失败');
    await loadMqttStatus();
  } catch (e: any) {
    mqttError.value = e?.message || 'MQTT 启动失败';
  } finally {
    mqttBusy.value = false;
  }
}

async function stopMqtt() {
  mqttBusy.value = true;
  mqttError.value = '';
  try {
    const res = await fetch('/api/mqtt/stop', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || 'MQTT 暂停失败');
    await loadMqttStatus();
  } catch (e: any) {
    mqttError.value = e?.message || 'MQTT 暂停失败';
  } finally {
    mqttBusy.value = false;
  }
}

let refreshTimer: any = null;
onMounted(async () => {
  await loadMdnsStatus();
  await loadMqttStatus();
  await loadMqttClientStatus();
  await loadDevAccess();
  refreshTimer = setInterval(() => {
    loadMdnsStatus();
    loadMqttStatus();
    loadMqttClientStatus();
  }, 3000);
});

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});
</script>

<style scoped>
.page { max-width: 1080px; margin: 0 auto; padding: 8px 24px 150px; text-align: left; }

.page-head { padding: 8px 0 4px; }
.page-title { font-size: 26px; font-weight: 700; color: var(--text-primary); margin: 10px 0 0; letter-spacing: -0.01em; }
.page-desc { margin: 8px 0 0; font-size: 13px; color: var(--text-muted); }

.card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-top: 20px; }

.card {
  padding: 18px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
}
.dev-card { margin-top: 16px; }

.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.card-head h2 { margin: 0; font-size: 15px; font-weight: 600; color: var(--text-primary); }

.stat-rows { min-height: 20px; margin-bottom: 14px; }
.stat-rows p { margin: 6px 0; display: flex; gap: 10px; align-items: baseline; font-size: 13px; }
.stat-rows .k { color: var(--text-faint); flex-shrink: 0; }
.stat-rows .v { color: var(--text-secondary); word-break: break-all; }

.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.actions { padding-top: 12px; border-top: 1px solid var(--border-subtle); }

.error { color: var(--el-color-error); font-size: 12px; }
.ok { color: var(--el-color-success); font-size: 12px; }
.muted { color: var(--text-muted); }

.warn-text { color: var(--el-color-warning); background: rgba(251, 191, 36, 0.07); border: 1px solid rgba(251, 191, 36, 0.22); border-radius: var(--radius-md); padding: 8px 12px; font-size: 13px; }
.dev-origins { margin-top: 14px; }
.origin-input { flex: 1; min-width: 220px; padding: 6px 10px; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-elevated); color: var(--text-primary); font-size: 13px; }
.origin-input:focus { outline: none; border-color: var(--border-strong); }
.origin-list { list-style: none; padding: 0; margin: 10px 0 0; font-size: 13px; }
.origin-list li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--border-subtle); color: var(--text-secondary); }
.link-btn { background: none; border: none; color: var(--el-color-error); padding: 0; cursor: pointer; font-size: 12px; }
.hint { font-size: 12px; margin-top: 10px; }
.hint code { background: var(--bg-elevated); border: 1px solid var(--border-subtle); padding: 1px 5px; border-radius: 4px; font-size: 12px; font-family: var(--font-mono); }

/* 悬浮日志组件样式 */
.floating-log {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--bg-surface);
  border-top: 1px solid var(--border-subtle);
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.4);
  z-index: 1000;
  padding: 8px;
  height: 136px;
}
</style>
