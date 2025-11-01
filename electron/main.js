const path = require('path');
const { app, BrowserWindow } = require('electron');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

let server;
let frontendServer;

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const frontendUrl = process.env.FRONTEND_URL;
  
  if (devUrl) {
    win.loadURL(devUrl);
  } else if (frontendUrl) {
    win.loadURL(frontendUrl);
  } else {
    win.loadFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'));
  }

  // 如需自动导航或探针，可在此处添加 win.webContents 逻辑
}

function startFrontendServer(callback) {
  const frontendApp = express();
  const distPath = path.join(__dirname, '..', 'frontend', 'dist');
  
  // API转发中间件：将/api/*请求转发到后端
  frontendApp.use('/api', createProxyMiddleware({
    target: process.env.BACKEND_URL || 'http://127.0.0.1:5278',
    changeOrigin: true,
    logLevel: 'debug',
    pathRewrite: {
      '^/': '/api/'  // 将剩余路径重新添加/api前缀
    }
  }));
  
  frontendApp.use(express.static(distPath));
  frontendApp.get('/*path', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
  
  const FRONTEND_PORT = 5277;
  frontendServer = frontendApp.listen(FRONTEND_PORT, () => {
    process.env.FRONTEND_URL = `http://127.0.0.1:${FRONTEND_PORT}`;
    console.log(`[electron] frontend server started: ${process.env.FRONTEND_URL}`);
    callback();
  });
}

function startBackendThenWindow() {
  const expressApp = require(path.join(__dirname, '..', 'backend', 'index.js'));
  const BACKEND_PORT = 5278;
  server = expressApp.listen(BACKEND_PORT, () => {
    process.env.BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
    console.log(`[electron] backend started: ${process.env.BACKEND_URL}`);
    
    // 如果不是开发模式，启动前端服务器
    console.log(`[electron] VITE_DEV_SERVER_URL: ${process.env.VITE_DEV_SERVER_URL}`);
    if (!process.env.VITE_DEV_SERVER_URL) {
      console.log('[electron] starting frontend server...');
      startFrontendServer(createWindow);
    } else {
      console.log('[electron] using dev server, skipping frontend server');
      createWindow();
    }
  });
}

app.whenReady().then(startBackendThenWindow);
app.on('before-quit', () => { 
  try { 
    server && server.close(); 
    frontendServer && frontendServer.close();
  } catch {} 
});
app.on('window-all-closed', () => { app.quit(); });