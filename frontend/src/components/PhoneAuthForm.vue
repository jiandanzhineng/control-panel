<template>
  <el-form label-position="top" @submit.prevent="submit" class="phone-form">
    <h3 v-if="binding">{{ t("account.phoneBind") }}</h3>
    <p v-if="phoneMasked">{{ phoneMasked }}</p>
    <template v-if="changing">
      <el-button :disabled="busy || oldRetry > 0" @click="send(true)">{{
        oldRetry > 0
          ? t("account.phoneRetry", { seconds: oldRetry })
          : t("account.phoneOldSend")
      }}</el-button>
      <el-form-item :label="t('account.phoneOldCode')"
        ><el-input
          v-model="oldCode"
          inputmode="numeric"
          maxlength="6"
          autocomplete="one-time-code"
      /></el-form-item>
    </template>
    <el-form-item :label="t('account.phone')"
      ><el-input
        v-model="phone"
        type="tel"
        autocomplete="tel"
        placeholder="+86"
        @input="
          challenge = '';
          code = '';
        "
    /></el-form-item>
    <el-form-item :label="t('account.smsCode')"
      ><div class="code-row"><el-input
        v-model="code"
        inputmode="numeric"
        maxlength="6"
        autocomplete="one-time-code"
        @keyup.enter="submit"
    /><el-button :disabled="busy || retry > 0 || !phone" @click="send(false)">{{ retry > 0 ? t("account.phoneRetry", { seconds: retry }) : t("account.phoneSend") }}</el-button></div></el-form-item>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-button
      type="primary"
      class="phone-submit"
      :loading="busy"
      :disabled="
        !challenge ||
        code.length !== 6 ||
        (changing && (!oldChallenge || oldCode.length !== 6))
      "
      @click="submit"
      >{{ t(binding ? "account.phoneConfirm" : "account.login") }}</el-button
    >
    <p>{{ t("account.phoneHint") }}</p>
  </el-form>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import { phoneCode, ApiError } from "../api/auth";
import { useAuth } from "../composables/useAuth";
const props = defineProps<{ binding?: boolean; phoneMasked?: string | null }>();
const { t } = useI18n();
const { phoneLogin, phoneBind } = useAuth();
const phone = ref(""),
  code = ref(""),
  oldCode = ref(""),
  challenge = ref(""),
  oldChallenge = ref(""),
  retry = ref(0),
  oldRetry = ref(0),
  busy = ref(false),
  error = ref("");
const changing = computed(() => props.binding && Boolean(props.phoneMasked));
const timer = setInterval(() => {
  retry.value = Math.max(0, retry.value - 1);
  oldRetry.value = Math.max(0, oldRetry.value - 1);
}, 1000);
onUnmounted(() => clearInterval(timer));
function showError(e: unknown) {
  error.value =
    e instanceof ApiError
      ? t(
          e.status === 401
            ? "account.phoneInvalid"
            : e.status === 409
              ? "account.phoneConflict"
              : e.status === 429
                ? "account.phoneRateLimit"
                : e.status >= 500
                  ? "account.phoneUnavailable"
                  : "account.failed",
        )
      : t("account.networkError");
}
async function send(old: boolean) {
  busy.value = true;
  error.value = "";
  try {
    const result = await phoneCode(
      old ? undefined : phone.value,
      old ? "change" : props.binding ? "bind" : "login",
    );
    if (old) {
      oldChallenge.value = result.challengeId;
      oldRetry.value = result.retryAfter;
      oldCode.value = "";
    } else {
      challenge.value = result.challengeId;
      retry.value = result.retryAfter;
      code.value = "";
    }
    ElMessage.success(t("account.phoneSent"));
  } catch (e) {
    showError(e);
  } finally {
    busy.value = false;
  }
}
async function submit() {
  if (busy.value || !challenge.value || code.value.length !== 6) return;
  busy.value = true;
  error.value = "";
  try {
    if (props.binding)
      await phoneBind({
        challengeId: challenge.value,
        code: code.value,
        ...(changing.value
          ? { oldChallengeId: oldChallenge.value, oldCode: oldCode.value }
          : {}),
      });
    else await phoneLogin(challenge.value, code.value);
    code.value = "";
    oldCode.value = "";
    challenge.value = "";
    oldChallenge.value = "";
    ElMessage.success(t("account.loginOk"));
  } catch (e) {
    showError(e);
  } finally {
    busy.value = false;
  }
}
</script>
<style scoped>
.phone-form {
  margin-top: 0;
}
.phone-form p {
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.phone-form > .el-button {
  margin: 8px 0;
}
.code-row { display: flex; gap: 10px; width: 100%; }
.code-row .el-input { min-width: 0; flex: 1; }
.code-row > .el-button { margin: 0; min-height: 46px; border-radius: 10px; }
.phone-submit { width: 100%; min-height: 46px; border-radius: 10px; font-weight: 600; }
</style>
