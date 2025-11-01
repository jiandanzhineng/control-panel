import { createRouter, createWebHashHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import HomeView from '../views/HomeView.vue';
import ServicesView from '../views/ServicesView.vue';
import DevicesView from '../views/DevicesView.vue';
import GameListView from '../views/GameListView.vue';
import GameCurrentView from '../views/GameCurrentView.vue';
import GameStartConfigView from '../views/GameStartConfigView.vue';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/home' },
  { path: '/home', name: 'home', component: HomeView, meta: { title: '首页' } },
  { path: '/devices', name: 'devices', component: DevicesView, meta: { title: '设备管理' } },
  { path: '/games', name: 'games', component: GameListView, meta: { title: '游戏管理' } },
  { path: '/games/current', name: 'game_current', component: GameCurrentView, meta: { title: '当前游戏' } },
  { path: '/games/:id/config', name: 'game_config', component: GameStartConfigView, meta: { title: '游戏配置' } },
  { path: '/network', name: 'network', component: ServicesView, meta: { title: '网络设置' } },
  // 保留旧路径的重定向
  { path: '/gamelist', redirect: '/games' },
  { path: '/services', redirect: '/network' },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});