import { OpenPanel } from '@openpanel/web';
import type { Router } from 'vue-router';

// OpenPanel Client ID 是公开标识符，可直接写入开源代码。
const CLIENT_ID = '1fc33a58-9762-4aab-908f-be2c16abe0ca';
// 该自托管实例要求客户端上报时携带 client-secret（未开放纯 CORS 白名单上报）。
// 此 Secret 为 write 权限：只能写入埋点，不能读取/导出/删除数据，泄露风险可控，
// 因此可随客户端分发（写入开源代码）。读数据需另用 read 权限的 Secret，绝不放前端。
const CLIENT_SECRET = 'sec_b9789b2940a6313d20aa';
// 自托管实例 API 地址。注意是 /api 前缀，SDK 会拼成 /api/track（看板 https://op.shiroha.tech ）。
const API_URL = 'https://op.shiroha.tech/api';

// 构建期由 vite.config.ts 通过 define 注入。
declare const __APP_VERSION__: string;

let op: OpenPanel | null = null;

/** 运行环境：Electron 渲染进程 vs 普通浏览器（服务器 / Termux 部署）。 */
function detectRuntime(): 'electron' | 'web' {
  try {
    return /Electron/i.test(navigator.userAgent) ? 'electron' : 'web';
  } catch {
    return 'web';
  }
}

/** 开发者本机调试时可设 localStorage.setItem('op_disable','1') 关闭上报。 */
function isDisabled(): boolean {
  try {
    return localStorage.getItem('op_disable') === '1';
  } catch {
    return false;
  }
}

function appVersion(): string {
  try {
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 初始化埋点：SDK 实例、全局维度、router PageView 钩子、app_launch。
 * 在 main.ts 调用一次。任何失败都静默，不影响主功能。
 */
export function initAnalytics(router: Router): void {
  if (isDisabled()) return;
  try {
    op = new OpenPanel({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      apiUrl: API_URL,
      trackScreenViews: false, // hash 路由下手动上报更可控
      trackOutgoingLinks: false,
    });
    op.setGlobalProperties({
      runtime: detectRuntime(),
      app_version: appVersion(),
    });
    registerPageViews(router);
    track('app_launch');
  } catch {
    op = null;
  }
}

/** 注册路由后置钩子，统一上报页面浏览。 */
function registerPageViews(router: Router): void {
  router.afterEach((to) => {
    try {
      const title = (to.meta?.title as string) || (to.name as string) || to.path;
      op?.screenView(to.path, { name: to.name as string, title });
    } catch {
      /* 上报失败忽略 */
    }
  });
}

/** 上报业务事件。内部已 try/catch，调用方无需关心失败。 */
export function track(event: string, props?: Record<string, unknown>): void {
  if (!op) return;
  try {
    op.track(event, props);
  } catch {
    /* 上报失败忽略 */
  }
}
