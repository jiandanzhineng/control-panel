import { createRouter, createWebHashHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
const HomeView = () => import('../views/HomeView.vue');
const ServicesView = () => import('../views/ServicesView.vue');
const DevicesView = () => import('../views/DevicesView.vue');
const PlayLibraryView = () => import('../views/PlayLibraryView.vue');
const PlayConfigView = () => import('../views/PlayConfigView.vue');
const GameCurrentView = () => import('../views/GameCurrentView.vue');
const GameRuntimeView = () => import('../views/GameRuntimeView.vue');
const RemoteGameWorkspaceView = () => import('../views/RemoteGameWorkspaceView.vue');
const RemoteSessionView = () => import('../views/RemoteSessionView.vue');
const PluginRunView = () => import('../views/PluginRunView.vue');
const BrowserView = () => import('../views/BrowserView.vue');
const LogManagement = () => import('../views/LogManagement.vue');
const AutoTest = () => import('../views/AutoTest.vue');
const FirmwareBatchUpgrade = () => import('../views/FirmwareBatchUpgrade.vue');
const FirmwareUpdate = () => import('../views/FirmwareUpdate.vue');
const WiredFlashUpdate = () => import('../views/WiredFlashUpdate.vue');
const AccountView = () => import('../views/AccountView.vue');
const CustomerServiceView = () => import('../views/CustomerServiceView.vue');
const SettingsView = () => import('../views/SettingsView.vue');

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/home' },
  { path: '/home', name: 'home', component: HomeView, meta: { titleKey: 'nav.home' } },
  { path: '/devices', name: 'devices', component: DevicesView, meta: { titleKey: 'nav.devices' } },
  // 品牌设备已并入设备管理页的「品牌设备」标签
  { path: '/brands', redirect: '/devices' },
  {
    path: '/devices/firmware',
    component: FirmwareUpdate,
    meta: { titleKey: 'firmware.title' },
    children: [
      { path: '', redirect: '/devices/firmware/ota' },
      { path: 'ota', name: 'firmware_ota', component: FirmwareBatchUpgrade, meta: { titleKey: 'firmware.ota' } },
      { path: 'wired', name: 'firmware_wired', component: WiredFlashUpdate, meta: { titleKey: 'firmware.wired' } },
    ],
  },
  // 旧路径重定向（合并前的独立页面地址）
  { path: '/devices/firmware-batch', redirect: '/devices/firmware/ota' },
  { path: '/devices/wired-flash', redirect: '/devices/firmware/wired' },
  // 远程投影已并入设备管理页的「远程连接」标签
  { path: '/remote-projection', redirect: '/devices' },
  { path: '/test', name: 'test', component: AutoTest, meta: { titleKey: 'autoTest.platform' } },

  // 游戏库（游戏 + 插件 + 本机应用统一入口）
  { path: '/plays', name: 'play_library', component: PlayLibraryView, meta: { titleKey: 'nav.plays' } },
  { path: '/plays/:type/:id/config', name: 'play_config', component: PlayConfigView, meta: { titleKey: 'playConfig.title' } },
  // 运行态（全屏覆盖层，靠「启动」进入、「停止」退出，不进侧边栏）
  { path: '/plays/game/current', name: 'game_current', component: GameCurrentView, meta: { titleKey: 'gameRun.title' } },
  { path: '/plays/game/runtime', name: 'game_runtime', component: GameRuntimeView, meta: { titleKey: 'gameRun.title' } },
  { path: '/remote-game', name: 'remote_game', component: RemoteGameWorkspaceView, meta: { titleKey: 'remoteGame.title' } },
  { path: '/remote', name: 'remote_session', component: RemoteSessionView, meta: { titleKey: 'nav.remote' } },
  { path: '/plays/plugin/:id/run', name: 'plugin_run', component: PluginRunView, meta: { titleKey: 'pluginRun.title' } },

  { path: '/browser', name: 'browser', component: BrowserView, meta: { titleKey: 'nav.browser' } },
  { path: '/network', name: 'network', component: ServicesView, meta: { titleKey: 'nav.network' } },
  { path: '/account', name: 'account', component: AccountView, meta: { titleKey: 'nav.account' } },
  { path: '/settings', name: 'settings', component: SettingsView, meta: { titleKey: 'nav.settings' } },
  { path: '/logs', name: 'logs', component: LogManagement, meta: { titleKey: 'nav.logs' } },
  { path: '/support', name: 'support', component: CustomerServiceView, meta: { titleKey: 'nav.support' } },

  // 旧路径重定向（沿用 /gamelist→/games 的做法，保留外链/书签可用）
  { path: '/games', redirect: '/plays' },
  { path: '/games/current', redirect: '/plays/game/current' },
  { path: '/games/:id/config', redirect: (to) => `/plays/game/${to.params.id}/config` },
  { path: '/plugins', redirect: '/plays' },
  { path: '/plugins/:id/config', redirect: (to) => `/plays/plugin/${to.params.id}/config` },
  { path: '/plugins/:id/run', redirect: (to) => `/plays/plugin/${to.params.id}/run` },
  { path: '/gamelist', redirect: '/games' },
  { path: '/services', redirect: '/network' },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

// 客户端控制：把当前页面（含 query）上报给 Electron 主进程，供 /api/client/state 与事件流使用。
router.afterEach((to) => {
  const clientApi = (window as any).clientApi;
  if (clientApi && typeof clientApi.reportRoute === 'function') {
    clientApi.reportRoute(to.fullPath);
  }
});

// 主控端远程模式下：被锁页面直接拦下并提示（与侧栏置灰同一份规则）。
router.beforeEach(async (to) => {
  const { useRemoteSession } = await import('../composables/useRemoteSession');
  const { isRouteLocked } = await import('../remote/remoteLock');
  const { isOperatorRemote } = useRemoteSession();
  if (!isRouteLocked(to.path, isOperatorRemote.value)) return true;
  const { ElMessage } = await import('element-plus');
  const { getI18n } = await import('../i18n');
  ElMessage.warning(getI18n().global.t('remoteSession.lock.menu'));
  return false;
});
