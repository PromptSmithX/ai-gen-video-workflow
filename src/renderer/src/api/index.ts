import type { PodApi } from '@shared/ipc';
import { fakeApi } from './fake-api';

let apiOverride: PodApi | null = null;

/** For testing or mocking */
export function setApiOverride(api: PodApi | null): void {
  apiOverride = api;
}

export function isFakeApi(): boolean {
  if (apiOverride) return false;
  if (typeof window !== 'undefined' && window.api && Object.keys(window.api).length > 0) {
    return false;
  }
  return true;
}

export function getApi(): PodApi {
  if (apiOverride) {
    return apiOverride;
  }
  if (typeof window !== 'undefined' && window.api && Object.keys(window.api).length > 0) {
    return window.api;
  }
  return fakeApi;
}

export { fakeApi };
