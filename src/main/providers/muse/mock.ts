/**
 * MockMuseProvider: fully offline, deterministic, configurable mock provider.
 * Implements brief §3.3, §4, §10 and W3 task specification.
 */
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type {
  DownloadResult,
  GenerateVideoInput,
  MuseProvider,
  ProviderCapabilities,
  ProviderConnectionState,
  ProviderJob,
} from '@shared/provider';
import { ProviderError } from '@shared/provider';
import { SAFE_ERROR_MESSAGES } from '@shared/errors';
import { createMinimalValidMp4 } from './mp4';

export type MockScenario =
  | 'success'
  | 'not_connected'
  | 'needs_login'
  | 'refused'
  | 'quota'
  | 'provider_5xx'
  | 'ambiguous'
  | 'success_no_asset'
  | 'corrupt_mp4'
  | 'slow';

export interface MockMuseProviderOptions {
  scenario?: MockScenario;
  canCancel?: boolean;
  reportsProgress?: boolean;
}

interface StoredMockJob {
  job: ProviderJob;
  polls: number;
}

export class MockMuseProvider implements MuseProvider {
  readonly kind = 'mock' as const;
  private scenario: MockScenario;
  private readonly canCancelFlag: boolean;
  private readonly reportsProgressFlag: boolean;
  private generationCount = 0;

  private readonly jobsById = new Map<string, StoredMockJob>();
  private readonly jobsByRequestId = new Map<string, string>(); // requestId -> providerJobId

  constructor(options: MockMuseProviderOptions = {}) {
    const envScenario = process.env['POD_MOCK_SCENARIO'] as MockScenario | undefined;
    const validScenarios: MockScenario[] = [
      'success',
      'not_connected',
      'needs_login',
      'refused',
      'quota',
      'provider_5xx',
      'ambiguous',
      'success_no_asset',
      'corrupt_mp4',
      'slow',
    ];

    if (options.scenario) {
      this.scenario = options.scenario;
    } else if (envScenario && validScenarios.includes(envScenario)) {
      this.scenario = envScenario;
    } else {
      this.scenario = 'success';
    }

    this.canCancelFlag = options.canCancel ?? true;
    this.reportsProgressFlag = options.reportsProgress ?? false;
  }

  getScenario(): MockScenario {
    return this.scenario;
  }

  setScenario(scenario: MockScenario): void {
    this.scenario = scenario;
  }

  getGenerationCount(): number {
    return this.generationCount;
  }

  async getConnectionState(): Promise<ProviderConnectionState> {
    switch (this.scenario) {
      case 'not_connected':
        return 'not_installed';
      case 'needs_login':
        return 'needs_login';
      case 'quota':
        return 'quota_limited';
      case 'provider_5xx':
        return 'error';
      default:
        return 'ready';
    }
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      canCancel: this.canCancelFlag,
      reportsProgress: this.reportsProgressFlag,
      supportedDurations: [5, 10],
      supportedAspectRatios: ['9:16', '16:9', '1:1'],
      maxPromptChars: 4000,
      maxUploadBytes: 20 * 1024 * 1024,
    };
  }

  async generateVideo(input: GenerateVideoInput): Promise<ProviderJob> {
    // 1. Scenario pre-failures
    if (this.scenario === 'not_connected') {
      throw new ProviderError('NOT_CONNECTED', 'before_submit');
    }
    if (this.scenario === 'needs_login') {
      throw new ProviderError('NEEDS_LOGIN', 'before_submit');
    }
    if (this.scenario === 'quota') {
      throw new ProviderError('QUOTA_LIMITED', 'before_submit');
    }
    if (this.scenario === 'refused') {
      throw new ProviderError('CONTENT_REFUSED', 'after_submit');
    }
    if (this.scenario === 'provider_5xx' || this.scenario === 'ambiguous') {
      return {
        providerJobId: '',
        state: 'ambiguous',
        errorCode: 'SUBMIT_AMBIGUOUS',
        safeMessage: SAFE_ERROR_MESSAGES.SUBMIT_AMBIGUOUS,
      };
    }

    // 2. Pre-checks on prompt and input
    if (input.prompt.length > 4000) {
      throw new ProviderError('PROMPT_TOO_LONG', 'before_submit');
    }

    // 3. Idempotency: return existing job if same requestId is reused
    const existingJobId = this.jobsByRequestId.get(input.requestId);
    if (existingJobId) {
      const stored = this.jobsById.get(existingJobId);
      if (stored) {
        return { ...stored.job };
      }
    }

    // 4. Create new job (exactly one generation counted)
    this.generationCount++;
    const providerJobId = `mock-job-${crypto.randomUUID()}`;
    const providerReferenceId = `mock-ref-${crypto.randomUUID()}`;
    const providerAssetId =
      this.scenario === 'success_no_asset' ? undefined : `mock-asset-${crypto.randomUUID()}`;

    const newJob: ProviderJob = {
      providerJobId,
      state: 'queued',
      providerReferenceId,
      providerAssetId,
    };

    this.jobsById.set(providerJobId, { job: newJob, polls: 0 });
    this.jobsByRequestId.set(input.requestId, providerJobId);

    return { ...newJob };
  }

  async getJob(providerJobId: string): Promise<ProviderJob> {
    const stored = this.jobsById.get(providerJobId);
    if (!stored) {
      throw new ProviderError('NOT_FOUND', 'after_submit', `Job ${providerJobId} not found.`);
    }

    // Progress job state deterministically
    stored.polls++;

    if (stored.job.state !== 'cancelled' && stored.job.state !== 'failed') {
      if (this.scenario === 'slow') {
        if (stored.polls <= 3) {
          stored.job.state = 'queued';
        } else if (stored.polls <= 6) {
          stored.job.state = 'running';
          if (this.reportsProgressFlag) {
            stored.job.progress = 0.5;
          }
        } else {
          stored.job.state = 'succeeded';
          if (this.reportsProgressFlag) {
            stored.job.progress = 1.0;
          }
        }
      } else {
        if (stored.polls === 1) {
          stored.job.state = 'running';
          if (this.reportsProgressFlag) {
            stored.job.progress = 0.5;
          }
        } else {
          stored.job.state = 'succeeded';
          if (this.reportsProgressFlag) {
            stored.job.progress = 1.0;
          }
        }
      }
    }

    return { ...stored.job };
  }

  async findJobByRequestId(requestId: string): Promise<ProviderJob | null> {
    const jobId = this.jobsByRequestId.get(requestId);
    if (!jobId) return null;
    const stored = this.jobsById.get(jobId);
    return stored ? { ...stored.job } : null;
  }

  async downloadOutput(
    providerJobId: string,
    destPath: string,
    maxBytes: number
  ): Promise<DownloadResult> {
    const stored = this.jobsById.get(providerJobId);
    if (!stored) {
      throw new ProviderError('NOT_FOUND', 'after_submit');
    }

    if (this.scenario === 'success_no_asset' || !stored.job.providerAssetId) {
      throw new ProviderError('OUTPUT_MISSING', 'after_submit');
    }

    let fileBytes: Buffer;
    if (this.scenario === 'corrupt_mp4') {
      fileBytes = Buffer.from('NOT_AN_MP4_FILE_JUST_GARBAGE_BYTES_1234567890');
    } else {
      fileBytes = createMinimalValidMp4();
    }

    if (fileBytes.length > maxBytes) {
      throw new ProviderError('DOWNLOAD_FAILED', 'after_submit', 'Asset exceeds maxBytes limit.');
    }

    fs.writeFileSync(destPath, fileBytes);
    return { bytes: fileBytes.length };
  }

  async cancelJob(providerJobId: string): Promise<void> {
    if (!this.canCancelFlag) {
      throw new ProviderError('INVALID_STATE', 'before_submit', 'Mock provider cannot cancel.');
    }
    const stored = this.jobsById.get(providerJobId);
    if (stored) {
      stored.job.state = 'cancelled';
    }
  }
}
