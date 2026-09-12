<template>
  <div class="batch-control">
    <el-empty v-if="groups.length === 0" :description="t('devices.batchEmpty')" />
    <el-card v-for="group in groups" :key="group.type" shadow="never" class="batch-group">
      <template #header>
        <div class="batch-group-header">
          <span>{{ group.name }} · {{ t('devices.batchOnline', { n: group.devices.length }) }}</span>
          <span class="batch-selected">{{ t('devices.batchSelected', { n: selectedIds(group).length, m: group.devices.length }) }}</span>
        </div>
      </template>
      <div class="batch-ops">
        <el-button
          v-for="op in group.operations"
          :key="op.key"
          type="primary"
          :loading="loadingKey === `${group.type}:${op.key}`"
          :disabled="busy || selectedIds(group).length === 0"
          @click="run(group, op)"
        >
          {{ opLabel(op) }}
        </el-button>
      </div>
      <el-collapse>
        <el-collapse-item :title="t('devices.batchPick')" :name="group.type">
          <el-checkbox-group :model-value="selectedIds(group)" @change="(ids) => setSelected(group, ids)">
            <el-checkbox v-for="d in group.devices" :key="d.id" :value="d.id">
              {{ deviceLabel(d) }}
            </el-checkbox>
          </el-checkbox-group>
        </el-collapse-item>
      </el-collapse>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { batchExecuteOperation } from '../api/devices'

interface BatchDevice {
  id: string
  name?: string
  nickname?: string
  type?: string
  connected?: boolean
}

interface BatchOperation {
  key: string
  name?: string
}

const props = defineProps<{
  devices: BatchDevice[]
  typeConfigs: Record<string, { operations?: BatchOperation[]; name?: string }>
}>()

const { t } = useI18n()
const deselectedByType = ref<Record<string, string[]>>({})
const loadingKey = ref('')
const busy = computed(() => loadingKey.value !== '')

const groups = computed(() => {
  const map = new Map<string, BatchDevice[]>()
  for (const device of props.devices) {
    if (!device.connected || !device.type) continue
    const operations = props.typeConfigs[device.type]?.operations
    if (!operations?.length) continue
    const list = map.get(device.type) || []
    list.push(device)
    map.set(device.type, list)
  }
  return [...map.entries()].map(([type, devices]) => ({
    type,
    name: typeName(type),
    devices,
    operations: props.typeConfigs[type]?.operations || [],
  }))
})

function typeName(type: string) {
  const key = `deviceTypes.${type}`
  const translated = t(key)
  return translated === key ? (props.typeConfigs[type]?.name || type) : translated
}

function opLabel(operation: BatchOperation) {
  const i18nKey = `ops.${operation.key}`
  const translated = t(i18nKey)
  return translated === i18nKey ? (operation.name || operation.key) : translated
}

function deviceLabel(device: BatchDevice) {
  if (device.nickname) return `${device.nickname}-${String(device.id).slice(-4)}`
  return device.name || device.id
}

function selectedIds(group: { type: string; devices: BatchDevice[] }) {
  const skip = new Set(deselectedByType.value[group.type] || [])
  return group.devices.map((d) => d.id).filter((id) => !skip.has(id))
}

function setSelected(group: { type: string; devices: BatchDevice[] }, ids: unknown) {
  const picked = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)))
  deselectedByType.value = {
    ...deselectedByType.value,
    [group.type]: group.devices.filter((d) => !picked.has(d.id)).map((d) => d.id),
  }
}

async function run(group: { type: string; devices: BatchDevice[] }, operation: BatchOperation) {
  const deviceIds = selectedIds(group)
  if (deviceIds.length === 0) return
  loadingKey.value = `${group.type}:${operation.key}`
  try {
    const result = await batchExecuteOperation({
      type: group.type,
      operationKey: operation.key,
      deviceIds,
    })
    const failedIds = result.results.filter((row) => !row.ok && !row.skipped).map((row) => row.id.slice(-4))
    if (result.failed > 0) {
      ElMessage.error(t('devices.batchPartial', {
        name: opLabel(operation),
        ok: result.ok,
        total: result.total,
        failed: failedIds.join(', ') || String(result.failed),
      }))
    } else {
      ElMessage.success(t('devices.batchOk', { name: opLabel(operation), n: result.ok }))
    }
  } catch (error: any) {
    ElMessage.error(error?.message || t('devices.batchFailed', { name: opLabel(operation) }))
  } finally {
    loadingKey.value = ''
  }
}
</script>

<style scoped>
.batch-control {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.batch-group-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}
.batch-selected {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.batch-ops {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}
</style>

