<template>
  <div class="account-view">
    <el-card v-if="authState.status === 'authed' && authState.user" class="account-card">
      <template #header>
        <div class="card-header">
          <span>{{ t('account.info') }}</span>
        </div>
      </template>
      <el-descriptions :column="1" border>
        <el-descriptions-item :label="t('account.email')">{{ authState.user.email || '—' }}</el-descriptions-item>
        <el-descriptions-item :label="t('account.phone')">{{ authState.user.phoneMasked || '—' }}</el-descriptions-item>
        <el-descriptions-item :label="t('account.provider')">{{ authState.user.provider === 'phone' ? t('account.phoneLogin') : authState.user.provider === 'email' ? t('account.email') : authState.user.provider }}</el-descriptions-item>
        <el-descriptions-item :label="t('account.createdAt')">{{ formatDate(authState.user.createdAt) }}</el-descriptions-item>
      </el-descriptions>
      <PhoneAuthForm binding :phone-masked="authState.user.phoneMasked" />
      <div class="actions">
        <el-button type="primary" :loading="acting" @click="onLogout">{{ t('account.logout') }}</el-button>
        <el-button type="danger" plain :loading="acting" @click="onDeleteAccount">{{ t('account.delete') }}</el-button>
      </div>
    </el-card>

    <el-card v-else class="account-card auth-card" shadow="never">
      <header class="auth-heading">
        <p class="auth-brand">UNDERSILICON</p>
        <h1>{{ t('account.welcomeBack') }}</h1>
        <p>{{ t('account.accountSubtitle') }}</p>
      </header>
      <div class="auth-methods" :aria-label="t('account.loginMethod')">
        <button type="button" :aria-pressed="activeTab === 'phone'" @click="activeTab = 'phone'">{{ t('account.phoneMethod') }}</button>
        <button type="button" :aria-pressed="activeTab === 'login' || activeTab === 'register'" @click="activeTab = 'login'">{{ t('account.emailMethod') }}</button>
        <button type="button" :aria-pressed="activeTab === 'wechat'" @click="activeTab = 'wechat'">{{ t('account.wechatMethod') }}</button>
      </div>
      <WechatQrLogin v-if="activeTab === 'wechat'" />
      <div v-show="activeTab === 'phone'"><PhoneAuthForm /></div>
      <div v-show="activeTab === 'login'">
        <el-form :model="loginForm" label-position="top" @submit.prevent="onLogin">
          <el-form-item :label="t('account.email')">
            <el-input v-model="loginForm.email" type="email" autocomplete="username" placeholder="name@example.com" />
          </el-form-item>
          <el-form-item :label="t('account.password')">
            <el-input v-model="loginForm.password" type="password" autocomplete="current-password" show-password />
          </el-form-item>
          <el-button class="auth-submit" type="primary" native-type="submit" :loading="acting">{{ t('account.login') }}</el-button>
        </el-form>
        <div class="auth-links">
          <el-button link @click="activeTab = 'register'">{{ t('account.register') }}</el-button>
          <el-button link @click="onRecover">{{ t('account.forgot') }}</el-button>
        </div>
      </div>
      <div v-show="activeTab === 'register'">
        <h2 class="auth-register-title">{{ t('account.register') }}</h2>
        <el-form :model="registerForm" label-position="top" @submit.prevent="onRegister">
          <el-form-item :label="t('account.email')">
            <el-input v-model="registerForm.email" type="email" autocomplete="username" placeholder="name@example.com" />
          </el-form-item>
          <el-form-item :label="t('account.password')">
            <el-input v-model="registerForm.password" type="password" autocomplete="new-password" show-password :placeholder="t('account.passwordPlaceholder')" />
          </el-form-item>
          <el-form-item :label="t('account.confirmPassword')">
            <el-input v-model="registerForm.confirm" type="password" autocomplete="new-password" show-password />
          </el-form-item>
          <el-button class="auth-submit" type="primary" native-type="submit" :loading="acting">{{ t('account.registerAndLogin') }}</el-button>
        </el-form>
        <el-button class="auth-back" link @click="activeTab = 'login'">{{ t('account.backToLogin') }}</el-button>
      </div>
      <el-alert v-if="authState.status === 'unknown'" class="auth-warning" type="warning" :closable="false" :title="t('account.serverUnknown')" />
      <p class="auth-foot">{{ t('account.sharedAccount') }}</p>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import PhoneAuthForm from '../components/PhoneAuthForm.vue';
import WechatQrLogin from '../components/WechatQrLogin.vue';
import { useAuth } from '../composables/useAuth';

const { t } = useI18n();
const { authState, login, register, logout, deleteAccount, recover } = useAuth();

const activeTab = ref('phone');
const acting = ref(false);
const loginForm = reactive({ email: '', password: '' });
const registerForm = reactive({ email: '', password: '', confirm: '' });

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function validate(email: string, password: string): boolean {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    ElMessage.error(t('account.invalidEmail'));
    return false;
  }
  if (!password) {
    ElMessage.error(t('account.emptyPassword'));
    return false;
  }
  return true;
}

async function run(action: () => Promise<void>, successTip: string): Promise<void> {
  acting.value = true;
  try {
    await action();
    if (successTip) ElMessage.success(successTip);
  } catch (e: any) {
    const msg = e?.code === 'NETWORK_ERROR' || e?.message === 'NETWORK_ERROR'
      ? t('account.networkError')
      : (e?.message || t('account.failed'));
    ElMessage.error(msg);
  } finally {
    acting.value = false;
  }
}

async function onLogin(): Promise<void> {
  if (!validate(loginForm.email, loginForm.password)) return;
  await run(() => login(loginForm.email, loginForm.password), t('account.loginOk'));
}

async function onRegister(): Promise<void> {
  if (!validate(registerForm.email, registerForm.password)) return;
  if (registerForm.password.length < 8 || registerForm.password.length > 128) {
    ElMessage.error(t('account.passwordLength'));
    return;
  }
  if (registerForm.password !== registerForm.confirm) {
    ElMessage.error(t('account.passwordMismatch'));
    return;
  }
  await run(() => register(registerForm.email, registerForm.password), t('account.registerOk'));
}

async function onRecover(): Promise<void> {
  if (!validate(loginForm.email, 'x')) return;
  await run(async () => {
    await recover(loginForm.email);
    ElMessage.success(t('account.recoverOk'));
  }, '');
}

async function onLogout(): Promise<void> {
  await run(logout, t('account.logoutOk'));
}

async function onDeleteAccount(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      t('account.deleteConfirm'),
      t('account.deleteTitle'),
      { type: 'warning', confirmButtonText: t('account.deleteOk'), cancelButtonText: t('common.cancel') },
    );
  } catch {
    return;
  }
  await run(deleteAccount, t('account.deleted'));
}
</script>

<style scoped>
.account-view {
  max-width: 560px;
  margin: 0 auto;
}

.account-card {
  margin-top: 16px;
}

.card-header {
  font-weight: bold;
}

.actions {
  margin-top: 16px;
  display: flex;
  gap: 12px;
}

.auth-card { max-width: 460px; margin: 36px auto; border-radius: 24px; }
.auth-card :deep(.el-card__body) { padding: 32px; }
.auth-heading { margin-bottom: 28px; }
.auth-brand { margin: 0 0 18px; font-size: 11px; font-weight: 650; letter-spacing: .2em; color: var(--el-text-color-secondary); }
.auth-heading h1 { margin: 0 0 10px; font-size: 28px; line-height: 1.3; }
.auth-heading > p:last-child { color: var(--el-text-color-secondary); font-size: 14px; line-height: 1.7; margin: 0; }
.auth-methods { display: flex; gap: 4px; padding: 4px; margin-bottom: 24px; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-light); border-radius: 12px; }
.auth-methods button { flex: 1; min-width: 0; min-height: 44px; border: 0; background: transparent; color: var(--el-text-color-secondary); border-radius: 8px; cursor: pointer; font: inherit; font-size: 14px; }
.auth-methods button[aria-pressed="true"] { background: var(--el-bg-color-overlay); color: var(--el-color-primary); box-shadow: 0 2px 6px #0001; font-weight: 600; }
.auth-methods button:focus-visible { outline: 2px solid var(--el-color-primary); }
.auth-card :deep(.el-input__wrapper) { min-height: 46px; box-sizing: border-box; border-radius: 10px; padding: 1px 14px; }
.auth-card :deep(.el-form-item__label) { padding-bottom: 6px; }
.auth-submit { width: 100%; min-height: 46px; border-radius: 10px; margin-top: 6px; font-weight: 600; }
.auth-links { display: flex; justify-content: space-between; margin-top: 18px; }
.auth-register-title { font-size: 18px; margin: 0 0 20px; }
.auth-back { margin-top: 18px; }
.auth-foot { margin: 26px 0 0; padding-top: 20px; border-top: 1px solid var(--el-border-color-lighter); color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.7; }
.auth-warning { margin-top: 20px; }
@media (max-width: 600px) { .auth-card { margin: 12px auto; } .auth-card :deep(.el-card__body) { padding: 24px 20px; } }
</style>
