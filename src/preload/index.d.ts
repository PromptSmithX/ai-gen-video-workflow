import type { PodApi } from '../shared/ipc';

declare global {
  interface Window {
    api: PodApi;
  }
}

export {};
