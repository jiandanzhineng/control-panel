/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

type UpdateChannel = 'stable' | 'test';

interface UpdateSettings {
  receiveTestUpdates: boolean;
}

interface UpdateStatus {
  settings: UpdateSettings;
  channel: UpdateChannel;
  feedUrl: string;
  skipped?: boolean;
  reason?: string;
  result?: boolean;
  error?: string;
}

interface Window {
  updateApi?: {
    getSettings: () => Promise<UpdateStatus>;
    setSettings: (settings: UpdateSettings) => Promise<UpdateStatus>;
    checkForUpdates: () => Promise<UpdateStatus>;
  };
  pluginApi?: {
    getRuntimeInfo: (pluginId: string) => Promise<{
      id: string;
      homeUrl: string;
      matchUrls: string[];
      detectorPath: string;
      detectorUrl: string;
      activePluginPath: string;
      bridgeUrl: string;
    }>;
    stopCurrent: () => Promise<{ ok: boolean; error?: string }>;
  };
  browserDeviceApi?: {
    getGrantStatus: () => Promise<{ ok: boolean; granted?: boolean; origin?: string; expiresAt?: number; error?: string }>;
    getGrantStatusForWebview: (webContentsId: number) => Promise<{ ok: boolean; granted?: boolean; origin?: string; expiresAt?: number; error?: string }>;
    revokeAccess: () => Promise<{ ok: boolean; origin?: string; error?: string }>;
    revokeAccessForWebview: (webContentsId: number) => Promise<{ ok: boolean; origin?: string; error?: string }>;
    stopOrigin: () => Promise<{ ok: boolean; origin?: string; error?: string }>;
    stopOriginForWebview: (webContentsId: number) => Promise<{ ok: boolean; origin?: string; error?: string }>;
  };
}
