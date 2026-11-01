<template>
  <PlayCarrierShell mode="iframe" :stoppable="stoppable" :stopping="stopping" @stop="stopGame">
    <iframe
      v-if="iframeSrc"
      :src="iframeSrc"
      class="game-frame"
      :sandbox.attr="iframeSandbox"
      allow="fullscreen; autoplay; gyroscope; accelerometer; microphone"
      allowfullscreen
    ></iframe>

    <div v-else-if="waitingForButton" class="wait-overlay">
      <div class="wait-card">
        <h2>{{ t('gameRun.soon') }}</h2>
        <p class="wait-desc">{{ t('gameRun.pressToStart', { label: triggerLabel }) }}</p>
        <p class="wait-hint">{{ t('gameRun.afterStart') }}</p>
        <div class="wait-actions">
          <el-button @click="cancelWait">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" @click="beginGame">{{ t('gameRun.forceStart') }}</el-button>
        </div>
      </div>
    </div>

    <div v-else-if="waitingForVoice" class="wait-overlay">
      <div class="wait-card">
        <h2>{{ t('gameRun.soon') }}</h2>
        <p class="wait-desc">{{ t('gameRun.sayToStart', { phrase: voicePhraseText }) }}</p>
        <p class="wait-hint">{{ voiceError || t('gameRun.afterStart') }}</p>
        <div class="voice-level-track">
          <div class="voice-level-bar" :style="{ width: `${Math.round(voiceLevel * 100)}%` }"></div>
        </div>
        <div class="wait-actions">
          <el-button @click="cancelWait">{{ t('common.cancel') }}</el-button>
          <el-button type="primary" @click="beginGame">{{ t('gameRun.forceStart') }}</el-button>
        </div>
      </div>
    </div>

    <el-empty
      v-else
      class="game-empty"
      :description="t('gameRun.empty')"
      :image-size="120"
    >
      <el-button type="primary" @click="$router.push('/plays')">{{ t('gameRun.goPlays') }}</el-button>
    </el-empty>
  </PlayCarrierShell>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { trackPlayEnd } from '../playAnalytics';
import { clearActivePlay } from '../composables/useActivePlay';
import { listenDeviceButtonPress } from '../composables/useButtonStart';
import { listenVoicePhrase } from '../composables/useVoiceStart';
import { DEFAULT_MIC_ID } from '../play/voiceStart';
import { iframeSandboxFor } from '../play/gameIframeSandbox';
import PlayCarrierShell from '../components/PlayCarrierShell.vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const iframeSrc = ref('');
const stopping = ref(false);
const triggerId = String(route.query.startTriggerDeviceId || '');
const waitingForButton = ref(String(route.query.startMode || '') === 'button' && !!triggerId);
const triggerLabel = ref('');
// 语音开始：口令目录里的口令全都生效，识别到任意一条即开始（不加倒计时）
const voicePhraseText = ref(String(route.query.voicePhraseLabel || '') || t('playConfig.voiceStart'));
const voiceMicId = String(route.query.voiceMicId || '') || DEFAULT_MIC_ID;
const waitingForVoice = ref(String(route.query.startMode || '') === 'voice');
const voiceLevel = ref(0);
const voiceError = ref('');
let stopped = false;
let stopWait: null | (() => void) = null;

const stoppable = computed(() => !!iframeSrc.value || waitingForButton.value || waitingForVoice.value);

// 第三方（经 /games/proxy 代理的外部网页）游戏跑在独立 origin 里，读不到面板
// localStorage 的账号 token（审查报告 §2.4）。第一方游戏不加 sandbox，行为不变。
const iframeSandbox = computed(() => iframeSandboxFor(iframeSrc.value));

function buildSrc(): string {
  const q = route.query;
  const externalUrl = String(q.externalUrl || '');
  const gamePath = String(q.gamePath || '');
  const deviceMap = String(q.deviceMap || '{}');
  const params = String(q.params || '{}');
  const id = String(q.id || '');
  const locale = String(q.locale || 'zh');
  const localeTag = String(q.localeTag || (locale === 'en' ? 'en-US' : 'zh-CN'));
  const gameToken = String(q.gameToken || '');

  // 基础游戏 URL：
  // - 外部游戏：后端已返回前缀代理路径 gamePath（/games/proxy/...）
  // - 本地游戏：优先 gamePath，否则按 id 兜底（后端 gamePath 形如 /games/<folder>/index.html）
  let base = gamePath;
  if (!base && id) base = `/games/${encodeURIComponent(id)}/index.html`;
  if (!base && externalUrl) base = externalUrl;
  if (!base) return '';

  const sep = base.includes('?') ? '&' : '?';
  const tokenQuery = gameToken ? `&gameToken=${encodeURIComponent(gameToken)}` : '';
  return `${base}${sep}deviceMap=${encodeURIComponent(deviceMap)}&params=${encodeURIComponent(params)}&locale=${encodeURIComponent(locale)}&localeTag=${encodeURIComponent(localeTag)}${tokenQuery}`;
}

function beginGame() {
  if (stopped || iframeSrc.value) return;
  stopWaiting();
  waitingForButton.value = false;
  waitingForVoice.value = false;
  iframeSrc.value = buildSrc();
}

function stopWaiting() {
  if (stopWait) {
    stopWait();
    stopWait = null;
  }
}

async function stopCurrentBridge() {
  if (stopped) return;
  stopped = true;
  stopWaiting();
  try {
    const localApp = String(route.query.localApp || '');
    if (localApp) {
      await fetch(`/api/local-apps/${encodeURIComponent(localApp)}/stop`, { method: 'POST' });
    }
    await fetch('/api/games/stop-current', { method: 'POST' });
  } catch (_) {}
}

async function stopGame(reason = 'user_stop') {
  stopping.value = true;
  trackPlayEnd(reason);
  await stopCurrentBridge();
  clearActivePlay();
  iframeSrc.value = '';
  waitingForButton.value = false;
  waitingForVoice.value = false;
  router.push('/plays');
}

function cancelWait() {
  void stopGame('cancel_wait');
}

async function startWaiting(deviceId: string) {
  waitingForButton.value = true;
  triggerLabel.value = t('gameRun.triggerFallback');
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}`);
    const data = await res.json().catch(() => ({}));
    if (res.ok && data) {
      const shortId = String(data.id || deviceId).slice(-4);
      triggerLabel.value = data.nickname ? `${data.nickname}-${shortId}` : (data.name || deviceId);
    }
  } catch (_) {}
  if (stopped || iframeSrc.value || !waitingForButton.value) return;
  stopWait = listenDeviceButtonPress(deviceId, () => {
    beginGame();
  });
}

function startVoiceWaiting() {
  waitingForVoice.value = true;
  voiceError.value = '';
  stopWait = listenVoicePhrase({
    micDeviceId: voiceMicId,
    onDetected: () => { beginGame(); },
    onLevel: (level) => { voiceLevel.value = level; },
    onError: () => { voiceError.value = t('gameRun.voiceError'); },
  });
}

onMounted(() => {
  if (waitingForVoice.value) {
    startVoiceWaiting();
    return;
  }
  if (waitingForButton.value && triggerId) {
    void startWaiting(triggerId);
    return;
  }
  iframeSrc.value = buildSrc();
});

onBeforeUnmount(() => {
  trackPlayEnd('leave');
  stopCurrentBridge();
});
</script>

<style scoped>
.game-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}

.game-empty,
.wait-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--el-bg-color);
}

.wait-card {
  max-width: 420px;
  padding: 32px 28px;
  text-align: center;
}

.wait-card h2 {
  margin: 0 0 12px;
  font-size: 24px;
}

.wait-desc {
  margin: 0 0 8px;
  color: var(--el-text-color-primary);
  line-height: 1.6;
}

.wait-hint {
  margin: 0 0 24px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}

.wait-actions {
  display: flex;
  justify-content: center;
  gap: 12px;
}

/* 等待页的音量条：让用户看到麦克风在工作。 */
.voice-level-track {
  width: 100%;
  height: 8px;
  margin: 0 0 24px;
  border-radius: 4px;
  background: #e2e8f0;
  overflow: hidden;
}

.voice-level-bar {
  height: 100%;
  border-radius: 4px;
  background: #409eff;
  transition: width .08s linear;
}
</style>
