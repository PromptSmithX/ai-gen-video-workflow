import type { AdminSettings } from '@shared/config';
import type { Category, ImageInfo, Job } from '@shared/domain';
import type { AspectRatio } from '@shared/provider';
import type {
  PromptTemplate,
  PromptTemplateSummary,
  QualityCheck,
  QualityReport,
  RenderedPrompt,
} from '@shared/prompt';
import type {
  CreateJobInput,
  DiagnosticsPreview,
  GetTemplateInput,
  JobIdInput,
  JobListInput,
  JobNextAction,
  JobView,
  PodApi,
  PromptPreviewInput,
  RegenerateJobInput,
  ResolveAmbiguousInput,
  RetryJobInput,
  SaveTemplateVersionInput,
  SetApiKeyInput,
  SetDefaultTemplateInput,
  SetReviewInput,
  StagedImage,
  UpdateSettingsInput,
  ValidatePromptInput,
} from '@shared/ipc';
import { DEFAULT_CATEGORIES } from '@shared/domain';
import { JOB_STATE_LABELS } from '@shared/job-state';
import { z } from 'zod';

// Default initial templates
const INITIAL_TEMPLATES: PromptTemplate[] = [
  {
    id: 'product-review',
    version: 'v2',
    title: 'Product Review V2 (Standard)',
    isPlaceholder: false,
    source: 'builtin',
    isDefault: true,
    createdAt: '2026-11-20T10:00:00.000Z',
    note: 'Standard natural human product review with artwork preservation',
    body: `A natural authentic product review video showcasing {{sku}} ({{product_category}}).
The reviewer examines the {{product_name}} with hands holding and turning it gently.
Natural fabric folds and texture, realistic lighting, physical continuity with no impossible transformations.
The original printed artwork, typography, and logos on the {{product_category}} are preserved exactly as shown in the source mockup without any alterations, recoloring, or repositioning.
Believable casual customer reaction and detailed close-up review.`,
  },
  {
    id: 'quick-showcase',
    version: 'v1',
    title: 'Quick Showcase (Placeholder)',
    isPlaceholder: true,
    source: 'builtin',
    isDefault: false,
    createdAt: '2026-11-15T08:00:00.000Z',
    note: 'PLACEHOLDER - Experimental fast preview template',
    body: `PLACEHOLDER: Quick rotating showcase of {{sku}} ({{product_category}}).
Show natural physical handling of the item. Maintain identical design, graphics, and text from the original product mockup.`,
  },
  {
    id: 'calendar-review',
    version: 'v1',
    title: 'Desk Calendar Review (Standard)',
    isPlaceholder: false,
    source: 'builtin',
    isDefault: true,
    createdAt: '2026-11-25T10:00:00.000Z',
    note: 'Authentic desk calendar review with blank page turn and artwork preservation',
    body: `A natural authentic product review video showcasing {{sku}} ({{product_category}}).
The reviewer examines the desk calendar, holding and presenting the front cover mockup reference.
The reviewer turns exactly one page around the top spiral binding, revealing a clean blank interior cream page.
The open page is held facing the camera steadily, keeping the printed artwork surface free from hand obstruction.
Original design and graphics are preserved accurately.`,
  },
];

export function computeJobNextActions(job: Job, canCancel = true): JobNextAction[] {
  switch (job.state) {
    case 'QUEUED':
    case 'SUBMITTING':
    case 'RUNNING':
      return canCancel ? ['cancel'] : [];
    case 'FAILED_RETRYABLE':
      return ['retry', 'regenerate'];
    case 'FAILED_PROVIDER':
      return job.attempt < 2 ? ['retry', 'regenerate'] : ['regenerate'];
    case 'AMBIGUOUS':
      return ['check_ambiguous'];
    case 'DOWNLOAD_FAILED':
      return ['retry_download', 'regenerate'];
    case 'SUCCEEDED':
    case 'FAILED_REFUSED':
    case 'FAILED_QUOTA':
    case 'CANCELLED':
      return ['regenerate'];
    default:
      return [];
  }
}

function evaluateQuality(text: string): QualityReport {
  const lower = text.toLowerCase();
  const checks: QualityCheck[] = [
    {
      rule: 'preserve_artwork',
      label: 'Preserves original artwork and text',
      passed: !lower.includes('replace art') && !lower.includes('remove design'),
    },
    {
      rule: 'no_design_changes',
      label: 'No redesign, recolor, or repositioning',
      passed: !lower.includes('redesign') && !lower.includes('change color'),
    },
    {
      rule: 'consistent_product',
      label: 'Consistent product construction and seams',
      passed: true,
    },
    {
      rule: 'natural_texture',
      label: 'Natural fabric/material textures and folds',
      passed: !lower.includes('plastic skin') && !lower.includes('cartoon'),
    },
    {
      rule: 'physical_continuity',
      label: 'Physically plausible handling and gravity',
      passed: !lower.includes('teleport') && !lower.includes('levitate'),
    },
    {
      rule: 'no_impossible_transitions',
      label: 'No impossible morphs or transitions',
      passed: !lower.includes('morph') && !lower.includes('phase through'),
    },
    {
      rule: 'human_review_action',
      label: 'Natural human interaction / review action',
      passed: lower.includes('review') || lower.includes('showcase') || lower.includes('hold') || lower.includes('examin'),
    },
    {
      rule: 'no_fake_claims',
      label: 'No fake claims, badges, or ratings',
      passed: !lower.includes('5 stars') && !lower.includes('99% off') && !lower.includes('#1 best seller'),
    },
  ];

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

export class FakeApiStore {
  private categories: Category[] = [...DEFAULT_CATEGORIES];
  private templates: PromptTemplate[] = [...INITIAL_TEMPLATES];
  private jobs: Map<string, JobView> = new Map();
  private updateListeners: Set<(view: JobView) => void> = new Set();
  private timers: Set<ReturnType<typeof setTimeout>> = new Set();

  private settings: AdminSettings = {
    bridgeBaseUrl: 'http://127.0.0.1:47821',
    musePlatformOrigin: 'https://muse.ai',
    libraryRoot: 'C:\\POD_VIDEO_LIBRARY',
    logRetentionDays: 30,
    categories: [...DEFAULT_CATEGORIES],
    adminUsers: ['admin', 'supervisor'],
    defaultTemplateId: 'product-review',
    defaultTemplateVersion: 'v2',
  };

  private providerStatus = {
    mode: 'mock' as const,
    state: 'ready' as const,
    capabilities: {
      canCancel: true,
      reportsProgress: true,
      supportedDurations: [5, 10],
      supportedAspectRatios: ['9:16', '16:9', '1:1'] as AspectRatio[],
      maxPromptChars: 4000,
      maxUploadBytes: 50 * 1024 * 1024,
    },
    platformOrigin: 'https://muse.ai',
    bridgeBaseUrl: 'http://127.0.0.1:47821',
    compatibility: 'compatible' as const,
    hasApiKey: true,
    secretStoreAvailable: true,
    checkedAt: new Date().toISOString(),
  };

  constructor() {
    this.seedInitialJobs();
  }

  private seedInitialJobs(): void {
    const now = Date.now();
    const demoJob1: Job = {
      id: 'demo-job-1',
      productId: 'prod-1',
      skuSnapshot: 'TS-001',
      employeeId: 'emp_demo',
      provider: 'muse',
      providerJobId: 'muse_101',
      providerReferenceId: 'ref_101',
      providerAssetId: 'asset_101',
      sourceAssetId: 'source_1',
      promptTemplateId: 'product-review',
      promptTemplateVersion: 'v2',
      promptSha256: 'abc123456789',
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
      submitIntentAt: new Date(now - 120000).toISOString(),
      acceptedAt: new Date(now - 110000).toISOString(),
      completedAt: new Date(now - 60000).toISOString(),
      errorCode: null,
      safeErrorMessage: null,
      createdAt: new Date(now - 120000).toISOString(),
      updatedAt: new Date(now - 60000).toISOString(),
    };

    const view1: JobView = {
      job: demoJob1,
      stateLabel: JOB_STATE_LABELS.SUCCEEDED,
      category: 'T-shirt',
      productName: 'Classic Crewneck',
      sourceUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="%23e2e8f0"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="20" fill="%23475569">TS-001 Mockup</text></svg>',
      videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
      videoAssetId: 'asset_101',
      elapsedMs: 60000,
      progress: 1.0,
      nextActions: computeJobNextActions(demoJob1),
    };
    this.jobs.set(demoJob1.id, view1);

    const demoJob2: Job = {
      id: 'demo-job-2',
      productId: 'prod-2',
      skuSnapshot: 'HD-002',
      employeeId: 'emp_demo',
      provider: 'muse',
      providerJobId: 'muse_102',
      providerReferenceId: null,
      providerAssetId: null,
      sourceAssetId: 'source_2',
      promptTemplateId: 'product-review',
      promptTemplateVersion: 'v2',
      promptSha256: 'def456789012',
      promptOverridden: false,
      durationSeconds: 10,
      aspectRatio: '16:9',
      state: 'AMBIGUOUS',
      idempotencyKey: 'idemp-2',
      attempt: 1,
      regeneratedFromJobId: null,
      reviewStatus: 'pending',
      segment: 0,
      segmentAPath: null,
      submitIntentAt: new Date(now - 30000).toISOString(),
      acceptedAt: null,
      completedAt: null,
      errorCode: 'SUBMIT_AMBIGUOUS',
      safeErrorMessage: 'The request may already have been sent to Muse, but it could not be confirmed. Check Muse before retrying.',
      createdAt: new Date(now - 30000).toISOString(),
      updatedAt: new Date(now - 10000).toISOString(),
    };

    const view2: JobView = {
      job: demoJob2,
      stateLabel: JOB_STATE_LABELS.AMBIGUOUS,
      category: 'Hoodie',
      productName: 'Cozy Fleece Hoodie',
      sourceUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="%23cbd5e1"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="20" fill="%23334155">HD-002 Mockup</text></svg>',
      videoUrl: null,
      videoAssetId: null,
      elapsedMs: 20000,
      progress: null,
      nextActions: computeJobNextActions(demoJob2),
    };
    this.jobs.set(demoJob2.id, view2);
  }

  public notifyUpdated(view: JobView): void {
    this.jobs.set(view.job.id, view);
    for (const listener of this.updateListeners) {
      try {
        listener(view);
      } catch {
        // ignore listener errors
      }
    }
  }

  public simulateProgression(jobId: string): void {
    const schedule = (delay: number, fn: () => void) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        fn();
      }, delay);
      this.timers.add(timer);
    };

    // QUEUED -> SUBMITTING
    schedule(400, () => {
      const current = this.jobs.get(jobId);
      if (!current || current.job.state === 'CANCELLED') return;
      const updatedJob: Job = {
        ...current.job,
        state: 'SUBMITTING',
        submitIntentAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.notifyUpdated({
        ...current,
        job: updatedJob,
        stateLabel: JOB_STATE_LABELS.SUBMITTING,
        progress: null,
        nextActions: computeJobNextActions(updatedJob),
      });

      // SUBMITTING -> RUNNING
      schedule(800, () => {
        const c2 = this.jobs.get(jobId);
        if (!c2 || c2.job.state === 'CANCELLED') return;
        const runningJob: Job = {
          ...c2.job,
          state: 'RUNNING',
          providerJobId: `mock_${crypto.randomUUID().slice(0, 8)}`,
          acceptedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        this.notifyUpdated({
          ...c2,
          job: runningJob,
          stateLabel: JOB_STATE_LABELS.RUNNING,
          progress: 0.25,
          nextActions: computeJobNextActions(runningJob),
        });

        // Progress updates
        schedule(1000, () => {
          const c3 = this.jobs.get(jobId);
          if (!c3 || c3.job.state !== 'RUNNING') return;
          this.notifyUpdated({
            ...c3,
            progress: 0.65,
          });
        });

        // RUNNING -> DOWNLOADING
        schedule(2000, () => {
          const c4 = this.jobs.get(jobId);
          if (!c4 || c4.job.state !== 'RUNNING') return;
          const dlJob: Job = {
            ...c4.job,
            state: 'DOWNLOADING',
            updatedAt: new Date().toISOString(),
          };
          this.notifyUpdated({
            ...c4,
            job: dlJob,
            stateLabel: JOB_STATE_LABELS.DOWNLOADING,
            progress: 0.9,
            nextActions: computeJobNextActions(dlJob),
          });

          // DOWNLOADING -> SUCCEEDED
          schedule(1000, () => {
            const c5 = this.jobs.get(jobId);
            if (!c5 || c5.job.state !== 'DOWNLOADING') return;
            const succJob: Job = {
              ...c5.job,
              state: 'SUCCEEDED',
              completedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            this.notifyUpdated({
              ...c5,
              job: succJob,
              stateLabel: JOB_STATE_LABELS.SUCCEEDED,
              progress: 1.0,
              videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
              videoAssetId: `asset_${crypto.randomUUID().slice(0, 8)}`,
              nextActions: computeJobNextActions(succJob),
            });
          });
        });
      });
    });
  }

  public getApi(): PodApi {
    return {
      app: {
        getInfo: async () => ({
          ok: true,
          data: {
            version: '0.1.0',
            employeeId: 'emp_demo',
            isAdmin: true,
            providerMode: this.providerStatus.mode,
            isDev: true,
          },
        }),
      },

      provider: {
        getStatus: async () => ({
          ok: true,
          data: {
            ...this.providerStatus,
            checkedAt: new Date().toISOString(),
          },
        }),
        testConnection: async () => {
          this.providerStatus.checkedAt = new Date().toISOString();
          return {
            ok: true,
            data: { ...this.providerStatus },
          };
        },
        setupAction: async () => ({ ok: true, data: { ...this.providerStatus } }),
      },

      images: {
        pick: async () => {
          const token = `staged_${crypto.randomUUID()}`;
          const staged: StagedImage = {
            token,
            fileName: 'sample-tee-mockup.png',
            info: {
              mime: 'image/png',
              width: 1200,
              height: 1200,
              bytes: 245000,
            },
            previewUrl:
              'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="%23f1f5f9"/><circle cx="200" cy="180" r="100" fill="%233b82f6"/><text x="200" y="320" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="20" fill="%231e293b">Sample POD Mockup</text></svg>',
          };
          return { ok: true, data: staged };
        },

        stageFile: async (file: File) => {
          let previewUrl = '';
          if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
            try {
              previewUrl = URL.createObjectURL(file);
            } catch {
              previewUrl = '';
            }
          }
          if (!previewUrl) {
            previewUrl =
              'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="%23e2e8f0"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="16" fill="%23475569">' +
              encodeURIComponent(file.name) +
              '</text></svg>';
          }

          const token = `staged_${crypto.randomUUID()}`;
          const staged: StagedImage = {
            token,
            fileName: file.name,
            info: {
              mime: (file.type as ImageInfo['mime']) || 'image/png',
              width: 1080,
              height: 1080,
              bytes: file.size,
            },
            previewUrl,
          };
          return { ok: true, data: staged };
        },
      },

      catalog: {
        listCategories: async () => ({
          ok: true,
          data: [...this.categories],
        }),
      },

      prompts: {
        listTemplates: async () => ({
          ok: true,
          data: this.templates.map((t) => ({
            id: t.id,
            version: t.version,
            title: t.title,
            isPlaceholder: t.isPlaceholder,
            source: t.source,
            isDefault: t.isDefault,
            createdAt: t.createdAt,
            note: t.note,
          })),
        }),

        getTemplate: async (input: z.infer<typeof GetTemplateInput>) => {
          const t = this.templates.find((tpl) => tpl.id === input.id && (!input.version || tpl.version === input.version));
          if (!t) {
            return {
              ok: false,
              error: { code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' },
            };
          }
          return { ok: true, data: t };
        },

        preview: async (input: PromptPreviewInput) => {
          const t = this.templates.find(
            (tpl) => tpl.id === input.templateId && (!input.templateVersion || tpl.version === input.templateVersion),
          ) ?? this.templates[0];

          let rendered = t?.body ?? '';
          rendered = rendered.replace(/\{\{sku\}\}/g, input.sku);
          rendered = rendered.replace(/\{\{product_category\}\}/g, input.categoryId);
          rendered = rendered.replace(/\{\{product_name\}\}/g, input.productName || input.categoryId);
          rendered = rendered.replace(/\{\{source_image_filename\}\}/g, input.fileName || 'source.png');
          rendered = rendered.replace(/\{\{duration_seconds\}\}/g, String(input.durationSeconds ?? ''));
          rendered = rendered.replace(/\{\{aspect_ratio\}\}/g, input.aspectRatio ?? '');
          rendered = rendered.replace(/\{\{review_style\}\}/g, input.reviewStyle ?? 'casual customer review');

          const errors: string[] = [];
          if (rendered.length > (this.providerStatus.capabilities.maxPromptChars || 4000)) {
            errors.push('Prompt is longer than maximum allowed characters');
          }
          const unreplaced = rendered.match(/\{\{[a-zA-Z0-9_-]+\}\}/g);
          if (unreplaced && unreplaced.length > 0) {
            errors.push(`Unknown placeholders: ${Array.from(new Set(unreplaced)).join(', ')}`);
          }

          const quality = evaluateQuality(rendered);

          const result: RenderedPrompt = {
            text: rendered,
            chars: rendered.length,
            maxChars: this.providerStatus.capabilities.maxPromptChars || 4000,
            templateId: t?.id ?? input.templateId,
            templateVersion: t?.version ?? input.templateVersion ?? 'v1',
            isPlaceholder: t?.isPlaceholder ?? false,
            quality,
            errors,
          };
          return { ok: true, data: result };
        },

        validate: async (input: z.infer<typeof ValidatePromptInput>) => {
          const errors: string[] = [];
          if (input.text.length > (this.providerStatus.capabilities.maxPromptChars || 4000)) {
            errors.push('Prompt is longer than maximum allowed characters');
          }
          const unreplaced = input.text.match(/\{\{[a-zA-Z0-9_-]+\}\}/g);
          if (unreplaced && unreplaced.length > 0) {
            errors.push(`Unknown placeholders: ${Array.from(new Set(unreplaced)).join(', ')}`);
          }
          const quality = evaluateQuality(input.text);
          const result: RenderedPrompt = {
            text: input.text,
            chars: input.text.length,
            maxChars: this.providerStatus.capabilities.maxPromptChars || 4000,
            templateId: 'custom',
            templateVersion: 'custom',
            isPlaceholder: false,
            quality,
            errors,
          };
          return { ok: true, data: result };
        },

        saveVersion: async (input: z.infer<typeof SaveTemplateVersionInput>) => {
          const nextVerNum =
            this.templates
              .filter((t) => t.id === input.id)
              .map((t) => parseInt(t.version.replace('v', ''), 10))
              .filter((n) => !isNaN(n))
              .reduce((max, n) => Math.max(max, n), 0) + 1;
          const version = `v${nextVerNum}`;
          const newTemplate: PromptTemplate = {
            id: input.id,
            version,
            title: input.title || `${input.id} ${version}`,
            isPlaceholder: false,
            source: 'admin',
            isDefault: false,
            createdAt: new Date().toISOString(),
            note: input.note || null,
            body: input.body,
          };
          this.templates.push(newTemplate);
          const summary: PromptTemplateSummary = {
            id: newTemplate.id,
            version: newTemplate.version,
            title: newTemplate.title,
            isPlaceholder: newTemplate.isPlaceholder,
            source: newTemplate.source,
            isDefault: newTemplate.isDefault,
            createdAt: newTemplate.createdAt,
            note: newTemplate.note,
          };
          return { ok: true, data: summary };
        },

        setDefault: async (input: z.infer<typeof SetDefaultTemplateInput>) => {
          for (const tpl of this.templates) {
            tpl.isDefault = tpl.id === input.id && tpl.version === input.version;
          }
          return { ok: true, data: undefined };
        },
      },

      jobs: {
        create: async (input: CreateJobInput) => {
          // Idempotent per clientRequestId
          for (const view of this.jobs.values()) {
            if (view.job.idempotencyKey === input.clientRequestId) {
              return { ok: true, data: view };
            }
          }

          const jobId = crypto.randomUUID();
          const category = this.categories.find((c) => c.id === input.categoryId)?.label ?? input.categoryId;
          const newJob: Job = {
            id: jobId,
            productId: `prod_${input.sku}`,
            skuSnapshot: input.sku,
            employeeId: 'emp_demo',
            provider: 'muse',
            providerJobId: null,
            providerReferenceId: null,
            providerAssetId: null,
            sourceAssetId: `src_${crypto.randomUUID().slice(0, 8)}`,
            promptTemplateId: input.templateId,
            promptTemplateVersion: input.templateVersion,
            promptSha256: 'sha256_placeholder',
            promptOverridden: Boolean(input.promptOverride),
            durationSeconds: input.durationSeconds ?? null,
            aspectRatio: input.aspectRatio ?? null,
            state: 'QUEUED',
            idempotencyKey: input.clientRequestId,
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
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };

          const view: JobView = {
            job: newJob,
            stateLabel: JOB_STATE_LABELS.QUEUED,
            category,
            productName: input.productName ?? null,
            sourceUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="%23e2e8f0"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="16" fill="%23475569">' + input.sku + '</text></svg>',
            interiorArtworkUrl: input.interiorArtworkToken
              ? 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="%23fef3c7"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="14" fill="%2392400e">Artwork: ' + input.sku + '</text></svg>'
              : null,
            videoUrl: null,
            videoAssetId: null,
            elapsedMs: 0,
            progress: null,
            nextActions: computeJobNextActions(newJob),
          };

          this.jobs.set(jobId, view);
          this.simulateProgression(jobId);
          return { ok: true, data: view };
        },

        list: async (input?: JobListInput) => {
          let list = Array.from(this.jobs.values()).sort(
            (a, b) => new Date(b.job.createdAt).getTime() - new Date(a.job.createdAt).getTime(),
          );

          if (input?.sku) {
            const query = input.sku.toUpperCase();
            list = list.filter((v) => v.job.skuSnapshot.includes(query));
          }
          if (input?.categoryId) {
            list = list.filter((v) => v.category.toLowerCase().includes(input.categoryId!.toLowerCase()));
          }
          if (input?.employeeId) {
            list = list.filter((v) => v.job.employeeId.toLowerCase().includes(input.employeeId!.toLowerCase()));
          }
          if (input?.states && input.states.length > 0) {
            list = list.filter((v) => input.states!.includes(v.job.state));
          }
          if (input?.reviewStatus) {
            list = list.filter((v) => v.job.reviewStatus === input.reviewStatus);
          }
          if (input?.templateVersion) {
            list = list.filter((v) => v.job.promptTemplateVersion === input.templateVersion);
          }
          if (input?.from) {
            const fromTime = new Date(input.from).getTime();
            list = list.filter((v) => new Date(v.job.createdAt).getTime() >= fromTime);
          }
          if (input?.to) {
            const toTime = new Date(input.to).getTime();
            list = list.filter((v) => new Date(v.job.createdAt).getTime() <= toTime);
          }

          return { ok: true, data: list };
        },

        get: async (input: z.infer<typeof JobIdInput>) => {
          const view = this.jobs.get(input.jobId);
          if (!view) {
            return {
              ok: false,
              error: { code: 'NOT_FOUND', message: 'Job not found' },
            };
          }
          return { ok: true, data: view };
        },

        retry: async (input: z.infer<typeof RetryJobInput>) => {
          const view = this.jobs.get(input.jobId);
          if (!view) {
            return { ok: false, error: { code: 'NOT_FOUND', message: 'Job not found' } };
          }
          const updatedJob: Job = {
            ...view.job,
            state: 'QUEUED',
            attempt: view.job.attempt + 1,
            errorCode: null,
            safeErrorMessage: null,
            updatedAt: new Date().toISOString(),
          };
          const updatedView: JobView = {
            ...view,
            job: updatedJob,
            stateLabel: JOB_STATE_LABELS.QUEUED,
            progress: null,
            nextActions: computeJobNextActions(updatedJob),
          };
          this.notifyUpdated(updatedView);
          this.simulateProgression(input.jobId);
          return { ok: true, data: updatedView };
        },

        regenerate: async (input: z.infer<typeof RegenerateJobInput>) => {
          const existing = this.jobs.get(input.jobId);
          if (!existing) {
            return { ok: false, error: { code: 'NOT_FOUND', message: 'Original job not found' } };
          }
          const newId = crypto.randomUUID();
          const newJob: Job = {
            ...existing.job,
            id: newId,
            state: 'QUEUED',
            idempotencyKey: input.clientRequestId,
            attempt: 1,
            regeneratedFromJobId: existing.job.id,
            reviewStatus: 'pending',
            errorCode: null,
            safeErrorMessage: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          const newView: JobView = {
            ...existing,
            job: newJob,
            stateLabel: JOB_STATE_LABELS.QUEUED,
            progress: null,
            videoUrl: null,
            videoAssetId: null,
            nextActions: computeJobNextActions(newJob),
          };
          this.jobs.set(newId, newView);
          this.simulateProgression(newId);
          return { ok: true, data: newView };
        },

        resolveAmbiguous: async (input: z.infer<typeof ResolveAmbiguousInput>) => {
          const view = this.jobs.get(input.jobId);
          if (!view) {
            return { ok: false, error: { code: 'NOT_FOUND', message: 'Job not found' } };
          }
          if (input.resolution === 'check_again') {
            const resolvedJob: Job = {
              ...view.job,
              state: 'RUNNING',
              errorCode: null,
              safeErrorMessage: null,
              updatedAt: new Date().toISOString(),
            };
            const updatedView: JobView = {
              ...view,
              job: resolvedJob,
              stateLabel: JOB_STATE_LABELS.RUNNING,
              progress: 0.5,
              nextActions: computeJobNextActions(resolvedJob),
            };
            this.notifyUpdated(updatedView);
            this.simulateProgression(input.jobId);
            return { ok: true, data: updatedView };
          } else {
            const failedJob: Job = {
              ...view.job,
              state: 'FAILED_PROVIDER',
              errorCode: 'PROVIDER_ERROR',
              safeErrorMessage: 'User confirmed generation was not started in Muse.',
              updatedAt: new Date().toISOString(),
            };
            const updatedView: JobView = {
              ...view,
              job: failedJob,
              stateLabel: JOB_STATE_LABELS.FAILED_PROVIDER,
              progress: null,
              nextActions: computeJobNextActions(failedJob),
            };
            this.notifyUpdated(updatedView);
            return { ok: true, data: updatedView };
          }
        },

        retryDownload: async (input: z.infer<typeof JobIdInput>) => {
          const view = this.jobs.get(input.jobId);
          if (!view) {
            return { ok: false, error: { code: 'NOT_FOUND', message: 'Job not found' } };
          }
          const dlJob: Job = {
            ...view.job,
            state: 'DOWNLOADING',
            updatedAt: new Date().toISOString(),
          };
          const updatedView: JobView = {
            ...view,
            job: dlJob,
            stateLabel: JOB_STATE_LABELS.DOWNLOADING,
            progress: 0.5,
            nextActions: computeJobNextActions(dlJob),
          };
          this.notifyUpdated(updatedView);
          setTimeout(() => {
            const succJob: Job = {
              ...dlJob,
              state: 'SUCCEEDED',
              updatedAt: new Date().toISOString(),
            };
            this.notifyUpdated({
              ...updatedView,
              job: succJob,
              stateLabel: JOB_STATE_LABELS.SUCCEEDED,
              progress: 1.0,
              videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
              nextActions: computeJobNextActions(succJob),
            });
          }, 1000);
          return { ok: true, data: updatedView };
        },

        cancel: async (input: z.infer<typeof JobIdInput>) => {
          const view = this.jobs.get(input.jobId);
          if (!view) {
            return { ok: false, error: { code: 'NOT_FOUND', message: 'Job not found' } };
          }
          const cancelledJob: Job = {
            ...view.job,
            state: 'CANCELLED',
            updatedAt: new Date().toISOString(),
          };
          const updatedView: JobView = {
            ...view,
            job: cancelledJob,
            stateLabel: JOB_STATE_LABELS.CANCELLED,
            progress: null,
            nextActions: computeJobNextActions(cancelledJob),
          };
          this.notifyUpdated(updatedView);
          return { ok: true, data: updatedView };
        },

        setReview: async (input: z.infer<typeof SetReviewInput>) => {
          const view = this.jobs.get(input.jobId);
          if (!view) {
            return { ok: false, error: { code: 'NOT_FOUND', message: 'Job not found' } };
          }
          const updatedJob: Job = {
            ...view.job,
            reviewStatus: input.status,
            updatedAt: new Date().toISOString(),
          };
          const updatedView: JobView = {
            ...view,
            job: updatedJob,
          };
          this.notifyUpdated(updatedView);
          return { ok: true, data: updatedView };
        },

        onUpdated: (listener: (view: JobView) => void) => {
          this.updateListeners.add(listener);
          return () => {
            this.updateListeners.delete(listener);
          };
        },
      },

      library: {
        openFolder: async (_input: z.infer<typeof JobIdInput>) => ({
          ok: true,
          data: undefined,
        }),
        copyPath: async (_input: z.infer<typeof JobIdInput>) => ({
          ok: true,
          data: undefined,
        }),
      },

      admin: {
        getSettings: async () => ({
          ok: true,
          data: { ...this.settings },
        }),
        updateSettings: async (input: z.infer<typeof UpdateSettingsInput>) => {
          this.settings = {
            ...this.settings,
            ...input,
            categories: input.categories ?? this.settings.categories,
            adminUsers: input.adminUsers ?? this.settings.adminUsers,
          };
          if (input.categories) {
            this.categories = [...input.categories];
          }
          return { ok: true, data: { ...this.settings } };
        },
        setBridgeApiKey: async (_input: z.infer<typeof SetApiKeyInput>) => {
          this.providerStatus.hasApiKey = true;
          return { ok: true, data: undefined };
        },
        clearBridgeApiKey: async () => {
          this.providerStatus.hasApiKey = false;
          return { ok: true, data: undefined };
        },
        diagnosticsPreview: async () => ({
          ok: true,
          data: {
            content: `POD Video Studio Diagnostics Preview\nGenerated: ${new Date().toISOString()}\nPlatform: Windows\nProvider: mock (ready)\nAPI Key: [REDACTED]\nLibrary Root: C:\\POD_VIDEO_LIBRARY\nJobs Count: ${this.jobs.size}\nActive Listeners: ${this.updateListeners.size}\nNo plaintext credentials or prompt texts included.`,
            generatedAt: new Date().toISOString(),
          } satisfies DiagnosticsPreview,
        }),
        diagnosticsExport: async () => ({
          ok: true,
          data: { saved: true },
        }),
        runCleanup: async () => ({
          ok: true,
          data: { removedLogFiles: 3, removedTempFiles: 7 },
        }),
      },
    };
  }

  public clearTimers(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}

export const fakeApiStore = new FakeApiStore();
export const fakeApi: PodApi = fakeApiStore.getApi();
