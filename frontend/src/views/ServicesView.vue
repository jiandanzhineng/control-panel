<template>
  <div class="page">
    <h1>服务管理</h1>

    <section class="card">
      <h2>mDNS 服务</h2>
      <div class="row">
        <button @click="startMdns" :disabled="mdnsBusy">{{ mdnsBusy ? '启动中...' : '启动 mDNS' }}</button>
        <button @click="stopMdns" :disabled="mdnsBusy">暂停 mDNS</button>
      </div>

      <div class="row">
        <button @click="refreshMdnsStatus" :disabled="mdnsStatusLoading">{{ mdnsStatusLoading ? '刷新中...' : '刷新状态' }}</button>
        <span v-if="mdnsStatusError" class="error">{{ mdnsStatusError }}</span>
        <span v-if="mdnsStatusUpdated" class="ok">状态已更新</span>
      </div>

      <div class="status">
        <p>状态：{{ mdnsStatusText }}</p>
        <p v-if="currentMdnsIp">当前使用的 IP：{{ currentMdnsIp }}</p>
        <p v-if="mdnsError" class="error">{{ mdnsError }}</p>
      </div>
    </section>

    <section class="card">
      <h2>MQTT 服务</h2>
      <div class="row">
        <button @click="startMqtt" :disabled="mqttBusy">{{ mqttBusy ? '启动中...' : '启动 MQTT' }}</button>
        <button @click="stopMqtt" :disabled="mqttBusy">暂停 MQTT</button>
      </div>
      <div class="row">
        <button @click="refreshMqttStatus" :disabled="mqttStatusLoading">{{ mqttStatusLoading ? '刷新中...' : '刷新状态' }}</button>
        <span v-if="mqttStatusError" class="error">{{ mqttStatusError }}</span>
        <span v-if="mqttStatusUpdated" class="ok">状态已更新</span>
      </div>
      <div class="status">
        <p>状态：{{ mqttStatus.running ? '运行中' : (mqttStatus.starting ? '启动中...' : '已停止') }}</p>
        <p v-if="mqttStatus.port">端口：{{ mqttStatus.port }}</p>
        <p v-if="mqttError" class="error">{{ mqttError }}</p>
      </div>
    </section>

    <section class="card">
      <h2>MQTT 客户端</h2>
      <div class="row">
        <button @click="loadMqttClientStatus" :disabled="mqttClientLoading">{{ mqttClientLoading ? '刷新中...' : '刷新状态' }}</button>
        <span v-if="mqttClientError" class="error">{{ mqttClientError }}</span>
      </div>
      <div class="status">
        <p>连接状态：{{ mqttClientStatus.connected ? '已连接' : (mqttClientStatus.connecting ? '连接中...' : '未连接') }}</p>
        <p v-if="mqttClientStatus.url">Broker：{{ mqttClientStatus.url }}</p>
        <p v-if="mqttClientStatus.clientId">Client ID：{{ mqttClientStatus.clientId }}</p>
        <p v-if="mqttClientStatus.subscriptions?.length">订阅主题：{{ mqttClientStatus.subscriptions.join(', ') }}</p>
        <p v-if="mqttClientStatus.lastError" class="error">最后错误：{{ mqttClientStatus.lastError }}</p>
      </div>
    </section>

    <section class="card">
      <h2>开发者：外部本地游戏放行</h2>
      <p class="muted" style="margin-top:0;">
        开启后，本机浏览器里任意端口的本地网页（localhost / 127.0.0.1）以及下方显式添加的来源，
        可直接连接本机后台试玩自研游戏。关闭时仅面板自身可访问控制接口。
      </p>
      <p class="warn-text">
        ⚠ 安全提示：这会让你浏览器访问过的本地页面具备控制真实设备的能力，仅在本机开发调试时开启，用完请关闭。
      </p>
      <div class="row">
        <label class="switch-label">
          <input type="checkbox" v-model="devAccessEnabled" @change="saveDevAccess" :disabled="devAccessBusy" />
          允许外部本地游戏连接
        </label>
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
          <button @click="addOrigin" :disabled="devAccessBusy">添加来源</button>
        </div>
        <ul class="origin-list">
          <li v-for="o in devAccessOrigins" :key="o">
            <span>{{ o }}</span>
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
.page { max-width: 960px; margin: 40px auto; padding: 0 24px 150px 24px; text-align: left; }
.card { margin-top: 24px; padding: 16px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fafafa; }
.row { display: flex; gap: 12px; align-items: center; }
.error { color: #e11d48; }
.ok { color: #16a34a; }
.muted { color: #6b7280; }
.status p { margin: 6px 0; }
button { padding: 6px 12px; border: 1px solid #0ea5e9; background: #0ea5e9; color: white; border-radius: 6px; cursor: pointer; }
button:disabled { opacity: 0.6; cursor: not-allowed; }

.warn-text { color: #b45309; background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 8px 12px; font-size: 13px; }
.switch-label { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
.switch-label input { width: 16px; height: 16px; }
.dev-origins { margin-top: 12px; }
.origin-input { flex: 1; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 6px; }
.origin-list { list-style: none; padding: 0; margin: 10px 0 0; }
.origin-list li { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f1f5f9; }
.link-btn { background: none; border: none; color: #e11d48; padding: 0; cursor: pointer; }
.hint { font-size: 12px; margin-top: 10px; }
.hint code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-size: 12px; }

/* 悬浮日志组件样式 */
.floating-log {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: white;
  border-top: 2px solid #0ea5e9;
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.15);
  z-index: 1000;
  padding: 8px;
  height: 136px;
}
</style>
