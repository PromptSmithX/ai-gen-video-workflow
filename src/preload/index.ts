// PHASE 0 SKELETON — owned by W6. Must expose exactly `window.api: PodApi` via contextBridge.
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('api', {});
