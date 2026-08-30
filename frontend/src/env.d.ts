/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

type UpdateChannel = 'stable' | 'test';

type LocalePreference = 'zh' | 'en' | 'system';

interface WindowSettings {
  closeToTray: boolean | null;
  locale?: LocalePreference;
}

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
  available?: boolean;
  currentVersion?: string;
  latestVersion?: string;
  recommendedChannel?: UpdateChannel;
}

interface Window {
  windowApi?: {
    getSettings: () => Promise<WindowSettings>;
    setSettings: (settings: WindowSettings) => Promise<WindowSettings>;
  };
  ycyBleApi?: {
    isSupported: () => boolean;
    connect: () => Promise<{
      id: string;
      name: string;
      type: string;
      brand?: string;
      connectionType: string;
      browserDeviceId?: string;
      data?: Record<string, unknown>;
    }>;
    disconnect: (id: string) => Promise<{ ok: boolean; alreadyDisconnected?: boolean }>;
    selectDevice: (deviceId: string) => Promise<{ ok: boolean }>;
    cancelSelection: () => Promise<{ ok: boolean }>;
    onScanResults: (callback: (devices: Array<{ id: string; name: string }>) => void) => () => void;
  };
  provisionApi?: {
    isSupported: () => boolean;
    provision: (
      credentials: { ssid: string; password: string },
      onStatus: (status: { stage: string; message: string; detail?: string }) => void,
    ) => Promise<{ ok: boolean; deviceName: string; stationIp: string }>;
    selectDevice: (deviceId: string) => Promise<{ ok: boolean }>;
    cancelSelection: () => Promise<{ ok: boolean }>;
    onScanResults: (callback: (devices: Array<{ id: string; name: string }>) => void) => () => void;
  };
  bleApi?: {
    isSupported: () => boolean;
    connect: () => Promise<{
      id: string;
      name: string;
      type: string;
      connectionType: 'ble';
      firmwareVersion: string | null;
      legacyIdentity: boolean;
      browserDeviceId: string;
      data: Record<string, unknown>;
    }>;
    disconnect: (id: string) => Promise<{ ok: boolean; alreadyDisconnected?: boolean }>;
    disconnectAll: () => Promise<{ ok: boolean }>;
    connectedDeviceIds: () => string[];
    selectDevice: (deviceId: string) => Promise<{ ok: boolean }>;
    cancelSelection: () => Promise<{ ok: boolean }>;
    onScanResults: (callback: (devices: Array<{ id: string; name: string }>) => void) => () => void;
  };
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
  localAppWindowApi?: {
    open: (payload: { url: string; id: string; title?: string; locale?: 'zh' | 'en' }) => Promise<{ ok: boolean; error?: string }>;
    close: () => Promise<{ ok: boolean }>;
    focus: () => Promise<{ ok: boolean }>;
    onClosed: (cb: (data?: { id?: string }) => void) => () => void;
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
