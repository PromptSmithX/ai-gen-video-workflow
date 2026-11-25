/** Domain DTOs shared by main and renderer (brief §7). Plain data only; no Node/Electron imports. */
import type { JobState } from './job-state';
import type { AspectRatio } from './provider';
import type { ErrorCode } from './errors';

/** SKU rule (brief §5 A): after trim + uppercase, only A-Z 0-9 - _ ; 1..64 chars; no leading dot/separator. */
export const SKU_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,63}$/;

/** Windows reserved device names may not be used as folder names. */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/;

/**
 * Normalizes and validates a SKU. Returns the normalized SKU or null when invalid.
 * Shared by renderer (live validation) and main (authoritative validation before any path use).
 */
export function normalizeSku(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const sku = raw.trim().toUpperCase();
  if (!SKU_PATTERN.test(sku)) return null;
  if (WINDOWS_RESERVED.test(sku)) return null;
  return sku;
}

export interface Category {
  id: string;
  label: string;
  /** Prompt category snippet group (prompts/categories/<group>.md). */
  promptGroup: 'apparel' | 'drinkware' | 'home-decor' | 'other';
}

/** Default company-managed category list; admins may edit (stored in settings). */
export const DEFAULT_CATEGORIES: Category[] = [
  { id: 't-shirt', label: 'T-shirt', promptGroup: 'apparel' },
  { id: 'hoodie', label: 'Hoodie', promptGroup: 'apparel' },
  { id: 'sweatshirt', label: 'Sweatshirt', promptGroup: 'apparel' },
  { id: 'tumbler', label: 'Tumbler', promptGroup: 'drinkware' },
  { id: 'mug', label: 'Mug', promptGroup: 'drinkware' },
  { id: 'pillow', label: 'Pillow', promptGroup: 'home-decor' },
  { id: 'poster', label: 'Poster', promptGroup: 'home-decor' },
  { id: 'blanket', label: 'Blanket', promptGroup: 'home-decor' },
];

export type AssetRole = 'source_image' | 'generated_video' | 'thumbnail' | 'prompt_snapshot';
export type ReviewStatus = 'pending' | 'approved' | 'rejected';
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface Product {
  id: string;
  sku: string;
  category: string;
  productName: string | null;
  createdAt: string; // ISO-8601
  updatedAt: string;
}

export interface Job {
  id: string;
  productId: string;
  skuSnapshot: string;
  employeeId: string;
  provider: 'muse';
  providerJobId: string | null;
  providerReferenceId: string | null;
  providerAssetId: string | null;
  sourceAssetId: string;
  promptTemplateId: string;
  promptTemplateVersion: string;
  promptSha256: string;
  promptOverridden: boolean;
  durationSeconds: number | null;
  aspectRatio: AspectRatio | null;
  state: JobState;
  /** Stable UUID; Idempotency-Key for the provider. Unique. */
  idempotencyKey: string;
  /** Manual retry counter (PROVIDER_ERROR allows one manual retry). */
  attempt: number;
  /** Job this one was regenerated from (new job + new key after explicit confirm). */
  regeneratedFromJobId: string | null;
  reviewStatus: ReviewStatus;
  submitIntentAt: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
  errorCode: ErrorCode | null;
  safeErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Asset {
  id: string;
  productId: string;
  jobId: string | null;
  role: AssetRole;
  /** Relative to the configured library root, forward slashes. Never absolute. */
  path: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  sha256: string;
  createdAt: string;
}

/** Result of validating an image chosen/dropped by the employee. */
export interface ImageInfo {
  mime: ImageMime;
  width: number;
  height: number;
  bytes: number;
}
