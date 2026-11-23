// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CreateVideo } from './CreateVideo';
import { setApiOverride } from '../api';
import type { PodApi, ProviderStatus, JobView, CreateJobInput } from '@shared/ipc';
import { JOB_STATE_LABELS } from '@shared/job-state';

describe('CreateVideo Screen', () => {
  let mockApi: PodApi;
  const mockJobCreate = vi.fn<PodApi['jobs']['create']>();
  let mockProviderStatus: ProviderStatus;

  beforeEach(() => {
    mockJobCreate.mockReset();
    mockJobCreate.mockImplementation(async (input: CreateJobInput) => {
      const jobView: JobView = {
        job: {
          id: 'test-job-uuid',
          productId: 'p1',
          skuSnapshot: input.sku,
          employeeId: 'emp1',
          provider: 'muse',
          providerJobId: null,
          providerReferenceId: null,
          providerAssetId: null,
          sourceAssetId: 's1',
          promptTemplateId: input.templateId,
          promptTemplateVersion: input.templateVersion,
          promptSha256: 'sha',
          promptOverridden: false,
          durationSeconds: input.durationSeconds ?? null,
          aspectRatio: input.aspectRatio ?? null,
          state: 'QUEUED',
          idempotencyKey: input.clientRequestId,
          attempt: 1,
          regeneratedFromJobId: null,
          reviewStatus: 'pending',
          submitIntentAt: null,
          acceptedAt: null,
          completedAt: null,
          errorCode: null,
          safeErrorMessage: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        stateLabel: JOB_STATE_LABELS.QUEUED,
        category: 'T-shirt',
        productName: null,
        sourceUrl: 'pod-media://staged/token',
        videoUrl: null,
        videoAssetId: null,
        elapsedMs: 0,
        progress: null,
        nextActions: ['cancel'],
      };
      return { ok: true, data: jobView };
    });

    mockApi = {
      app: {
        getInfo: vi.fn().mockResolvedValue({
          ok: true,
          data: { version: '0.1.0', employeeId: 'emp1', isAdmin: true, providerMode: 'mock', isDev: true },
        }),
      },
      provider: {
        getStatus: vi.fn(),
        testConnection: vi.fn(),
      },
      images: {
        pick: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            token: 'staged_mock_token',
            fileName: 'mock.png',
            info: { mime: 'image/png', width: 1000, height: 1000, bytes: 50000 },
            previewUrl: 'data:image/png;base64,sample',
          },
        }),
        stageFile: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            token: 'staged_mock_token',
            fileName: 'dropped.png',
            info: { mime: 'image/png', width: 1000, height: 1000, bytes: 50000 },
            previewUrl: 'data:image/png;base64,sample',
          },
        }),
      },
      catalog: {
        listCategories: vi.fn().mockResolvedValue({
          ok: true,
          data: [{ id: 't-shirt', label: 'T-shirt', promptGroup: 'apparel' }],
        }),
      },
      prompts: {
        listTemplates: vi.fn().mockResolvedValue({
          ok: true,
          data: [
            {
              id: 'product-review',
              version: 'v2',
              title: 'Review V2',
              isPlaceholder: false,
              source: 'builtin',
              isDefault: true,
              createdAt: '2026-11-20',
              note: null,
            },
          ],
        }),
        getTemplate: vi.fn(),
        preview: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            text: 'Preview prompt for TS-001',
            chars: 25,
            maxChars: 4000,
            templateId: 'product-review',
            templateVersion: 'v2',
            isPlaceholder: false,
            quality: {
              passed: true,
              checks: [
                { rule: 'preserve_artwork', label: 'Preserves artwork', passed: true },
              ],
            },
            errors: [],
          },
        }),
        validate: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            text: 'Valid prompt override',
            chars: 21,
            maxChars: 4000,
            templateId: 'custom',
            templateVersion: 'custom',
            isPlaceholder: false,
            quality: { passed: true, checks: [] },
            errors: [],
          },
        }),
        saveVersion: vi.fn(),
        setDefault: vi.fn(),
      },
      jobs: {
        create: mockJobCreate,
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

    mockProviderStatus = {
      mode: 'mock',
      state: 'ready',
      capabilities: {
        canCancel: true,
        reportsProgress: true,
        supportedDurations: [5, 10],
        supportedAspectRatios: ['9:16', '16:9', '1:1'],
        maxPromptChars: 4000,
        maxUploadBytes: 50 * 1024 * 1024,
      },
      platformOrigin: 'https://muse.ai',
      bridgeBaseUrl: 'http://127.0.0.1:47821',
      compatibility: 'compatible',
      hasApiKey: true,
      secretStoreAvailable: true,
      checkedAt: new Date().toISOString(),
    };
  });

  it('SKU field shows error for ../x and normalizes ts-001 → TS-001', async () => {
    render(<CreateVideo providerStatus={mockProviderStatus} onJobCreated={vi.fn()} />);

    const skuInput = screen.getByLabelText(/SKU/i);

    // Type invalid SKU with path traversal
    fireEvent.change(skuInput, { target: { value: '../x' } });
    expect(screen.getByText(/SKU may only contain A-Z, 0-9, hyphen and underscore/i)).toBeDefined();

    // Type lowercase valid SKU
    fireEvent.change(skuInput, { target: { value: 'ts-001' } });
    expect(screen.queryByText(/SKU may only contain A-Z, 0-9, hyphen and underscore/i)).toBeNull();
    expect(screen.getByText(/Normalized SKU: TS-001/i)).toBeDefined();
  });

  it('Duration/aspect controls hidden when capabilities are empty, shown when provided', async () => {
    // 1. Render with empty capabilities
    const emptyCapsStatus: ProviderStatus = {
      ...mockProviderStatus,
      capabilities: {
        ...mockProviderStatus.capabilities!,
        supportedDurations: [],
        supportedAspectRatios: [],
      },
    };

    const { unmount } = render(
      <CreateVideo providerStatus={emptyCapsStatus} onJobCreated={vi.fn()} />,
    );

    expect(screen.queryByLabelText(/Duration/i)).toBeNull();
    expect(screen.queryByLabelText(/Aspect Ratio/i)).toBeNull();
    unmount();

    // 2. Render with provided capabilities
    render(<CreateVideo providerStatus={mockProviderStatus} onJobCreated={vi.fn()} />);

    expect(screen.getByLabelText(/Duration/i)).toBeDefined();
    expect(screen.getByLabelText(/Aspect Ratio/i)).toBeDefined();
  });

  it('Generate button: disabled until valid; double click → jobs.create called exactly once; uses the same clientRequestId if the component re-renders', async () => {
    const onJobCreated = vi.fn();
    const { rerender } = render(
      <CreateVideo providerStatus={mockProviderStatus} onJobCreated={onJobCreated} />,
    );

    const generateBtn = screen.getByRole('button', { name: /Generate video/i });
    // Initially disabled because no image staged and no SKU entered
    expect(generateBtn.hasAttribute('disabled')).toBe(true);

    // Stage image via browse button
    const browseBtn = screen.getByRole('button', { name: /Browse…/i });
    fireEvent.click(browseBtn);
    await waitFor(() => {
      expect(screen.getByText(/mock\.png/i)).toBeDefined();
    });

    // Enter valid SKU
    const skuInput = screen.getByLabelText(/SKU/i);
    fireEvent.change(skuInput, { target: { value: 'ts-001' } });

    // Wait for categories and prompt preview to populate
    await waitFor(() => {
      expect(generateBtn.hasAttribute('disabled')).toBe(false);
    });

    // Rerender the component before clicking to verify clientRequestId stability
    rerender(<CreateVideo providerStatus={mockProviderStatus} onJobCreated={onJobCreated} />);
    const generateBtnAfterRerender = screen.getByRole('button', { name: /Generate video/i });
    expect(generateBtnAfterRerender.hasAttribute('disabled')).toBe(false);

    // Double click the button rapidly
    fireEvent.click(generateBtnAfterRerender);
    fireEvent.click(generateBtnAfterRerender);

    await waitFor(() => {
      expect(mockJobCreate).toHaveBeenCalledTimes(1);
    });

    const calls = mockJobCreate.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const callArg = calls[0]?.[0];
    expect(callArg?.sku).toBe('TS-001');
    expect(callArg?.clientRequestId).toBeDefined();
    expect(typeof callArg?.clientRequestId).toBe('string');
    expect(onJobCreated).toHaveBeenCalledWith('test-job-uuid');
  });
});
