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
  { path: '/home', name: 'home', component: HomeView },
  { path: '/services', name: 'services', component: ServicesView },
  { path: '/devices', name: 'devices', component: DevicesView },
  { path: '/gamelist', name: 'gamelist', component: GameListView },
  { path: '/games/current', name: 'game_current', component: GameCurrentView },
  { path: '/games/:id/config', name: 'game_config', component: GameStartConfigView },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});