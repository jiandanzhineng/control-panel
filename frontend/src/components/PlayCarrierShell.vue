<template>
  <!--
    玩法运行壳：统一承载 iframe(游戏) / webview(插件) / webview(浏览器) 三类载体。
    壳本身不感知载体类型，只提供：
      - 工具栏(后退/前进/刷新/地址/停止) 的 UI 与按钮点击事件
      - 默认 slot 让各页面自行声明 <iframe> 或 <webview>（特有属性如 preload/partition 保留在页面侧）
      - iframe 模式下的浮动停止按钮
    页面持有 webview 引用、绑定 did-navigate 等事件，再通过 props(address/canBack/...) 回填状态，
    通过 emits(back/forward/reload/...) 接收按钮指令并调用载体方法。
  -->
  <div class="play-carrier-shell" :class="{ 'is-overlay': isOverlay }">
    <!-- iframe(游戏)：无工具栏，仅浮动停止按钮，保持与改造前一致的运行体验 -->
    <template v-if="mode === 'iframe'">
      <slot />
      <button v-if="showStop" class="stop-fab" :disabled="stopping" @click="$emit('stop')" title="停止">
        <el-icon><Close /></el-icon>
        <span>{{ stopping ? '停止中...' : '停止' }}</span>
      </button>
    </template>

    <!-- webview(插件) / browser(浏览器)：顶部工具栏 + 载体 -->
    <template v-else>
      <div class="toolbar">
        <el-button :disabled="!canBack" :icon="ArrowLeft" circle size="small" @click="$emit('back')" />
        <el-button :disabled="!canForward" :icon="ArrowRight" circle size="small" @click="$emit('forward')" />
        <el-button :icon="Refresh" circle size="small" @click="$emit('reload')" />
        <el-button v-if="mode === 'browser'" :icon="HomeFilled" circle size="small" @click="$emit('home')" />

        <el-input
          v-model="inputText"
          class="address"
          :placeholder="mode === 'browser' ? '输入网址，如 example.com' : ''"
          :readonly="mode !== 'browser'"
          :clearable="mode === 'browser'"
          @keyup.enter="submitNavigate"
        >
          <template #prefix>
            <el-icon v-if="isHttps" class="lock-ok"><Lock /></el-icon>
            <el-icon v-else class="lock-warn"><Warning /></el-icon>
          </template>
        </el-input>

        <el-button v-if="mode === 'browser'" :loading="loading" type="primary" @click="submitNavigate">前往</el-button>
        <slot name="toolbar-actions" />
        <el-button v-if="showStop" type="danger" :icon="Close" :loading="stopping" @click="$emit('stop')">停止</el-button>
      </div>

      <slot name="banner" />

      <slot />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ArrowLeft, ArrowRight, Close, HomeFilled, Lock, Refresh, Warning } from '@element-plus/icons-vue';

const props = withDefaults(
  defineProps<{
    /** 载体模式：iframe=游戏(浮动停止)、webview=插件(工具栏+停止)、browser=浏览器(地址可输入无停止) */
    mode: 'iframe' | 'webview' | 'browser';
    /** 当前地址（用于只读展示或浏览器可输入） */
    address?: string;
    canBack?: boolean;
    canForward?: boolean;
    /** 停止按钮 loading */
    stopping?: boolean;
    /** 浏览器「前往」按钮 loading */
    loading?: boolean;
    /** 是否显示停止按钮（浏览器默认不显示） */
    stoppable?: boolean;
  }>(),
  {
    address: '',
    canBack: false,
    canForward: false,
    stopping: false,
    loading: false,
    stoppable: true,
  },
);

const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'forward'): void;
  (e: 'reload'): void;
  (e: 'home'): void;
  (e: 'stop'): void;
  /** 浏览器提交地址（原始文本，由页面归一化） */
  (e: 'navigate', input: string): void;
}>();

const isOverlay = computed(() => props.mode === 'iframe' || props.mode === 'webview');
const showStop = computed(() => props.mode !== 'browser' && props.stoppable);
const isHttps = computed(() => String(props.address || '').startsWith('https:'));

// 工具栏地址输入：由父级 address 同步；浏览器模式下用户可编辑，提交时 emit('navigate')
const inputText = ref(props.address);
watch(
  () => props.address,
  (v) => {
    inputText.value = v;
  },
);

function submitNavigate() {
  if (props.mode !== 'browser') return;
  emit('navigate', inputText.value);
}
</script>

<style scoped>
.play-carrier-shell {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);
}

/* 游戏 iframe / 插件 webview 为全屏覆盖层 */
.play-carrier-shell.is-overlay {
  position: fixed;
  z-index: 2000;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 42px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--el-border-color);
  background: var(--el-bg-color);
  flex: 0 0 auto;
}

.address {
  flex: 1 1 auto;
}

.lock-ok {
  color: var(--el-color-success);
}

.lock-warn {
  color: var(--el-color-warning);
}

/* iframe 模式的浮动停止按钮（与改造前游戏运行页一致） */
.stop-fab {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2100;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border: none;
  border-radius: 24px;
  background: rgba(220, 38, 38, 0.92);
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
  -webkit-tap-highlight-color: transparent;
}

.stop-fab:hover {
  background: rgba(220, 38, 38, 1);
}

.stop-fab:active {
  transform: scale(0.96);
}

.stop-fab:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

@media (max-width: 768px) {
  .toolbar {
    gap: 4px;
    padding: 4px 6px;
  }
}
</style>
