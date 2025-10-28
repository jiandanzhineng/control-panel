# 项目架构说明

本工程为前后端分离架构：前端使用 Vue 3 + Vite（TypeScript），后端使用 Node.js + Express。当前用于联通测试的简单主页和接口已搭建完成。

## 项目概览
- 前端：`Vue 3 + Vite + TypeScript`，开发端口 `5173`
- 后端：`Node.js + Express`，服务端口 `3000`
- 通信方式：REST API（JSON）。测试接口：`GET /api/hello`

## 目录结构
```
frontbacken-client/
├── frontend/           # 前端工程（Vite + Vue）
│   ├── src/
│   │   ├── main.ts     # 前端入口文件
│   │   └── App.vue     # 简单测试主页（按钮请求后端）
│   └── vite.config.ts  # Vite 配置（可添加代理）
└── backend/            # 后端工程（Express）
    └── index.js        # 后端入口（含 /api/hello 接口）
```

## 启动与调试
- 启动后端：
  - 在 `backend` 目录运行：`npm run start`
  - 访问地址：`http://localhost:3000`
- 启动前端：
  - 在 `frontend` 目录运行：`npm run dev`
  - 访问地址：`http://localhost:5173`
- 测试联通：打开前端页面，点击“请求后端 /api/hello”按钮，页面显示后端返回的消息。

## 前后端联通方案
- 方案 A（已生效）：CORS
  - 后端启用了 `cors` 中间件，前端直接调用 `http://localhost:3000/api/hello`
- 方案 B（推荐开发体验）：Vite 代理
  - 在 `frontend/vite.config.ts` 中添加：
    ```ts
    export default defineConfig({
      server: {
        proxy: {
          '/api': {
            target: 'http://localhost:3000',
            changeOrigin: true,
          },
        },
      },
    })
    ```
  - 前端调用改为相对路径：`fetch('/api/hello')`

## 代码入口与职责
- 前端 `src/App.vue`：简单测试主页，按钮触发请求后端 `/api/hello`
- 后端 `index.js`：Express 服务入口，提供根路径健康检查与 `/api/hello` JSON 接口

## 部署建议（简要）
- 后端：
  - 使用环境变量配置端口：`process.env.PORT`
  - 按需部署到 Node 支持的环境（PM2、Docker、云服务等）
- 前端：
  - 构建产物：在 `frontend` 目录运行 `npm run build`，输出到 `dist/`
  - 将 `dist/` 目录部署到任意静态资源服务器（Nginx、静态托管等）

## 相关命令速览
- 后端启动：`cd backend && npm run start`
- 前端启动：`cd frontend && npm run dev`
- 前端构建：`cd frontend && npm run build`