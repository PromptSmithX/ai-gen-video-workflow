import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Job } from '@shared/domain';
import { PodError, type ErrorCode } from '@shared/errors';
import { canTransition, type JobState } from '@shared/job-state';
import type { JobFilter, JobPatch, JobRepository, NewJob } from '@shared/services';
import type { AspectRatio } from '@shared/provider';
import { nowIso } from '../../../domain/ids';

interface JobRow {
  id: string;
  product_id: string;
  sku_snapshot: string;
  employee_id: string;
  provider: 'muse';
  provider_job_id: string | null;
  provider_reference_id: string | null;
  provider_asset_id: string | null;
  source_asset_id: string;
  prompt_template_id: string;
  prompt_template_version: string;
  prompt_sha256: string;
  prompt_overridden: number;
  duration_seconds: number | null;
  aspect_ratio: string | null;
  state: JobState;
  idempotency_key: string;
  attempt: number;
  regenerated_from_job_id: string | null;
  review_status: 'pending' | 'approved' | 'rejected';
  submit_intent_at: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  safe_error_message: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: JobRow): Job {
  return {
    id: row.id,
    productId: row.product_id,
    skuSnapshot: row.sku_snapshot,
    employeeId: row.employee_id,
    provider: 'muse',
    providerJobId: row.provider_job_id ?? null,
    providerReferenceId: row.provider_reference_id ?? null,
    providerAssetId: row.provider_asset_id ?? null,
    sourceAssetId: row.source_asset_id,
    promptTemplateId: row.prompt_template_id,
    promptTemplateVersion: row.prompt_template_version,
    promptSha256: row.prompt_sha256,
    promptOverridden: Boolean(row.prompt_overridden),
    durationSeconds: row.duration_seconds ?? null,
    aspectRatio: (row.aspect_ratio as AspectRatio) ?? null,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
    regeneratedFromJobId: row.regenerated_from_job_id ?? null,
    reviewStatus: row.review_status,
    submitIntentAt: row.submit_intent_at ?? null,
    acceptedAt: row.accepted_at ?? null,
    completedAt: row.completed_at ?? null,
    errorCode: (row.error_code as ErrorCode) ?? null,
    safeErrorMessage: row.safe_error_message ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteJobRepository implements JobRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(job: NewJob): Job {
    // Check if idempotency key already exists
    const existing = this.findByIdempotencyKey(job.idempotencyKey);
    if (existing) {
      throw new PodError('INVALID_STATE', 'Duplicate idempotency key');
    }

    const now = nowIso();
    const state = job.state ?? 'QUEUED';
    const attempt = 0;
    const reviewStatus = 'pending';

    const stmt = this.db.prepare(`
      INSERT INTO jobs (
        id, product_id, sku_snapshot, employee_id, provider,
        provider_job_id, provider_reference_id, provider_asset_id,
        source_asset_id, prompt_template_id, prompt_template_version,
        prompt_sha256, prompt_overridden, duration_seconds, aspect_ratio,
        state, idempotency_key, attempt, regenerated_from_job_id,
        review_status, submit_intent_at, accepted_at, completed_at,
        error_code, safe_error_message, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `);

    try {
      stmt.run(
        job.id,
        job.productId,
        job.skuSnapshot,
        job.employeeId,
        'muse',
        null,
        null,
        null,
        job.sourceAssetId,
        job.promptTemplateId,
        job.promptTemplateVersion,
        job.promptSha256,
        job.promptOverridden ? 1 : 0,
        job.durationSeconds ?? null,
        job.aspectRatio ?? null,
        state,
        job.idempotencyKey,
        attempt,
        job.regeneratedFromJobId ?? null,
        reviewStatus,
        null,
        null,
        null,
        null,
        null,
        now,
        now,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint failed') && msg.includes('idempotency_key')) {
        throw new PodError('INVALID_STATE', 'Duplicate idempotency key');
      }
      throw err;
    }

    return this.getById(job.id)!;
  }

  getById(id: string): Job | null {
    const stmt = this.db.prepare('SELECT * FROM jobs WHERE id = ?');
    const row = stmt.get(id) as unknown as JobRow | undefined;
    return row ? mapRow(row) : null;
  }

  findByIdempotencyKey(key: string): Job | null {
    const stmt = this.db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?');
    const row = stmt.get(key) as unknown as JobRow | undefined;
    return row ? mapRow(row) : null;
  }

  listActive(): Job[] {
    const stmt = this.db.prepare(`
      SELECT * FROM jobs
      WHERE state IN ('QUEUED', 'SUBMITTING', 'RUNNING', 'DOWNLOADING')
      ORDER BY created_at ASC
    `);
    const rows = stmt.all() as unknown as JobRow[];
    return rows.map(mapRow);
  }

  list(filter?: JobFilter): Job[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    let joinProducts = false;

    if (filter?.category) {
      joinProducts = true;
      conditions.push('products.category = ?');
      params.push(filter.category);
    }

    if (filter?.sku) {
      conditions.push('jobs.sku_snapshot = ?');
      params.push(filter.sku);
    }

    if (filter?.employeeId) {
      conditions.push('jobs.employee_id = ?');
      params.push(filter.employeeId);
    }

    if (filter?.states && filter.states.length > 0) {
      const placeholders = filter.states.map(() => '?').join(', ');
      conditions.push(`jobs.state IN (${placeholders})`);
      for (const s of filter.states) {
        params.push(s);
      }
    }

    if (filter?.templateVersion) {
      conditions.push('jobs.prompt_template_version = ?');
      params.push(filter.templateVersion);
    }

    if (filter?.reviewStatus) {
      conditions.push('jobs.review_status = ?');
      params.push(filter.reviewStatus);
    }

    if (filter?.from) {
      conditions.push('jobs.created_at >= ?');
      params.push(filter.from);
    }

    if (filter?.to) {
      conditions.push('jobs.created_at <= ?');
      params.push(filter.to);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const fromClause = joinProducts
      ? 'FROM jobs JOIN products ON jobs.product_id = products.id'
      : 'FROM jobs';

    const limit = filter?.limit ?? 200;
    const offset = filter?.offset ?? 0;

    const sql = `
      SELECT jobs.* ${fromClause}
      ${whereClause}
      ORDER BY jobs.created_at DESC
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as unknown as JobRow[];
    return rows.map(mapRow);
  }

  transition(id: string, to: JobState, patch?: JobPatch): Job {
    const current = this.getById(id);
    if (!current) {
      throw new PodError('NOT_FOUND', 'Job not found');
    }

    if (!canTransition(current.state, to)) {
      throw new PodError('INVALID_STATE', `Cannot transition job from ${current.state} to ${to}`);
    }

    const setClauses: string[] = ['state = ?', 'updated_at = ?'];
    const now = nowIso();
    const params: unknown[] = [to, now];

    if (patch) {
      if ('providerJobId' in patch) {
        setClauses.push('provider_job_id = ?');
        params.push(patch.providerJobId ?? null);
      }
      if ('providerReferenceId' in patch) {
        setClauses.push('provider_reference_id = ?');
        params.push(patch.providerReferenceId ?? null);
      }
      if ('providerAssetId' in patch) {
        setClauses.push('provider_asset_id = ?');
        params.push(patch.providerAssetId ?? null);
      }
      if ('submitIntentAt' in patch) {
        setClauses.push('submit_intent_at = ?');
        params.push(patch.submitIntentAt ?? null);
      }
      if ('acceptedAt' in patch) {
        setClauses.push('accepted_at = ?');
        params.push(patch.acceptedAt ?? null);
      }
      if ('completedAt' in patch) {
        setClauses.push('completed_at = ?');
        params.push(patch.completedAt ?? null);
      }
      if ('errorCode' in patch) {
        setClauses.push('error_code = ?');
        params.push(patch.errorCode ?? null);
      }
      if ('safeErrorMessage' in patch) {
        setClauses.push('safe_error_message = ?');
        params.push(patch.safeErrorMessage ?? null);
      }
      if ('attempt' in patch && patch.attempt !== undefined) {
        setClauses.push('attempt = ?');
        params.push(patch.attempt);
      }
      if ('reviewStatus' in patch && patch.reviewStatus !== undefined) {
        setClauses.push('review_status = ?');
        params.push(patch.reviewStatus);
      }
    }

    // Atomic update expecting current.state
    const sql = `
      UPDATE jobs
      SET ${setClauses.join(', ')}
      WHERE id = ? AND state = ?
    `;
    params.push(id, current.state);

    const stmt = this.db.prepare(sql);
    const result = (stmt as StatementSync).run(...(params as Parameters<StatementSync['run']>));

    if (result.changes !== 1) {
      throw new PodError(
        'INVALID_STATE',
        `Job state changed concurrently or transition failed (expected state ${current.state})`,
      );
    }

    return this.getById(id)!;
  }

  update(id: string, patch: JobPatch): Job {
    const current = this.getById(id);
    if (!current) {
      throw new PodError('NOT_FOUND', 'Job not found');
    }

    const setClauses: string[] = ['updated_at = ?'];
    const now = nowIso();
    const params: unknown[] = [now];

    if ('providerJobId' in patch) {
      setClauses.push('provider_job_id = ?');
      params.push(patch.providerJobId ?? null);
    }
    if ('providerReferenceId' in patch) {
      setClauses.push('provider_reference_id = ?');
      params.push(patch.providerReferenceId ?? null);
    }
    if ('providerAssetId' in patch) {
      setClauses.push('provider_asset_id = ?');
      params.push(patch.providerAssetId ?? null);
    }
    if ('submitIntentAt' in patch) {
      setClauses.push('submit_intent_at = ?');
      params.push(patch.submitIntentAt ?? null);
    }
    if ('acceptedAt' in patch) {
      setClauses.push('accepted_at = ?');
      params.push(patch.acceptedAt ?? null);
    }
    if ('completedAt' in patch) {
      setClauses.push('completed_at = ?');
      params.push(patch.completedAt ?? null);
    }
    if ('errorCode' in patch) {
      setClauses.push('error_code = ?');
      params.push(patch.errorCode ?? null);
    }
    if ('safeErrorMessage' in patch) {
      setClauses.push('safe_error_message = ?');
      params.push(patch.safeErrorMessage ?? null);
    }
    if ('attempt' in patch && patch.attempt !== undefined) {
      setClauses.push('attempt = ?');
      params.push(patch.attempt);
    }
    if ('reviewStatus' in patch && patch.reviewStatus !== undefined) {
      setClauses.push('review_status = ?');
      params.push(patch.reviewStatus);
    }

    const sql = `
      UPDATE jobs
      SET ${setClauses.join(', ')}
      WHERE id = ?
    `;
    params.push(id);

    const stmt = this.db.prepare(sql);
    (stmt as StatementSync).run(...(params as Parameters<StatementSync['run']>));

    return this.getById(id)!;
  }
}
