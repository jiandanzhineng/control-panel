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
import AccountView from '../views/AccountView.vue';
import GameDevGuideView from '../views/GameDevGuideView.vue';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/home' },
  { path: '/home', name: 'home', component: HomeView, meta: { title: '首页' } },
  { path: '/devices', name: 'devices', component: DevicesView, meta: { title: '设备管理' } },
  { path: '/devices/firmware-batch', name: 'firmware_batch', component: FirmwareBatchUpgrade, meta: { title: '批量固件升级' } },
  { path: '/test', name: 'test', component: AutoTest, meta: { title: '自动化测试' } },

  // 本地游戏（游戏 + 插件统一入口）
  { path: '/plays', name: 'play_library', component: PlayLibraryView, meta: { title: '本地游戏' } },
  { path: '/plays/dev-guide', name: 'game_dev_guide', component: GameDevGuideView, meta: { title: '游戏开发指南' } },
  { path: '/plays/:type/:id/config', name: 'play_config', component: PlayConfigView, meta: { title: '玩法配置' } },
  // 运行态（全屏覆盖层，靠「启动」进入、「停止」退出，不进侧边栏）
  { path: '/plays/game/current', name: 'game_current', component: GameCurrentView, meta: { title: '玩法运行' } },
  { path: '/plays/plugin/:id/run', name: 'plugin_run', component: PluginRunView, meta: { title: '插件运行' } },

  { path: '/browser', name: 'browser', component: BrowserView, meta: { title: '在线游戏' } },
  { path: '/network', name: 'network', component: ServicesView, meta: { title: '网络设置' } },
  { path: '/account', name: 'account', component: AccountView, meta: { title: '账号' } },
  { path: '/logs', name: 'logs', component: LogManagement, meta: { title: '日志管理' } },

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
