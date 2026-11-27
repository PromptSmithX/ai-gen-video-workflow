// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Library } from './Library';
import { setApiOverride } from '../api';
import type { PodApi, JobView } from '@shared/ipc';
import { ToastProvider } from '../components/Toast';

describe('Library Screen', () => {
  let mockApi: PodApi;
  const mockListJobs = vi.fn<PodApi['jobs']['list']>();
  const mockListCategories = vi.fn<PodApi['catalog']['listCategories']>();

  const standardJob: JobView = {
    job: {
      id: 'job-1',
      productId: 'p1',
      skuSnapshot: 'TS-001',
      employeeId: 'emp_1',
      provider: 'muse',
      providerJobId: null,
      providerReferenceId: null,
      providerAssetId: null,
      sourceAssetId: 's1',
      promptTemplateId: 'product-review',
      promptTemplateVersion: 'v2',
      promptSha256: 'sha',
      promptOverridden: false,
      durationSeconds: 5,
      aspectRatio: '9:16',
      state: 'SUCCEEDED',
      idempotencyKey: 'idemp-1',
      attempt: 1,
      regeneratedFromJobId: null,
      reviewStatus: 'approved',
      segment: 0,
      segmentAPath: null,
      submitIntentAt: null,
      acceptedAt: null,
      completedAt: null,
      errorCode: null,
      safeErrorMessage: null,
      createdAt: '2026-11-20T10:00:00.000Z',
      updatedAt: '2026-11-20T10:01:00.000Z',
    },
    stateLabel: 'Succeeded',
    category: 'T-shirt',
    productName: 'Cool Tee',
    sourceUrl: 'pod-media://asset/source-1',
    videoUrl: 'pod-media://asset/video-1',
    videoAssetId: 'v1',
    elapsedMs: 60000,
    progress: 1.0,
    nextActions: ['regenerate'],
  };

  const calendarJobWithArtwork: JobView = {
    job: {
      id: 'job-cal-1',
      productId: 'p2',
      skuSnapshot: 'CAL-001',
      employeeId: 'emp_1',
      provider: 'muse',
      providerJobId: null,
      providerReferenceId: null,
      providerAssetId: null,
      sourceAssetId: 's2',
      promptTemplateId: 'calendar-review',
      promptTemplateVersion: 'v1',
      promptSha256: 'sha-cal',
      promptOverridden: false,
      durationSeconds: 5,
      aspectRatio: '9:16',
      state: 'SUCCEEDED',
      idempotencyKey: 'idemp-cal-1',
      attempt: 1,
      regeneratedFromJobId: null,
      reviewStatus: 'pending',
      segment: 0,
      segmentAPath: null,
      submitIntentAt: null,
      acceptedAt: null,
      completedAt: null,
      errorCode: null,
      safeErrorMessage: null,
      createdAt: '2026-11-25T10:00:00.000Z',
      updatedAt: '2026-11-25T10:01:00.000Z',
    },
    stateLabel: 'Succeeded',
    category: 'Desk Calendar',
    productName: 'Spiral Desk Calendar',
    sourceUrl: 'pod-media://asset/cover-1',
    interiorArtworkUrl: 'pod-media://asset/artwork-1',
    videoUrl: 'pod-media://asset/video-cal-1',
    videoAssetId: 'v2',
    elapsedMs: 60000,
    progress: 1.0,
    nextActions: ['regenerate'],
  };

  beforeEach(() => {
    mockListJobs.mockReset();
    mockListJobs.mockResolvedValue({
      ok: true,
      data: [standardJob, calendarJobWithArtwork],
    });

    mockListCategories.mockReset();
    mockListCategories.mockResolvedValue({
      ok: true,
      data: [
        { id: 't-shirt', label: 'T-shirt', promptGroup: 'apparel' },
        { id: 'desk-calendar', label: 'Desk Calendar', promptGroup: 'calendar' },
      ],
    });

    mockApi = {
      app: { getInfo: vi.fn() },
      provider: { getStatus: vi.fn(), testConnection: vi.fn(), setupAction: vi.fn() },
      images: { pick: vi.fn(), stageFile: vi.fn() },
      catalog: { listCategories: mockListCategories },
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
        list: mockListJobs,
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

  it('renders Front Cover and Interior Artwork thumbnails next to video when interiorArtworkUrl is non-empty', async () => {
    render(
      <ToastProvider>
        <Library />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('CAL-001')).toBeDefined();
      expect(screen.getByText('TS-001')).toBeDefined();
    });

    // Calendar job has Front Cover and Interior Artwork images
    const frontCoverImg = screen.getByAltText(/Front Cover for CAL-001/i);
    const interiorArtworkImg = screen.getByAltText(/Interior Artwork for CAL-001/i);
    expect(frontCoverImg).toBeDefined();
    expect(interiorArtworkImg).toBeDefined();
    expect(frontCoverImg.getAttribute('src')).toBe('pod-media://asset/cover-1');
    expect(interiorArtworkImg.getAttribute('src')).toBe('pod-media://asset/artwork-1');

    // Standard apparel job has only single source image
    const standardSourceImg = screen.getByAltText(/Source for TS-001/i);
    expect(standardSourceImg).toBeDefined();
    expect(screen.queryByAltText(/Interior Artwork for TS-001/i)).toBeNull();
  });

  it('handles absent / undefined interiorArtworkUrl safely without error', async () => {
    const jobWithUndefinedArtwork: JobView = {
      ...calendarJobWithArtwork,
      interiorArtworkUrl: undefined,
    };

    mockListJobs.mockResolvedValueOnce({
      ok: true,
      data: [jobWithUndefinedArtwork],
    });

    render(
      <ToastProvider>
        <Library />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('CAL-001')).toBeDefined();
    });

    // Renders safely as single source mockup
    expect(screen.getByAltText(/Source for CAL-001/i)).toBeDefined();
    expect(screen.queryByAltText(/Interior Artwork for CAL-001/i)).toBeNull();
  });
});
