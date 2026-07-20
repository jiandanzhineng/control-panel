<template>
  <div class="account-view">
    <el-card v-if="authState.status === 'authed' && authState.user" class="account-card">
      <template #header>
        <div class="card-header">
          <span>账号信息</span>
        </div>
      </template>
      <el-descriptions :column="1" border>
        <el-descriptions-item label="邮箱">{{ authState.user.email || '—' }}</el-descriptions-item>
        <el-descriptions-item label="登录方式">{{ authState.user.provider }}</el-descriptions-item>
        <el-descriptions-item label="注册时间">{{ formatDate(authState.user.createdAt) }}</el-descriptions-item>
      </el-descriptions>
      <div class="actions">
        <el-button type="primary" :loading="acting" @click="onLogout">退出登录</el-button>
        <el-button type="danger" plain :loading="acting" @click="onDeleteAccount">注销账号</el-button>
      </div>
    </el-card>

    <el-card v-else class="account-card">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="登录" name="login">
          <el-form :model="loginForm" label-width="70px" @submit.prevent>
            <el-form-item label="邮箱">
              <el-input v-model="loginForm.email" type="email" placeholder="name@example.com" />
            </el-form-item>
            <el-form-item label="密码">
              <el-input v-model="loginForm.password" type="password" show-password
                        @keyup.enter="onLogin" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="acting" @click="onLogin">登录</el-button>
              <el-button link type="primary" @click="onRecover">忘记密码</el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>
        <el-tab-pane label="注册" name="register">
          <el-form :model="registerForm" label-width="70px" @submit.prevent>
            <el-form-item label="邮箱">
              <el-input v-model="registerForm.email" type="email" placeholder="name@example.com" />
            </el-form-item>
            <el-form-item label="密码">
              <el-input v-model="registerForm.password" type="password" show-password
                        placeholder="8-128 位" />
            </el-form-item>
            <el-form-item label="确认密码">
              <el-input v-model="registerForm.confirm" type="password" show-password
                        @keyup.enter="onRegister" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="acting" @click="onRegister">注册并登录</el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>
      </el-tabs>
      <el-alert v-if="authState.status === 'unknown'" type="warning" :closable="false"
                title="暂时无法连接账号服务器，登录态稍后自动恢复" />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuth } from '../composables/useAuth';

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
    ElMessage.error('邮箱格式不正确');
    return false;
  }
  if (!password) {
    ElMessage.error('密码不能为空');
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
    ElMessage.error(e?.message || '操作失败');
  } finally {
    acting.value = false;
  }
}

async function onLogin(): Promise<void> {
  if (!validate(loginForm.email, loginForm.password)) return;
  await run(() => login(loginForm.email, loginForm.password), '登录成功');
}

async function onRegister(): Promise<void> {
  if (!validate(registerForm.email, registerForm.password)) return;
  if (registerForm.password.length < 8 || registerForm.password.length > 128) {
    ElMessage.error('密码长度须为 8-128 位');
    return;
  }
  if (registerForm.password !== registerForm.confirm) {
    ElMessage.error('两次输入的密码不一致');
    return;
  }
  await run(() => register(registerForm.email, registerForm.password), '注册成功');
}

async function onRecover(): Promise<void> {
  if (!validate(loginForm.email, 'x')) return;
  await run(async () => {
    await recover(loginForm.email);
    ElMessage.success('重置申请已提交，请留意邮箱（由管理员人工处理）');
  }, '');
}

async function onLogout(): Promise<void> {
  await run(logout, '已退出登录');
}

async function onDeleteAccount(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '注销后账号及云端数据将被删除且无法恢复，确定继续？',
      '注销账号',
      { type: 'warning', confirmButtonText: '确定注销', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  await run(deleteAccount, '账号已注销');
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
