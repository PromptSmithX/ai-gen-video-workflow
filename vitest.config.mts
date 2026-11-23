import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@renderer': resolve(import.meta.dirname, 'src/renderer/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts'],
    // Renderer component tests opt into jsdom with: // @vitest-environment jsdom
    testTimeout: 20000,
  },
});
