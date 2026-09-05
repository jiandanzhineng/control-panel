<template>
  <div class="attitude-viewer" :class="{ 'is-live': live }">
    <canvas ref="canvasRef" :aria-label="t('monitor.attitudeModel')"></canvas>
    <div class="axis-key" aria-hidden="true">
      <span class="axis axis-x">X</span>
      <span class="axis axis-y">Y</span>
      <span class="axis axis-z">Z</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import * as THREE from 'three'

import type { AttitudeQuaternion } from '../utils/dan01Attitude'

const props = defineProps<{
  quaternion: AttitudeQuaternion | null
  live: boolean
}>()

const { t } = useI18n()
const canvasRef = ref<HTMLCanvasElement | null>(null)
const targetQuaternion = new THREE.Quaternion()
const coordinateTransform = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(-Math.PI / 2, 0, 0),
)
const inverseCoordinateTransform = coordinateTransform.clone().invert()

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let deviceGroup: THREE.Group | null = null
let resizeObserver: ResizeObserver | null = null
let animationFrame = 0

function updateTarget(value: AttitudeQuaternion | null) {
  if (!value) {
    targetQuaternion.identity()
    return
  }
  const sensorQuaternion = new THREE.Quaternion(value.x, value.y, value.z, value.w).normalize()
  targetQuaternion.copy(coordinateTransform)
    .multiply(sensorQuaternion)
    .multiply(inverseCoordinateTransform)
    .normalize()
}

function resize() {
  const canvas = canvasRef.value
  if (!canvas || !renderer || !camera) return
  const width = Math.max(1, canvas.clientWidth)
  const height = Math.max(1, canvas.clientHeight)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}

function addDeviceModel(targetScene: THREE.Scene) {
  const group = new THREE.Group()
  const bodyGeometry = new THREE.BoxGeometry(3.4, 0.72, 1.8)
  const bodyMaterials = [
    new THREE.MeshStandardMaterial({ color: 0xbfc8d1, roughness: 0.72 }),
    new THREE.MeshStandardMaterial({ color: 0xbfc8d1, roughness: 0.72 }),
    new THREE.MeshStandardMaterial({ color: 0xe7ecef, roughness: 0.6 }),
    new THREE.MeshStandardMaterial({ color: 0x929da8, roughness: 0.82 }),
    new THREE.MeshStandardMaterial({ color: 0xdfe5e9, roughness: 0.68 }),
    new THREE.MeshStandardMaterial({ color: 0xe16449, roughness: 0.58 }),
  ]
  const body = new THREE.Mesh(bodyGeometry, bodyMaterials)
  body.castShadow = true
  body.receiveShadow = true
  group.add(body)

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(bodyGeometry),
    new THREE.LineBasicMaterial({ color: 0x33404b }),
  )
  group.add(edges)

  const marker = new THREE.Mesh(
    new THREE.BoxGeometry(0.58, 0.08, 0.58),
    new THREE.MeshStandardMaterial({ color: 0xe6b84f, roughness: 0.5 }),
  )
  marker.position.set(1.08, 0.4, 0)
  marker.castShadow = true
  group.add(marker)

  deviceGroup = group
  targetScene.add(group)
}

function animate() {
  if (!renderer || !scene || !camera || !deviceGroup) return
  deviceGroup.quaternion.slerp(targetQuaternion, 0.16)
  renderer.render(scene, camera)
  animationFrame = requestAnimationFrame(animate)
}

onMounted(() => {
  const canvas = canvasRef.value
  if (!canvas) return

  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100)
  camera.position.set(5.3, 3.4, 6.2)
  camera.lookAt(0, 0, 0)

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  scene.add(new THREE.HemisphereLight(0xffffff, 0x64717c, 2.1))
  const keyLight = new THREE.DirectionalLight(0xffffff, 3.2)
  keyLight.position.set(4, 7, 5)
  keyLight.castShadow = true
  scene.add(keyLight)

  const grid = new THREE.GridHelper(9, 18, 0x9ba6af, 0xd5dce1)
  grid.position.y = -1.28
  scene.add(grid)

  addDeviceModel(scene)
  updateTarget(props.quaternion)
  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas)
  resize()
  animate()
})

watch(() => props.quaternion, updateTarget, { deep: true })

onBeforeUnmount(() => {
  cancelAnimationFrame(animationFrame)
  resizeObserver?.disconnect()
  scene?.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
      object.geometry.dispose()
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      materials.forEach((material) => material.dispose())
    }
  })
  renderer?.dispose()
})
</script>

<style scoped>
.attitude-viewer {
  position: relative;
  width: 100%;
  min-height: 300px;
  aspect-ratio: 16 / 10;
  overflow: hidden;
  background: var(--bg-app);
  border: 1px solid var(--border-color);
  border-radius: 6px;
}

canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.axis-key {
  position: absolute;
  right: 14px;
  bottom: 12px;
  display: flex;
  gap: 10px;
  padding: 4px 7px;
  background: color-mix(in srgb, var(--bg-surface) 84%, transparent);
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
}

.axis-x { color: #d84a3a; }
.axis-y { color: #238a55; }
.axis-z { color: #2979b8; }

@media (max-width: 700px) {
  .attitude-viewer {
    min-height: 230px;
    aspect-ratio: 4 / 3;
  }
}
</style>
