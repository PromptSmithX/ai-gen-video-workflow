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
  const mockPromptPreview = vi.fn<PodApi['prompts']['preview']>();
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

    mockPromptPreview.mockReset();
    mockPromptPreview.mockImplementation(async (input) => ({
      ok: true,
      data: {
        text: `Preview prompt for ${input.sku} with template ${input.templateId} (${input.templateVersion ?? 'v1'})`,
        chars: 40,
        maxChars: 4000,
        templateId: input.templateId,
        templateVersion: input.templateVersion ?? 'v1',
        isPlaceholder: false,
        quality: {
          passed: true,
          checks: [
            { rule: 'preserve_artwork', label: 'Preserves original artwork and text', passed: true },
            { rule: 'no_design_changes', label: 'No redesign, recolor, or repositioning', passed: true },
          ],
        },
        errors: [],
      },
    }));

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
              version: 'v1',
              title: 'Product Review',
              isPlaceholder: false,
              source: 'builtin',
              isDefault: false,
              createdAt: '2026-11-10',
              note: null,
            },
            {
              id: 'product-review',
              version: 'v2',
              title: 'Product Review',
              isPlaceholder: false,
              source: 'builtin',
              isDefault: true,
              createdAt: '2026-11-20',
              note: null,
            },
          ],
        }),
        getTemplate: vi.fn(),
        preview: mockPromptPreview,
        validate: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            text: 'Valid prompt override text',
            chars: 25,
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

  it('Template selection: fake list [v1, v2(isDefault)] -> preview and jobs.create receive templateVersion "v2"', async () => {
    render(<CreateVideo providerStatus={mockProviderStatus} onJobCreated={vi.fn()} />);

    // Stage image via browse
    fireEvent.click(screen.getByRole('button', { name: /Browse…/i }));
    await waitFor(() => {
      expect(screen.getByText(/mock\.png/i)).toBeDefined();
    });

    // Enter valid SKU
    fireEvent.change(screen.getByLabelText(/SKU/i), { target: { value: 'TS-001' } });

    // Verify template select defaults to v2 (isDefault) and options show title — version
    await waitFor(() => {
      const select = screen.getByLabelText(/Prompt Template/i) as HTMLSelectElement;
      expect(select.value).toBe('product-review@@v2');
      expect(screen.getByText(/Product Review — v2/i)).toBeDefined();
    });

    // Wait for debounced preview call
    await waitFor(() => {
      expect(mockPromptPreview).toHaveBeenCalledWith(
        expect.objectContaining({
          templateId: 'product-review',
          templateVersion: 'v2',
        }),
      );
    });

    // Click Generate video
    const generateBtn = screen.getByRole('button', { name: /Generate video/i });
    await waitFor(() => {
      expect(generateBtn.hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(generateBtn);

    await waitFor(() => {
      expect(mockJobCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          templateId: 'product-review',
          templateVersion: 'v2',
        }),
      );
    });
  });

  it('Generate button requires renderedPrompt.quality.passed === true and displays failed checks', async () => {
    // Mock prompt preview returning quality.passed === false
    mockPromptPreview.mockImplementation(async (input) => ({
      ok: true,
      data: {
        text: `Prompt with bad quality for ${input.sku}`,
        chars: 23,
        maxChars: 4000,
        templateId: input.templateId,
        templateVersion: input.templateVersion ?? 'v2',
        isPlaceholder: false,
        quality: {
          passed: false,
          checks: [
            { rule: 'preserve_artwork', label: 'Preserves original artwork and text', passed: false },
            { rule: 'no_design_changes', label: 'No redesign, recolor, or repositioning', passed: true },
          ],
        },
        errors: [],
      },
    }));

    render(<CreateVideo providerStatus={mockProviderStatus} onJobCreated={vi.fn()} />);

    // Stage image & SKU
    fireEvent.click(screen.getByRole('button', { name: /Browse…/i }));
    await waitFor(() => {
      expect(screen.getByText(/mock\.png/i)).toBeDefined();
    });
    fireEvent.change(screen.getByLabelText(/SKU/i), { target: { value: 'TS-001' } });

    const generateBtn = screen.getByRole('button', { name: /Generate video/i });

    // Wait for prompt preview to load with failed quality
    await waitFor(() => {
      expect(screen.getByText(/Generation blocked — quality checks failed:/i)).toBeDefined();
      expect(screen.getAllByText(/Preserves original artwork and text/i).length).toBeGreaterThanOrEqual(2);
    });

    // Generate button MUST be disabled when quality check fails!
    expect(generateBtn.hasAttribute('disabled')).toBe(true);
  });

  it('Dropzone keyboard handler: Enter and Space trigger Browse', async () => {
    const { unmount } = render(<CreateVideo providerStatus={mockProviderStatus} onJobCreated={vi.fn()} />);

    let dropzone = screen.getByLabelText(/Upload mockup image dropzone/i);

    // Press Enter
    fireEvent.keyDown(dropzone, { key: 'Enter' });
    await waitFor(() => {
      expect(mockApi.images.pick).toHaveBeenCalledTimes(1);
    });
    unmount();

    // Re-render and test Space
    render(<CreateVideo providerStatus={mockProviderStatus} onJobCreated={vi.fn()} />);
    dropzone = screen.getByLabelText(/Upload mockup image dropzone/i);
    fireEvent.keyDown(dropzone, { key: ' ' });
    await waitFor(() => {
      expect(mockApi.images.pick).toHaveBeenCalledTimes(2);
    });
  });

  it('clientRequestIdRef: preserved after failed create, reset to new UUID after successful create', async () => {
    let shouldFail = true;
    mockJobCreate.mockImplementation(async (_input: CreateJobInput) => {
      if (shouldFail) {
        return {
          ok: false,
          error: { code: 'PROVIDER_ERROR', message: 'Temporary submission error' },
        };
      }
      return {
        ok: true,
        data: {
          job: {
            id: 'job-success',
            skuSnapshot: 'TS-001',
            idempotencyKey: _input.clientRequestId,
          } as unknown as JobView['job'],
          stateLabel: 'Queued',
          category: 'T-shirt',
          productName: null,
          sourceUrl: null,
          videoUrl: null,
          videoAssetId: null,
          elapsedMs: 0,
          progress: null,
          nextActions: [],
        },
      };
    });

    render(<CreateVideo providerStatus={mockProviderStatus} onJobCreated={vi.fn()} />);

    // Stage image and SKU
    fireEvent.click(screen.getByRole('button', { name: /Browse…/i }));
    await waitFor(() => expect(screen.getByText(/mock\.png/i)).toBeDefined());
    fireEvent.change(screen.getByLabelText(/SKU/i), { target: { value: 'TS-001' } });

    const generateBtn = screen.getByRole('button', { name: /Generate video/i });
    await waitFor(() => expect(generateBtn.hasAttribute('disabled')).toBe(false));

    // First attempt -> Fails
    fireEvent.click(generateBtn);
    await waitFor(() => {
      expect(mockJobCreate).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Temporary submission error/i)).toBeDefined();
    });

    const firstRequestId = mockJobCreate.mock.calls[0]?.[0]?.clientRequestId;
    expect(firstRequestId).toBeDefined();

    // Second attempt -> Fails again, verifies clientRequestId is KEPT IDENTICAL for safe retry
    fireEvent.click(generateBtn);
    await waitFor(() => {
      expect(mockJobCreate).toHaveBeenCalledTimes(2);
    });
    const secondRequestId = mockJobCreate.mock.calls[1]?.[0]?.clientRequestId;
    expect(secondRequestId).toBe(firstRequestId);

    // Third attempt -> Succeeds
    shouldFail = false;
    fireEvent.click(generateBtn);
    await waitFor(() => {
      expect(mockJobCreate).toHaveBeenCalledTimes(3);
    });

    // Next time Generate is invoked, clientRequestIdRef has been reset to a fresh UUID
    shouldFail = true;
    fireEvent.click(generateBtn);
    await waitFor(() => {
      expect(mockJobCreate).toHaveBeenCalledTimes(4);
    });
    const fourthRequestId = mockJobCreate.mock.calls[3]?.[0]?.clientRequestId;
    expect(fourthRequestId).not.toBe(firstRequestId);
  });

  it('Warns when prompt override was edited and template/category/SKU is changed', async () => {
    render(<CreateVideo providerStatus={mockProviderStatus} onJobCreated={vi.fn()} />);

    // Stage image and SKU
    fireEvent.click(screen.getByRole('button', { name: /Browse…/i }));
    await waitFor(() => expect(screen.getByText(/mock\.png/i)).toBeDefined());
    fireEvent.change(screen.getByLabelText(/SKU/i), { target: { value: 'TS-001' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Edit prompt/i })).toBeDefined();
    });

    // Click "Edit prompt"
    fireEvent.click(screen.getByRole('button', { name: /Edit prompt/i }));
    expect(screen.getByLabelText(/Editable prompt text/i)).toBeDefined();

    // Stale warning should not be present initially
    expect(
      screen.queryByText(/The prompt override was edited for a different SKU, category, or template/i),
    ).toBeNull();

    // Now change the SKU to a different product
    fireEvent.change(screen.getByLabelText(/SKU/i), { target: { value: 'TS-999' } });

    // Warning should now be shown asking to reset
    await waitFor(() => {
      expect(
        screen.getByText(/The prompt override was edited for a different SKU, category, or template/i),
      ).toBeDefined();
    });

    // Click "Reset to template"
    const resetBtns = screen.getAllByRole('button', { name: /Reset to template/i });
    fireEvent.click(resetBtns[0]!);

    // Warning is dismissed and editor returned to preview mode
    await waitFor(() => {
      expect(
        screen.queryByText(/The prompt override was edited for a different SKU, category, or template/i),
      ).toBeNull();
    });
  });
});
