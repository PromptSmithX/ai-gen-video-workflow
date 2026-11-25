/**
 * Endpoints and Zod schemas for the local Muse4AI bridge.
 * Verified against the live contract: Muse4AI agent API 2.0.0-beta.35 (`GET /v1/openapi.json`,
 * snapshot in docs/api/bridge-openapi.json). Re-check this file when Muse4AI's major/minor version changes.
 *
 * Schemas are lenient (`passthrough`, optional fields) so additive bridge changes do not break parsing;
 * only fields the provider actually reads are declared.
 */
import { z } from 'zod';

/** Unauthenticated liveness: `{ ok, service: "muse4ai", instance }`. */
export const HEALTH_ENDPOINT = '/v1/health';
/** Capabilities, accounts (+quota), key scope, limits. */
export const STATUS_ENDPOINT = '/v1/status';
/** Raw-bytes upload (PNG/JPEG/WEBP ≤ 20 MiB, ≤ 8192 px/edge) → 201 `{ reference_id, … }`. */
export const REFERENCES_ENDPOINT = '/v1/references';
/** POST → 202 `{ jobs: Job[] }`. Honors `Idempotency-Key` (same key + same body → same jobs). */
export const JOBS_ENDPOINT = '/v1/jobs';
export const jobEndpoint = (id: string): string => `/v1/jobs/${encodeURIComponent(id)}`;
export const jobCancelEndpoint = (id: string): string => `/v1/jobs/${encodeURIComponent(id)}/cancel`;
/** Bearer-authenticated download of an output (`outputs[].asset_id`). */
export const assetDownloadEndpoint = (id: string): string => `/v1/assets/${encodeURIComponent(id)}/content`;

export const HealthResponseSchema = z
  .object({
    ok: z.boolean().optional(),
    service: z.string().optional(),
  })
  .passthrough();
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const BridgeCapabilitiesSchema = z
  .object({
    video_from_image: z.boolean().optional(),
    video_from_text: z.boolean().optional(),
    chat: z.boolean().optional(),
  })
  .passthrough();

const AccountItemSchema = z
  .object({
    group: z.string().optional(),
    quota: z.object({ tier: z.string().optional() }).passthrough().nullable().optional(),
  })
  .passthrough();

export const StatusResponseSchema = z
  .object({
    service: z.string().optional(),
    version: z.string().optional(),
    capabilities: BridgeCapabilitiesSchema.optional(),
    accounts: z
      .object({
        total: z.number().optional(),
        ready: z.number().optional(),
        busy: z.number().optional(),
        waiting: z.number().optional(),
        needs_user: z.number().optional(),
        paused: z.number().optional(),
        items: z.array(AccountItemSchema).optional(),
      })
      .passthrough()
      .optional(),
    key: z.object({ scope: z.string().optional() }).passthrough().optional(),
    limits: z
      .object({
        prompt_max_chars: z.number().optional(),
        chat_prompt_max_chars: z.number().optional(),
        upload_max_bytes: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

export const ReferenceUploadResponseSchema = z
  .object({
    reference_id: z.string(),
    kind: z.string().optional(),
    mime: z.string().optional(),
    bytes: z.number().optional(),
    sha256: z.string().optional(),
  })
  .passthrough();
export type ReferenceUploadResponse = z.infer<typeof ReferenceUploadResponseSchema>;

export const OutputSchema = z
  .object({
    asset_id: z.string(),
    kind: z.string().optional(),
    mime: z.string().optional(),
    bytes: z.number().optional(),
    available: z.boolean().optional(),
  })
  .passthrough();

/** Public job status (use this in code; `state` is Muse4AI-internal and may grow new values). */
export const BRIDGE_JOB_STATUSES = ['queued', 'running', 'needs_review', 'succeeded', 'failed', 'cancelled'] as const;

export const JobSchema = z
  .object({
    id: z.string(),
    kind: z.string().optional(),
    status: z.string(),
    state: z.string().optional(),
    needs_human: z.boolean().optional(),
    error: z
      .object({ code: z.string().optional(), message: z.string().optional() })
      .passthrough()
      .nullable()
      .optional(),
    outputs: z.array(OutputSchema).optional(),
  })
  .passthrough();
export type BridgeJob = z.infer<typeof JobSchema>;

export const JobSubmitResponseSchema = z.object({ jobs: z.array(JobSchema).min(1) }).passthrough();
export type JobSubmitResponse = z.infer<typeof JobSubmitResponseSchema>;

/** RFC 9457 problem+json with a stable `code` (e.g. invalid_api_key, invalid_request, capability_unavailable). */
export const BridgeErrorResponseSchema = z
  .object({
    code: z.string().optional(),
    status: z.number().optional(),
    retry_after: z.number().optional(),
  })
  .passthrough();
export type BridgeErrorResponse = z.infer<typeof BridgeErrorResponseSchema>;
