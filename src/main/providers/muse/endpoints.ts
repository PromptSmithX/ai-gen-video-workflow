/**
 * Endpoints and Zod schemas for the approved local Muse REST bridge.
 * Centralized here so adjustments can be made after inspecting live /v1/openapi.json.
 */
import { z } from 'zod';

// ASSUMPTION (verify against live /v1/openapi.json): Health endpoint path
export const HEALTH_ENDPOINT = '/v1/health';

// ASSUMPTION (verify against live /v1/openapi.json): Status endpoint path
export const STATUS_ENDPOINT = '/v1/status';

// ASSUMPTION (verify against live /v1/openapi.json): Reference image upload endpoint path
export const REFERENCES_ENDPOINT = '/v1/references';

// ASSUMPTION (verify against live /v1/openapi.json): Job submission endpoint path
export const JOBS_ENDPOINT = '/v1/jobs';

// ASSUMPTION (verify against live /v1/openapi.json): Job query by ID path
export const jobEndpoint = (id: string): string => `/v1/jobs/${encodeURIComponent(id)}`;

// ASSUMPTION (verify against live /v1/openapi.json): Job cancel endpoint path
export const jobCancelEndpoint = (id: string): string => `/v1/jobs/${encodeURIComponent(id)}/cancel`;

// ASSUMPTION (verify against live /v1/openapi.json): Asset download endpoint path
export const assetDownloadEndpoint = (id: string): string => `/v1/assets/${encodeURIComponent(id)}/download`;

// ASSUMPTION (verify against live /v1/openapi.json): Unauthenticated health response
export const HealthResponseSchema = z
  .object({
    status: z.string().optional(),
    ok: z.boolean().optional(),
    healthy: z.boolean().optional(),
  })
  .passthrough();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// ASSUMPTION (verify against live /v1/openapi.json): Bridge capabilities schema
export const BridgeCapabilitiesSchema = z
  .object({
    can_cancel: z.boolean().optional(),
    canCancel: z.boolean().optional(),
    reports_progress: z.boolean().optional(),
    reportsProgress: z.boolean().optional(),
    supported_durations: z.array(z.number()).optional(),
    supportedDurations: z.array(z.number()).optional(),
    supported_aspect_ratios: z.array(z.string()).optional(),
    supportedAspectRatios: z.array(z.string()).optional(),
    max_prompt_chars: z.number().optional(),
    maxPromptChars: z.number().optional(),
    max_upload_bytes: z.number().optional(),
    maxUploadBytes: z.number().optional(),
    can_lookup_by_request_id: z.boolean().optional(),
    canLookupByRequestId: z.boolean().optional(),
  })
  .passthrough();

// ASSUMPTION (verify against live /v1/openapi.json): Status endpoint response
export const StatusResponseSchema = z
  .object({
    status: z.string().optional(),
    authenticated: z.boolean().optional(),
    needs_login: z.boolean().optional(),
    login_required: z.boolean().optional(),
    quota_limited: z.boolean().optional(),
    quota_exhausted: z.boolean().optional(),
    busy: z.boolean().optional(),
    capabilities: BridgeCapabilitiesSchema.optional(),
  })
  .passthrough();

export type StatusResponse = z.infer<typeof StatusResponseSchema>;

// ASSUMPTION (verify against live /v1/openapi.json): Reference upload response
export const ReferenceUploadResponseSchema = z
  .object({
    reference_id: z.string().optional(),
    id: z.string().optional(),
    kind: z.string().optional(),
    mime: z.string().optional(),
    bytes: z.number().optional(),
    sha256: z.string().optional(),
  })
  .passthrough();

export type ReferenceUploadResponse = z.infer<typeof ReferenceUploadResponseSchema>;

// ASSUMPTION (verify against live /v1/openapi.json): Item in jobs submit response array
const JobItemSchema = z
  .object({
    id: z.string().optional(),
    job_id: z.string().optional(),
  })
  .passthrough();

// ASSUMPTION (verify against live /v1/openapi.json): Job submission response
export const JobSubmitResponseSchema = z
  .object({
    id: z.string().optional(),
    job_id: z.string().optional(),
    state: z.string().optional(),
    jobs: z.array(JobItemSchema).optional(),
  })
  .passthrough();

export type JobSubmitResponse = z.infer<typeof JobSubmitResponseSchema>;

// ASSUMPTION (verify against live /v1/openapi.json): Job query response
export const JobStatusResponseSchema = z
  .object({
    id: z.string().optional(),
    job_id: z.string().optional(),
    state: z.string(),
    progress: z.number().nullable().optional(),
    asset_id: z.string().nullable().optional(),
    asset_url: z.string().nullable().optional(),
    output_url: z.string().nullable().optional(),
    reference_id: z.string().nullable().optional(),
    error_code: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    safe_message: z.string().nullable().optional(),
    message: z.string().nullable().optional(),
  })
  .passthrough();

export type JobStatusResponse = z.infer<typeof JobStatusResponseSchema>;

// ASSUMPTION (verify against live /v1/openapi.json): Bridge error payload shape
export const BridgeErrorResponseSchema = z
  .object({
    error: z
      .union([
        z.string(),
        z
          .object({
            code: z.string().optional(),
            message: z.string().optional(),
          })
          .passthrough(),
      ])
      .optional(),
    code: z.string().optional(),
    message: z.string().optional(),
    submitted: z.boolean().optional(),
  })
  .passthrough();

export type BridgeErrorResponse = z.infer<typeof BridgeErrorResponseSchema>;
