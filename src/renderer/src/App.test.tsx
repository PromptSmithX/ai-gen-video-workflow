// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './App';
import { setApiOverride } from './api';
import type { PodApi } from '@shared/ipc';

describe('App Component', () => {
  let mockApi: PodApi;

  beforeEach(() => {
    mockApi = {
      app: {
        getInfo: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            version: '0.1.0',
            employeeId: 'emp_test',
            isAdmin: false,
            providerMode: 'mock',
            isDev: true,
          },
        }),
      },
      provider: {
        getStatus: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            mode: 'mock',
            state: 'ready',
            capabilities: null,
            platformOrigin: 'https://muse.ai',
            bridgeBaseUrl: 'http://127.0.0.1:47821',
            compatibility: 'compatible',
            hasApiKey: true,
            secretStoreAvailable: true,
            checkedAt: new Date().toISOString(),
          },
        }),
        testConnection: vi.fn(),
        setupAction: vi.fn(),
      },
      images: {
        pick: vi.fn(),
        stageFile: vi.fn(),
      },
      catalog: {
        listCategories: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      },
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
        list: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        get: vi.fn(),
        retry: vi.fn(),
        regenerate: vi.fn(),
        resolveAmbiguous: vi.fn(),
        retryDownload: vi.fn(),
        cancel: vi.fn(),
        setReview: vi.fn(),
        onUpdated: vi.fn().mockReturnValue(() => {}),
      },
      library: {
        openFolder: vi.fn(),
        copyPath: vi.fn(),
      },
      admin: {
        getSettings: vi.fn(),
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

  it('renders sidebar and topbar, hiding Admin tab when non-admin', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Create video/i })).toBeDefined();
    });

    expect(screen.getByRole('button', { name: /^Queue/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^Library/i })).toBeDefined();

    // Non-admin should not see Admin button in sidebar
    expect(screen.queryByRole('button', { name: /^Admin/i })).toBeNull();
  });

  it('shows Admin nav link when user is admin', async () => {
    mockApi.app.getInfo = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        version: '0.1.0',
        employeeId: 'emp_admin',
        isAdmin: true,
        providerMode: 'mock',
        isDev: true,
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Admin/i })).toBeDefined();
    });
  });

  it('navigates between screens when clicking sidebar items', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Create video/i })).toBeDefined();
    });

    // Click Queue
    const queueBtn = screen.getByRole('button', { name: /^Queue/i });
    fireEvent.click(queueBtn);

    await waitFor(() => {
      expect(screen.getByText(/Generation Queue/i)).toBeDefined();
    });

    // Click Library
    const libBtn = screen.getByRole('button', { name: /^Library/i });
    fireEvent.click(libBtn);

    await waitFor(() => {
      expect(screen.getByText(/Video Library/i)).toBeDefined();
    });
  });
});
