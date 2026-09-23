<template>
  <SurgeEdgingSurface v-bind="props" @action="forwardAction" @params="forwardParams" @stop="forwardStop" />
</template>

<script setup lang="ts">
import SurgeEdgingSurface from './SurgeEdgingSurface.vue'
import type { GameRuntimeSnapshot } from '../../api/gameRuntime'
import type { GameSurfaceControls } from '../GameRuntimeSurface.vue'

const props = withDefaults(defineProps<{
  snapshot?: GameRuntimeSnapshot | null
  mode?: 'local' | 'remote' | 'config'
  authorized?: boolean
  connection?: 'live' | 'reconnecting' | 'idle'
  paramsSchema?: Array<Record<string, any>>
  model?: Record<string, any>
  controls?: GameSurfaceControls
  embedded?: boolean
}>(), {
  snapshot: null,
  mode: 'local',
  authorized: true,
  connection: 'live',
  paramsSchema: () => [],
  model: () => ({}),
  controls: () => ({ pause: false, resume: false, action: false, stop: false, params: false }),
  embedded: false,
})

const emit = defineEmits<{ action: [name: string, payload?: unknown]; params: [value: Record<string, unknown>]; stop: [] }>()
function forwardAction(name: string, payload?: unknown) { emit('action', name, payload) }
function forwardParams(value: Record<string, unknown>) { emit('params', value) }
function forwardStop() { emit('stop') }
</script>
