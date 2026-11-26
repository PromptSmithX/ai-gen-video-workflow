/** Prompt Master / template contracts (brief §6). */

/** Allowed template variables. Unknown `{{x}}` placeholders are a validation error. */
export const PROMPT_VARIABLES = [
  'sku',
  'product_category',
  'product_name',
  'source_image_filename',
  'duration_seconds',
  'aspect_ratio',
  'review_style',
] as const;

export type PromptVariableName = (typeof PROMPT_VARIABLES)[number];

export interface PromptVariables {
  sku: string;
  product_category: string;
  product_name?: string;
  /** Metadata only; never a local path. */
  source_image_filename?: string;
  /** Only rendered when the provider supports it. */
  duration_seconds?: number;
  /** Only rendered when the provider supports it. */
  aspect_ratio?: string;
  review_style?: string;
}

export interface PromptTemplateSummary {
  /** e.g. "product-review" */
  id: string;
  /** e.g. "v2" */
  version: string;
  title: string;
  /** True when this is the built-in placeholder, not the company-approved text. */
  isPlaceholder: boolean;
  /** 'builtin' = prompts/ folder in the app, 'company' = imported from PROMPT_MASTER_PATH, 'admin' = saved via Admin. */
  source: 'builtin' | 'company' | 'admin';
  isDefault: boolean;
  createdAt: string | null;
  note: string | null;
}

export interface PromptTemplate extends PromptTemplateSummary {
  body: string;
}

export type QualityRuleId =
  | 'preserve_artwork'
  | 'no_design_changes'
  | 'consistent_product'
  | 'natural_texture'
  | 'physical_continuity'
  | 'no_impossible_transitions'
  | 'human_review_action'
  | 'no_fake_claims';

export interface QualityCheck {
  rule: QualityRuleId;
  label: string;
  passed: boolean;
}

export interface QualityReport {
  passed: boolean;
  checks: QualityCheck[];
}

export interface RenderedPrompt {
  text: string;
  chars: number;
  maxChars: number;
  templateId: string;
  templateVersion: string;
  isPlaceholder: boolean;
  quality: QualityReport;
  /** Validation errors (unknown placeholder, too long, missing variable...). Empty = valid. */
  errors: string[];
}

/** Calendar template where the interior artwork is composited locally onto a blank page (compositor sidecar). */
export const CALENDAR_COMPOSITE_TEMPLATE_ID = 'calendar-review';
/**
 * Calendar template where Muse draws the interior page itself from a two-panel reference board (cover left, interior
 * right). Jobs made with it skip the compositor.
 */
export const CALENDAR_AI_TEMPLATE_ID = 'calendar-review-ai';

export function isCalendarTemplateId(id: string): boolean {
  return id === CALENDAR_COMPOSITE_TEMPLATE_ID || id === CALENDAR_AI_TEMPLATE_ID;
}
