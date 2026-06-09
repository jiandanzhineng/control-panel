import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000'

  return {
    base: command === 'build' ? './' : '/',
    plugins: [vue()],
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
        },
        '/bridge': {
          target: apiProxyTarget,
          changeOrigin: true,
          ws: true,
        },
      }
    },
  }
})
