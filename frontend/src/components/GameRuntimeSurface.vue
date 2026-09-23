<template>
  <component
    :is="surfaceComponent"
    v-bind="props"
    @action="forwardAction"
    @params="forwardParams"
    @stop="forwardStop"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { GameRuntimeSnapshot } from '../api/gameRuntime'
import PressureEdgingSurface from './gameSurfaces/PressureEdgingSurface.vue'
import SurgeEdgingSurface from './gameSurfaces/SurgeEdgingSurface.vue'

export interface GameSurfaceControls {
  pause: boolean
  resume: boolean
  action: boolean
  stop: boolean
  params: boolean
}

export interface GameSurfaceProps {
  snapshot?: GameRuntimeSnapshot | null
  mode?: 'local' | 'remote' | 'config'
  authorized?: boolean
  connection?: 'live' | 'reconnecting' | 'idle'
  paramsSchema?: Array<Record<string, any>>
  model?: Record<string, any>
  controls?: GameSurfaceControls
  embedded?: boolean
}

const props = withDefaults(defineProps<GameSurfaceProps>(), {
  snapshot: null,
  mode: 'local',
  authorized: true,
  connection: 'live',
  paramsSchema: () => [],
  model: () => ({}),
  controls: () => ({ pause: false, resume: false, action: false, stop: false, params: false }),
  embedded: false,
})

const emit = defineEmits<{
  action: [name: string, payload?: unknown]
  params: [value: Record<string, unknown>]
  stop: []
}>()

const surfaceComponent = computed(() => props.snapshot?.gameId === 'pressure-edging-v2'
  ? PressureEdgingSurface
  : SurgeEdgingSurface)

function forwardAction(name: string, payload?: unknown) { emit('action', name, payload) }
function forwardParams(value: Record<string, unknown>) { emit('params', value) }
function forwardStop() { emit('stop') }
</script>
