import { readonly, ref } from 'vue';
import type { RouteLocationRaw } from 'vue-router';

/**
 * 当前活跃玩法（会话级前端态）。
 *
 * 为什么用前端态而非查后端：后端 /api/games/status 目前是返回 {running:false} 的桩，
 * 且本方案明确「不改后端」。改造前的「当前游戏」同样是会话内 ephemeral 态（靠路由 query 注入、
 * 刷新即丢失）。这里延续同一语义：在玩法启动时 set、显式停止时 clear，供玩法库页顶部
 * 「当前运行」提示条使用。
 */
export type CarrierType = 'game' | 'plugin' | 'local-app';

export interface ActivePlay {
  carrierType: CarrierType;
  id: string;
  title: string;
  /** 「返回运行页」用的路由位置：游戏需回放 query，插件仅需 id */
  resume: RouteLocationRaw;
  /** 本机应用：返回时聚焦独立窗口，不走路由 */
  resumeWindow?: boolean;
}

const activePlay = ref<ActivePlay | null>(null);

export function setActivePlay(play: ActivePlay): void {
  activePlay.value = play;
}

export function clearActivePlay(): void {
  activePlay.value = null;
}

export function useActivePlay() {
  return { activePlay: readonly(activePlay) };
}
