<template>
  <section class="wechat-login" :aria-label="t('account.wechatMethod')">
    <div class="qr-frame" :aria-busy="loading">
      <img v-if="qr && !error" :src="qr.image" :alt="t('account.wechatAlt')" />
      <p v-else role="status">{{ loading ? t('account.wechatLoading') : error }}</p>
    </div>
    <p class="qr-hint">{{ t('account.wechatHint') }}</p>
    <p v-if="qr && !error" class="qr-status" role="status"><span />{{ t('account.wechatWaiting') }}</p>
    <el-button class="qr-refresh" :loading="loading" @click="refresh">{{ t('account.wechatRefresh') }}</el-button>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { startWechatQr, pollWechatQr, type WechatQr } from '../api/auth';
import { useAuth } from '../composables/useAuth';

const { t } = useI18n();
const { acceptWechatSession } = useAuth();
const qr = ref<WechatQr | null>(null);
const error = ref('');
const loading = ref(false);
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

async function refresh() {
  const current = ++generation;
  clearTimeout(timer);
  qr.value = null;
  error.value = '';
  loading.value = true;
  try {
    const next = await startWechatQr();
    if (current !== generation) return;
    qr.value = next;
    timer = setTimeout(() => void poll(next, current), 1500);
  } catch {
    if (current === generation) error.value = t('account.wechatFailed');
  } finally {
    if (current === generation) loading.value = false;
  }
}

async function poll(currentQr: WechatQr, current: number) {
  if (current !== generation) return;
  if (Date.now() >= Date.parse(currentQr.expiresAt)) {
    error.value = t('account.wechatExpired');
    return;
  }
  try {
    const result = await pollWechatQr(currentQr);
    if (current !== generation) return;
    if (result.status === 'ok') {
      ++generation;
      acceptWechatSession(result);
      return;
    }
    if (result.status !== 'pending') {
      error.value = t('account.wechatExpired');
      return;
    }
    timer = setTimeout(() => void poll(currentQr, current), 1500);
  } catch {
    if (current === generation) error.value = t('account.wechatFailed');
  }
}

onMounted(refresh);
onUnmounted(() => { ++generation; clearTimeout(timer); });
</script>

<style scoped>
.wechat-login { text-align: center; }
.qr-frame { width: 208px; height: 208px; margin: 0 auto 18px; padding: 10px; border-radius: 16px; border: 1px solid var(--el-border-color-light); background: #fff; display: grid; place-items: center; box-sizing: border-box; }
.qr-frame img { display: block; width: 100%; height: 100%; object-fit: contain; }
.qr-frame p { padding: 16px; color: #606266; font-size: 13px; line-height: 1.7; }
.qr-hint { color: var(--el-text-color-regular); font-size: 13px; line-height: 1.8; margin: 0 auto 12px; max-width: 290px; }
.qr-status { color: var(--el-text-color-secondary); font-size: 12px; display: flex; align-items: center; justify-content: center; gap: 7px; }
.qr-status span { width: 6px; height: 6px; border-radius: 50%; background: var(--el-color-success); }
.qr-refresh { margin-top: 8px; min-height: 40px; border-radius: 10px; }
</style>
