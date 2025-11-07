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
        <p>状态：{{ mqttStatus.running ? '运行中' : '已停止' }}</p>
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
const mqttStatus = ref<{ running: boolean; pid?: number; port?: number }>({ running: false });
const mqttBusy = ref(false);
const mqttError = ref('');
const mqttStatusLoading = ref(false);
const mqttStatusError = ref('');
const mqttStatusUpdated = ref(false);

// MQTT 客户端状态
const mqttClientStatus = ref<{ url?: string; clientId?: string; connected: boolean; connecting: boolean; subscriptions?: string[]; handlerCount?: number; lastError?: string | null }>({ connected: false, connecting: false });
const mqttClientLoading = ref(false);
const mqttClientError = ref('');

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