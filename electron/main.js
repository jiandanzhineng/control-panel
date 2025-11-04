const path = require('path');
const { app, BrowserWindow } = require('electron');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');

let server;
let frontendServer;

// 获取资源路径，兼容开发和打包环境
function getResourcePath(relativePath) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, relativePath);
  }
  return path.join(__dirname, '..', relativePath);
}

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
    const appPath = app.isPackaged ? app.getAppPath() : path.join(__dirname, '..');
    const indexPath = path.join(appPath, 'frontend', 'dist', 'index.html');
    
    console.log(`[electron] Loading index.html from: ${indexPath}`);
    if (fs.existsSync(indexPath)) {
      win.loadFile(indexPath);
    } else {
      console.error(`[electron] Index file not found: ${indexPath}`);
      win.loadURL('data:text/html,<h1>Frontend files not found</h1>');
    }
  }
}

function startFrontendServer(callback) {
  const frontendApp = express();
  const appPath = app.isPackaged ? app.getAppPath() : path.join(__dirname, '..');
  const distPath = path.join(appPath, 'frontend', 'dist');
  
  console.log(`[electron] Frontend dist path: ${distPath}`);
  
  if (!fs.existsSync(distPath)) {
    console.error(`[electron] Frontend dist directory not found: ${distPath}`);
    callback();
    return;
  }
  
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
  try {
    const appPath = app.isPackaged ? app.getAppPath() : path.join(__dirname, '..');
    const backendPath = path.join(appPath, 'backend', 'index.js');
    const userDataDir = app.getPath('userData');
    process.env.BACKEND_DATA_DIR = path.join(userDataDir, 'data');
    
    console.log(`[electron] Backend path: ${backendPath}`);
    
    if (!fs.existsSync(backendPath)) {
      console.error(`[electron] Backend file not found: ${backendPath}`);
      createWindow(); // 即使后端启动失败也创建窗口
      return;
    }
    
    const expressApp = require(backendPath);
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
    
    server.on('error', (err) => {
      console.error('[electron] Backend server error:', err);
      createWindow(); // 后端启动失败时仍然创建窗口
    });
  } catch (error) {
    console.error('[electron] Error starting backend:', error);
    createWindow(); // 出现异常时仍然创建窗口
  }
}

app.whenReady().then(startBackendThenWindow);
app.on('before-quit', () => { 
  try { 
    server && server.close(); 
    frontendServer && frontendServer.close();
  } catch {} 
});
app.on('window-all-closed', () => { app.quit(); });