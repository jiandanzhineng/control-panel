<template>
  <div class="simple-chart" :style="{ height: height + 'px' }">
    <div v-if="!data || data.length === 0" class="no-data">
      暂无数据
    </div>
    <svg v-else :width="width" :height="height" class="chart-svg">
      <!-- 网格线 -->
      <g class="grid">
        <line 
          v-for="i in 5" 
          :key="`h-${i}`"
          :x1="padding" 
          :y1="padding + (chartHeight / 4) * (i - 1)"
          :x2="width - padding" 
          :y2="padding + (chartHeight / 4) * (i - 1)"
          stroke="#f0f0f0" 
          stroke-width="1"
        />
        <line 
          v-for="i in 6" 
          :key="`v-${i}`"
          :x1="padding + (chartWidth / 5) * (i - 1)" 
          :y1="padding"
          :x2="padding + (chartWidth / 5) * (i - 1)" 
          :y2="height - padding"
          stroke="#f0f0f0" 
          stroke-width="1"
        />
      </g>
      
      <!-- 数据线 -->
      <polyline
        :points="linePoints"
        fill="none"
        stroke="#409eff"
        stroke-width="2"
        stroke-linejoin="round"
      />
      
      <!-- 数据点 -->
      <circle
        v-for="(point, index) in points"
        :key="index"
        :cx="point.x"
        :cy="point.y"
        r="3"
        fill="#409eff"
      />
      
      <!-- Y轴标签 -->
      <g class="y-labels">
        <text
          v-for="(label, index) in yLabels"
          :key="index"
          :x="padding - 10"
          :y="padding + (chartHeight / 4) * index + 5"
          text-anchor="end"
          font-size="12"
          fill="#666"
        >
          {{ label }}
        </text>
      </g>
      
      <!-- X轴标签 -->
      <g class="x-labels">
        <text
          v-for="(label, index) in xLabels"
          :key="index"
          :x="xLabels.length <= 1 ? padding + chartWidth / 2 : padding + (chartWidth / (xLabels.length - 1)) * index"
          :y="height - padding + 15"
          text-anchor="middle"
          font-size="10"
          fill="#666"
        >
          {{ label }}
        </text>
      </g>
    </svg>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  data: {
    type: Array,
    default: () => []
  },
  unit: {
    type: String,
    default: ''
  },
  height: {
    type: Number,
    default: 200
  },
  width: {
    type: Number,
    default: 400
  }
})

const padding = 40
const chartWidth = computed(() => props.width - 2 * padding)
const chartHeight = computed(() => props.height - 2 * padding)

const values = computed(() => props.data.map(item => item.value))
const times = computed(() => props.data.map(item => item.time))

const minValue = computed(() => {
  if (values.value.length === 0) return 0
  return Math.min(...values.value)
})

const maxValue = computed(() => {
  if (values.value.length === 0) return 100
  const max = Math.max(...values.value)
  const min = minValue.value
  return max === min ? max + 1 : max
})

const valueRange = computed(() => maxValue.value - minValue.value)

const points = computed(() => {
  if (props.data.length === 0) return []
  
  return props.data.map((item, index) => {
    let x
    if (props.data.length === 1) {
      x = padding + chartWidth.value / 2
    } else {
      x = padding + (chartWidth.value / (props.data.length - 1)) * index
    }
    
    let y
    if (valueRange.value === 0) {
      y = padding + chartHeight.value / 2
    } else {
      y = padding + chartHeight.value - ((item.value - minValue.value) / valueRange.value) * chartHeight.value
    }
    
    return { x, y }
  })
})

const linePoints = computed(() => {
  return points.value.map(p => `${p.x},${p.y}`).join(' ')
})

const yLabels = computed(() => {
  const labels = []
  for (let i = 0; i < 5; i++) {
    const value = maxValue.value - (valueRange.value / 4) * i
    labels.push(value.toFixed(1))
  }
  return labels
})

const xLabels = computed(() => {
  if (times.value.length === 0) return []
  
  if (times.value.length === 1) {
    return [times.value[0]]
  }
  
  const step = Math.max(1, Math.floor(times.value.length / 5))
  const labels = []
  
  for (let i = 0; i < times.value.length; i += step) {
    labels.push(times.value[i])
  }
  
  if (labels.length < times.value.length && !labels.includes(times.value[times.value.length - 1])) {
    labels.push(times.value[times.value.length - 1])
  }
  
  return labels
})
</script>

<style scoped>
.simple-chart {
  width: 100%;
  position: relative;
  background: #fff;
  border-radius: 4px;
}

.no-data {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #999;
  font-size: 14px;
}

.chart-svg {
  width: 100%;
  height: 100%;
}

.grid line {
  stroke-dasharray: 2,2;
}
</style>