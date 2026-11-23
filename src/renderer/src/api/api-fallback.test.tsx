// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from '../App';
import { setApiOverride, isBackendUnavailable, isFakeApi, getApi } from './index';

describe('API fallback and Production Backend Unavailable', () => {
  beforeEach(() => {
    setApiOverride(null);
  });

  it('in non-prod, isFakeApi() is true when window.api is missing', () => {
    expect(isFakeApi()).toBe(true);
    expect(isBackendUnavailable()).toBe(false);
  });

  it('in prod, never falls back to fakeApi and marks backend unavailable', () => {
    const originalProd = import.meta.env.PROD;
    try {
      // Emulate production environment
      (import.meta.env as { PROD: boolean }).PROD = true;

      expect(isFakeApi()).toBe(false);
      expect(isBackendUnavailable()).toBe(true);

      // getApi throws when backend is unavailable in prod
      expect(() => getApi()).toThrow(/Application backend is unavailable/i);

      // App renders blocking error in prod
      render(<App />);
      expect(screen.getByText(/Application backend is unavailable/i)).toBeDefined();
    } finally {
      (import.meta.env as { PROD: boolean }).PROD = originalProd;
    }
  });

  it('setApiOverride allows testing even in prod mode', () => {
    const originalProd = import.meta.env.PROD;
    try {
      (import.meta.env as { PROD: boolean }).PROD = true;

      const mockApi = {
        app: { getInfo: vi.fn().mockResolvedValue({ ok: true, data: { version: '0.1.0' } }) },
      } as unknown as ReturnType<typeof getApi>;

      setApiOverride(mockApi);
      expect(isBackendUnavailable()).toBe(false);
      expect(getApi()).toBe(mockApi);
    } finally {
      (import.meta.env as { PROD: boolean }).PROD = originalProd;
      setApiOverride(null);
    }
  });
});
