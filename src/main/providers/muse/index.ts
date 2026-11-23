/**
 * Muse Provider module root.
 * Exports the factory function `createMuseProvider` and relevant classes/helpers.
 */
import type { MuseProviderFactory } from '@shared/services';
import { MockMuseProvider } from './mock';
import { RestBridgeMuseProvider } from './rest-bridge';

export { MockMuseProvider } from './mock';
export { RestBridgeMuseProvider } from './rest-bridge';
export { nextPollDelay } from './poll';
export { createMinimalValidMp4, isValidMp4Buffer } from './mp4';

/**
 * Creates a MuseProvider instance based on configuration.
 * Returns MockMuseProvider when providerMode === 'mock', otherwise RestBridgeMuseProvider.
 */
export const createMuseProvider: MuseProviderFactory = (deps) => {
  if (deps.config.providerMode === 'mock') {
    return new MockMuseProvider();
  }
  return new RestBridgeMuseProvider(deps);
};
