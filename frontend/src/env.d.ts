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
}
