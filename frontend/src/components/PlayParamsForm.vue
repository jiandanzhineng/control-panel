<template>
  <el-form label-position="top" class="params-form" @submit.prevent>
    <el-form-item v-for="param in params" :key="param.key" :label="param.label || param.name || param.key">
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
          <el-option v-for="opt in param.enum || []" :key="String(opt)" :label="String(opt)" :value="opt" />
        </el-select>
        <el-input v-else v-model="model[param.key]" :disabled="disabled" />
        <span v-if="param.unit" class="unit">{{ param.unit }}</span>
      </div>
    </el-form-item>
    <el-button type="primary" native-type="submit" :disabled="disabled" @click="$emit('submit', { ...model })">
      {{ submitText }}
    </el-button>
  </el-form>
</template>

<script setup lang="ts">
defineProps<{
  params: Array<Record<string, any>>
  model: Record<string, any>
  disabled?: boolean
  submitText: string
}>()
defineEmits<{ submit: [value: Record<string, any>] }>()
</script>

<style scoped>
.control { display: flex; align-items: center; gap: 8px; width: 100%; }
.control :deep(.el-input-number) { width: 100%; }
.unit { color: var(--el-text-color-secondary); white-space: nowrap; }
</style>
