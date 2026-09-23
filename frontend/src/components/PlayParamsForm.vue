<template>
  <el-form label-position="top" class="params-form" @submit.prevent>
    <div v-for="section in basicSections" :key="section.key" class="param-section">
      <h3 v-if="section.title">{{ section.title }}</h3>
      <div class="param-grid">
      <el-form-item v-for="param in section.items" :key="param.key" :label="param.label || param.name || param.key">
      <div class="control">
        <el-input-number
          v-if="param.type === 'number'"
          v-model="model[param.key]"
          :min="param.min"
          :max="param.max"
          :step="param.step || 1"
          :disabled="disabled"
          controls-position="right"
        />
        <el-switch v-else-if="param.type === 'boolean'" v-model="model[param.key]" :disabled="disabled" />
        <el-select v-else-if="param.type === 'enum'" v-model="model[param.key]" :disabled="disabled">
          <el-option v-for="opt in param.enum || []" :key="String(opt)" :label="param.enumLabels?.[String(opt)] || String(opt)" :value="opt" />
        </el-select>
        <el-input v-else v-model="model[param.key]" :disabled="disabled" />
        <span v-if="param.unit" class="unit">{{ param.unit }}</span>
      </div>
        <small v-if="param.description" class="description">{{ param.description }}</small>
      </el-form-item>
      </div>
    </div>
    <el-collapse v-if="advancedSections.length" class="advanced">
      <el-collapse-item name="advanced" :title="t('playConfig.advanced', { n: advancedCount })">
        <div v-for="section in advancedSections" :key="section.key" class="param-section">
          <h3 v-if="section.title">{{ section.title }}</h3>
          <div class="param-grid">
            <el-form-item v-for="param in section.items" :key="param.key" :label="param.label || param.name || param.key">
              <div class="control">
                <el-input-number v-if="param.type === 'number'" v-model="model[param.key]" :min="param.min" :max="param.max" :step="param.step || 1" :disabled="disabled" controls-position="right" />
                <el-switch v-else-if="param.type === 'boolean'" v-model="model[param.key]" :disabled="disabled" />
                <el-select v-else-if="param.type === 'enum'" v-model="model[param.key]" :disabled="disabled">
                  <el-option v-for="opt in param.enum || []" :key="String(opt)" :label="param.enumLabels?.[String(opt)] || String(opt)" :value="opt" />
                </el-select>
                <el-input v-else v-model="model[param.key]" :disabled="disabled" />
                <span v-if="param.unit" class="unit">{{ param.unit }}</span>
              </div>
              <small v-if="param.description" class="description">{{ param.description }}</small>
            </el-form-item>
          </div>
        </div>
      </el-collapse-item>
    </el-collapse>
    <div v-if="showSubmit || showReset" class="form-actions">
      <el-button v-if="showReset" :disabled="disabled" @click="$emit('reset')">{{ t('playConfig.reset') }}</el-button>
      <el-button v-if="showSubmit" type="primary" native-type="button" :disabled="disabled" @click="$emit('submit', { ...model })">{{ submitText }}</el-button>
    </div>
  </el-form>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const props = withDefaults(defineProps<{
  params: Array<Record<string, any>>
  model: Record<string, any>
  disabled?: boolean
  submitText?: string
  showSubmit?: boolean
  showReset?: boolean
}>(), { submitText: '', showSubmit: true, showReset: false })

const order = ['core', 'difficulty', 'punish', 'reward', 'device', 'advanced', 'other']
function group(items: Array<Record<string, any>>) {
  const keys = [...new Set(items.map((item) => String(item.group || 'other')))]
  keys.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return keys.map((key) => ({
    key,
    title: t(`playConfig.groups.${key}`),
    items: items.filter((item) => String(item.group || 'other') === key),
  }))
}
const basicSections = computed(() => group(props.params.filter((item) => item.required !== false && item.group !== 'advanced')))
const advancedSections = computed(() => group(props.params.filter((item) => item.required === false || item.group === 'advanced')))
const advancedCount = computed(() => advancedSections.value.reduce((count, section) => count + section.items.length, 0))
defineEmits<{ submit: [value: Record<string, any>]; reset: [] }>()
</script>

<style scoped>
.params-form { display: grid; gap: 14px; }
.param-section h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
.param-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); column-gap: 20px; }
.param-grid :deep(.el-form-item) { margin-bottom: 12px; }
.control { display: flex; align-items: center; gap: 8px; width: 100%; }
.control :deep(.el-input-number) { width: min(100%, 240px); }
.description { display: block; color: var(--el-text-color-secondary); line-height: 1.4; margin-top: 4px; }
.form-actions { display: flex; justify-content: flex-end; gap: 8px; }
.unit { color: var(--el-text-color-secondary); white-space: nowrap; }
</style>
