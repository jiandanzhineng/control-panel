import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { resolve } from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))
const BRIDGE_INTERNAL_HEADER = 'x-control-panel-bridge-internal'

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  // 后端默认只绑 127.0.0.1（审查报告 §2.4），代理目标固定用回环 IP，
  // 避免 localhost 解析到 ::1 时连不上。
  const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3000'

  return {
    base: command === 'build' ? './' : '/',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [vue({
      template: {
        compilerOptions: {
          // <webview> 是 Electron 自定义元素，让 Vue 编译器放行而非当组件解析
          isCustomElement: (tag) => tag === 'webview',
        },
      },
    }), Components({
      dirs: [],
      dts: false,
      resolvers: [ElementPlusResolver({ importStyle: false })],
    })],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    server: {
      host: '::',
      port: 5173,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
        },
        // 游戏静态文件 / 第三方代理 / Bridge 脚本 / Bridge WebSocket
        // 全部代理到后端，使游戏 iframe 与控制台同源（WS Origin 校验通过）
        '/games': {
          target: apiProxyTarget,
          changeOrigin: true,
        },
        '/bridge-api': {
          target: apiProxyTarget,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader(BRIDGE_INTERNAL_HEADER, '1')
            })
          },
        },
        '/bridge': {
          target: apiProxyTarget,
          changeOrigin: true,
          ws: true,
          configure: (proxy) => {
            proxy.on('proxyReqWs', (proxyReq) => {
              proxyReq.setHeader(BRIDGE_INTERNAL_HEADER, '1')
            })
          },
        },
        // 语音开始：前端采集的 PCM 经 WS 发到后端做关键词检测
        '/voice-trigger': {
          target: apiProxyTarget,
          changeOrigin: true,
          ws: true,
          configure: (proxy) => {
            proxy.on('proxyReqWs', (proxyReq) => {
              proxyReq.setHeader(BRIDGE_INTERNAL_HEADER, '1')
            })
          },
        },
      }
    },
  }
})
