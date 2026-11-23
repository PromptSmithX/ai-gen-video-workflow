// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Admin } from './Admin';
import { setApiOverride } from '../api';
import type { PodApi, ProviderStatus } from '@shared/ipc';
import { ToastProvider } from '../components/Toast';

describe('Admin Screen', () => {
  let mockApi: PodApi;
  const mockProviderStatus: ProviderStatus = {
    mode: 'mock',
    state: 'ready',
    capabilities: null,
    platformOrigin: 'https://muse.ai',
    bridgeBaseUrl: 'http://127.0.0.1:47821',
    compatibility: 'compatible',
    hasApiKey: true,
    secretStoreAvailable: true,
    checkedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    mockApi = {
      app: { getInfo: vi.fn() },
      provider: { getStatus: vi.fn(), testConnection: vi.fn() },
      images: { pick: vi.fn(), stageFile: vi.fn() },
      catalog: { listCategories: vi.fn() },
      prompts: {
        listTemplates: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        getTemplate: vi.fn(),
        preview: vi.fn(),
        validate: vi.fn(),
        saveVersion: vi.fn(),
        setDefault: vi.fn(),
      },
      jobs: {
        create: vi.fn(),
        list: vi.fn(),
        get: vi.fn(),
        retry: vi.fn(),
        regenerate: vi.fn(),
        resolveAmbiguous: vi.fn(),
        retryDownload: vi.fn(),
        cancel: vi.fn(),
        setReview: vi.fn(),
        onUpdated: vi.fn().mockReturnValue(() => {}),
      },
      library: { openFolder: vi.fn(), copyPath: vi.fn() },
      admin: {
        getSettings: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            bridgeBaseUrl: 'http://127.0.0.1:47821',
            musePlatformOrigin: 'https://muse.ai',
            libraryRoot: 'C:\\POD_VIDEO_LIBRARY',
            logRetentionDays: 30,
            categories: [],
            adminUsers: ['admin'],
            defaultTemplateId: null,
            defaultTemplateVersion: null,
          },
        }),
        updateSettings: vi.fn(),
        setBridgeApiKey: vi.fn(),
        clearBridgeApiKey: vi.fn(),
        diagnosticsPreview: vi.fn(),
        diagnosticsExport: vi.fn(),
        runCleanup: vi.fn(),
      },
    };
    setApiOverride(mockApi);
  });

  it('Admin screen not rendered for non-admin', () => {
    // Non-admin render
    render(
      <ToastProvider>
        <Admin
          isAdmin={false}
          providerStatus={mockProviderStatus}
          onProviderStatusChange={vi.fn()}
        />
      </ToastProvider>,
    );

    // Verify admin tabs and controls are NOT rendered
    expect(screen.queryByRole('tab', { name: /Provider Settings/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Prompt Master/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Categories & Storage/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Diagnostics & Cleanup/i })).toBeNull();

    // Verify Access Denied message
    expect(screen.getByText(/Only administrators can access this screen/i)).toBeDefined();
  });

  it('Admin screen is rendered for admin', async () => {
    // Admin render
    render(
      <ToastProvider>
        <Admin
          isAdmin={true}
          providerStatus={mockProviderStatus}
          onProviderStatusChange={vi.fn()}
        />
      </ToastProvider>,
    );

    // Verify admin tabs are rendered
    expect(screen.getByRole('tab', { name: /Provider Settings/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /Prompt Master/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /Categories & Storage/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /Diagnostics & Cleanup/i })).toBeDefined();
  });
});
