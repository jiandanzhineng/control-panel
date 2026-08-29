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
        <el-descriptions-item :label="t('account.provider')">{{ authState.user.provider }}</el-descriptions-item>
        <el-descriptions-item :label="t('account.createdAt')">{{ formatDate(authState.user.createdAt) }}</el-descriptions-item>
      </el-descriptions>
      <div class="actions">
        <el-button type="primary" :loading="acting" @click="onLogout">{{ t('account.logout') }}</el-button>
        <el-button type="danger" plain :loading="acting" @click="onDeleteAccount">{{ t('account.delete') }}</el-button>
      </div>
    </el-card>

    <el-card v-else class="account-card">
      <el-tabs v-model="activeTab">
        <el-tab-pane :label="t('account.login')" name="login">
          <el-form :model="loginForm" label-width="70px" @submit.prevent>
            <el-form-item :label="t('account.email')">
              <el-input v-model="loginForm.email" type="email" placeholder="name@example.com" />
            </el-form-item>
            <el-form-item :label="t('account.password')">
              <el-input v-model="loginForm.password" type="password" show-password
                        @keyup.enter="onLogin" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="acting" @click="onLogin">{{ t('account.login') }}</el-button>
              <el-button link type="primary" @click="onRecover">{{ t('account.forgot') }}</el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>
        <el-tab-pane :label="t('account.register')" name="register">
          <el-form :model="registerForm" label-width="70px" @submit.prevent>
            <el-form-item :label="t('account.email')">
              <el-input v-model="registerForm.email" type="email" placeholder="name@example.com" />
            </el-form-item>
            <el-form-item :label="t('account.password')">
              <el-input v-model="registerForm.password" type="password" show-password
                        :placeholder="t('account.passwordPlaceholder')" />
            </el-form-item>
            <el-form-item :label="t('account.confirmPassword')">
              <el-input v-model="registerForm.confirm" type="password" show-password
                        @keyup.enter="onRegister" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="acting" @click="onRegister">{{ t('account.registerAndLogin') }}</el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>
      </el-tabs>
      <el-alert v-if="authState.status === 'unknown'" type="warning" :closable="false"
                :title="t('account.serverUnknown')" />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuth } from '../composables/useAuth';

const { t } = useI18n();
const { authState, login, register, logout, deleteAccount, recover } = useAuth();

const activeTab = ref('login');
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
    ElMessage.error(e?.message || t('account.failed'));
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
</style>
