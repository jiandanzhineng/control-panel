import { createRouter, createWebHashHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import HomeView from '../views/HomeView.vue';
import ServicesView from '../views/ServicesView.vue';
import DevicesView from '../views/DevicesView.vue';
import PlayLibraryView from '../views/PlayLibraryView.vue';
import PlayConfigView from '../views/PlayConfigView.vue';
import GameCurrentView from '../views/GameCurrentView.vue';
import PluginRunView from '../views/PluginRunView.vue';
import BrowserView from '../views/BrowserView.vue';
import LogManagement from '../views/LogManagement.vue';
import AutoTest from '../views/AutoTest.vue';
import FirmwareBatchUpgrade from '../views/FirmwareBatchUpgrade.vue';
import FirmwareUpdate from '../views/FirmwareUpdate.vue';
import WiredFlashUpdate from '../views/WiredFlashUpdate.vue';
import AccountView from '../views/AccountView.vue';
import CustomerServiceView from '../views/CustomerServiceView.vue';
import SettingsView from '../views/SettingsView.vue';

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

  // 本地游戏（游戏 + 插件统一入口）
  { path: '/plays', name: 'play_library', component: PlayLibraryView, meta: { titleKey: 'nav.plays' } },
  { path: '/plays/:type/:id/config', name: 'play_config', component: PlayConfigView, meta: { titleKey: 'playConfig.title' } },
  // 运行态（全屏覆盖层，靠「启动」进入、「停止」退出，不进侧边栏）
  { path: '/plays/game/current', name: 'game_current', component: GameCurrentView, meta: { titleKey: 'gameRun.title' } },
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
