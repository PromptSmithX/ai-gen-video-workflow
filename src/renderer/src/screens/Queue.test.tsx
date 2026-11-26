// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Queue } from './Queue';
import { setApiOverride } from '../api';
import type { PodApi, JobView } from '@shared/ipc';
import { JOB_STATE_LABELS } from '@shared/job-state';

describe('Queue Screen', () => {
  let mockApi: PodApi;
  const mockRetry = vi.fn<PodApi['jobs']['retry']>();
  const mockResolveAmbiguous = vi.fn<PodApi['jobs']['resolveAmbiguous']>();
  const mockList = vi.fn<PodApi['jobs']['list']>();

  const activeJobNoProgress: JobView = {
    job: {
      id: 'job-active-null-prog',
      productId: 'p1',
      skuSnapshot: 'TS-001',
      employeeId: 'emp_demo',
      provider: 'muse',
      providerJobId: 'muse_1',
      providerReferenceId: null,
      providerAssetId: null,
      sourceAssetId: 's1',
      promptTemplateId: 'product-review',
      promptTemplateVersion: 'v2',
      promptSha256: 'sha',
      promptOverridden: false,
      durationSeconds: 5,
      aspectRatio: '9:16',
      state: 'RUNNING',
      idempotencyKey: 'idemp-1',
      attempt: 1,
      regeneratedFromJobId: null,
      reviewStatus: 'pending',
      segment: 0,
      segmentAPath: null,
      submitIntentAt: '2026-11-20T10:00:00.000Z',
      acceptedAt: '2026-11-20T10:00:05.000Z',
      completedAt: null,
      errorCode: null,
      safeErrorMessage: null,
      createdAt: '2026-11-20T10:00:00.000Z',
      updatedAt: '2026-11-20T10:00:05.000Z',
    },
    stateLabel: JOB_STATE_LABELS.RUNNING,
    category: 'T-shirt',
    productName: 'T-shirt Mock',
    sourceUrl: 'data:image/svg+xml;utf8,<svg></svg>',
    videoUrl: null,
    videoAssetId: null,
    elapsedMs: 5000,
    progress: null, // genuine null progress from provider
    nextActions: ['cancel'],
  };

  const ambiguousJob: JobView = {
    job: {
      id: 'job-ambiguous',
      productId: 'p2',
      skuSnapshot: 'HD-002',
      employeeId: 'emp_demo',
      provider: 'muse',
      providerJobId: 'muse_2',
      providerReferenceId: null,
      providerAssetId: null,
      sourceAssetId: 's2',
      promptTemplateId: 'product-review',
      promptTemplateVersion: 'v2',
      promptSha256: 'sha2',
      promptOverridden: false,
      durationSeconds: 5,
      aspectRatio: '9:16',
      state: 'AMBIGUOUS',
      idempotencyKey: 'idemp-2',
      attempt: 1,
      regeneratedFromJobId: null,
      reviewStatus: 'pending',
      segment: 0,
      segmentAPath: null,
      submitIntentAt: '2026-11-20T10:00:00.000Z',
      acceptedAt: null,
      completedAt: null,
      errorCode: 'SUBMIT_AMBIGUOUS',
      safeErrorMessage: 'May already have been submitted to Muse.',
      createdAt: '2026-11-20T10:00:00.000Z',
      updatedAt: '2026-11-20T10:00:05.000Z',
    },
    stateLabel: JOB_STATE_LABELS.AMBIGUOUS,
    category: 'Hoodie',
    productName: 'Hoodie Mock',
    sourceUrl: 'data:image/svg+xml;utf8,<svg></svg>',
    videoUrl: null,
    videoAssetId: null,
    elapsedMs: 8000,
    progress: null,
    nextActions: ['check_ambiguous'],
  };

  beforeEach(() => {
    mockRetry.mockReset();
    mockRetry.mockResolvedValue({ ok: true, data: activeJobNoProgress });

    mockResolveAmbiguous.mockReset();
    mockResolveAmbiguous.mockResolvedValue({ ok: true, data: activeJobNoProgress });

    mockList.mockReset();
    mockList.mockResolvedValue({
      ok: true,
      data: [activeJobNoProgress, ambiguousJob],
    });

    mockApi = {
      app: {
        getInfo: vi.fn(),
      },
      provider: {
        getStatus: vi.fn(),
        testConnection: vi.fn(),
        setupAction: vi.fn(),
      },
      images: {
        pick: vi.fn(),
        stageFile: vi.fn(),
      },
      catalog: {
        listCategories: vi.fn(),
      },
      prompts: {
        listTemplates: vi.fn(),
        getTemplate: vi.fn(),
        preview: vi.fn(),
        validate: vi.fn(),
        saveVersion: vi.fn(),
        setDefault: vi.fn(),
      },
      jobs: {
        create: vi.fn(),
        list: mockList,
        get: vi.fn(),
        retry: mockRetry,
        regenerate: vi.fn(),
        resolveAmbiguous: mockResolveAmbiguous,
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

  it('Queue renders indeterminate state (no % text) when progress is null; renders only actions from nextActions', async () => {
    render(<Queue />);

    await waitFor(() => {
      expect(screen.getByText('TS-001')).toBeDefined();
    });

    // 1. Verify indeterminate progress bar exists
    const progressbar = screen.getByRole('progressbar', { name: /Generating…/i });
    expect(progressbar).toBeDefined();

    // 2. Verify NO '%' text appears in the entire row or document for activeJobNoProgress
    const rows = screen.getAllByRole('row');
    const tsRow = rows.find((r) => r.textContent?.includes('TS-001'));
    expect(tsRow).toBeDefined();
    expect(tsRow?.textContent).not.toContain('%');

    // 3. Verify exactly the actions in nextActions are rendered:
    // activeJobNoProgress has nextActions: ['cancel']
    const cancelBtn = withinRow(tsRow!, 'Cancel');
    expect(cancelBtn).toBeDefined();
    expect(withinRow(tsRow!, 'Retry')).toBeNull();
    expect(withinRow(tsRow!, 'Check Status')).toBeNull();

    // ambiguousJob has nextActions: ['check_ambiguous']
    const hdRow = rows.find((r) => r.textContent?.includes('HD-002'));
    expect(hdRow).toBeDefined();
    const checkBtn = withinRow(hdRow!, 'Check Status');
    expect(checkBtn).toBeDefined();
    expect(withinRow(hdRow!, 'Retry')).toBeNull();
    expect(withinRow(hdRow!, 'Cancel')).toBeNull();
  });

  it('Ambiguous dialog never calls jobs.retry', async () => {
    render(<Queue />);

    await waitFor(() => {
      expect(screen.getByText('HD-002')).toBeDefined();
    });

    // Click "Check Status" on ambiguous job row
    const checkStatusBtn = screen.getByRole('button', { name: /Check Status/i });
    fireEvent.click(checkStatusBtn);

    // Verify dialog opens
    expect(screen.getByText(/Check Ambiguous Generation/i)).toBeDefined();

    // Click "Check again" in dialog
    const checkAgainBtn = screen.getByRole('button', { name: /Check again/i });
    fireEvent.click(checkAgainBtn);

    await waitFor(() => {
      expect(mockResolveAmbiguous).toHaveBeenCalledWith({
        jobId: 'job-ambiguous',
        resolution: 'check_again',
      });
    });

    // CRITICAL: jobs.retry must NEVER be called
    expect(mockRetry).not.toHaveBeenCalled();
  });

  it('renders small "Calendar" badge when job has interiorArtworkUrl or category is calendar', async () => {
    const calendarJob: JobView = {
      ...activeJobNoProgress,
      job: {
        ...activeJobNoProgress.job,
        id: 'job-cal-1',
        skuSnapshot: 'CAL-001',
      },
      category: 'Desk Calendar',
      interiorArtworkUrl: 'pod-media://asset/art-1',
    };

    mockList.mockResolvedValueOnce({
      ok: true,
      data: [calendarJob],
    });

    render(<Queue />);

    await waitFor(() => {
      expect(screen.getByText('CAL-001')).toBeDefined();
    });

    // Calendar badge is rendered
    expect(screen.getByText('Calendar')).toBeDefined();
  });
});

function withinRow(row: HTMLElement, buttonText: string): HTMLElement | null {
  const buttons = row.querySelectorAll('button');
  for (const btn of buttons) {
    if (btn.textContent?.trim() === buttonText) {
      return btn;
    }
  }
  return null;
}
