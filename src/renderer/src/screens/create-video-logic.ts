import type { Category } from '@shared/domain';
import type { AspectRatio } from '@shared/provider';
import type { PromptTemplateSummary, RenderedPrompt } from '@shared/prompt';
import type { CreateJobInput, StagedImage } from '@shared/ipc';

export function makeTemplateKey(tpl: { id: string; version: string }): string {
  return `${tpl.id}@@${tpl.version}`;
}

export function findCalendarTemplate(templates: PromptTemplateSummary[]): PromptTemplateSummary | null {
  const calTemplates = templates.filter((t) => t.id === 'calendar-review');
  if (calTemplates.length === 0) return null;
  // Prefer default (company/admin default over placeholder, or any default)
  const defaultTpl =
    calTemplates.find((t) => t.isDefault && !t.isPlaceholder) ??
    calTemplates.find((t) => t.isDefault);
  if (defaultTpl) return defaultTpl;
  // Otherwise latest version in list
  return calTemplates[calTemplates.length - 1] ?? null;
}

export function findDefaultNonCalendarTemplate(templates: PromptTemplateSummary[]): PromptTemplateSummary | null {
  const nonCalTemplates = templates.filter((t) => t.id !== 'calendar-review');
  if (nonCalTemplates.length === 0) return templates[0] ?? null;
  return (
    nonCalTemplates.find((t) => t.isDefault && !t.isPlaceholder) ??
    nonCalTemplates.find((t) => t.isDefault) ??
    nonCalTemplates.find((t) => t.id === 'product-review') ??
    nonCalTemplates[0] ??
    null
  );
}

export interface PickTemplateParams {
  prevCategory?: Category | null;
  newCategory?: Category | null;
  currentTemplateKey: string;
  templates: PromptTemplateSummary[];
  defaultNonCalendarKey?: string;
}

export function pickTemplateForCategory(params: PickTemplateParams): string {
  const { prevCategory, newCategory, currentTemplateKey, templates } = params;
  const isNewCal = newCategory?.promptGroup === 'calendar';
  const isPrevCal = prevCategory?.promptGroup === 'calendar';

  if (isNewCal) {
    if (!isPrevCal) {
      // Switched into calendar: select calendar-review (default / latest version)
      const calTpl = findCalendarTemplate(templates);
      return calTpl ? makeTemplateKey(calTpl) : '';
    }
    // Already in calendar: keep current choice if valid calendar template, otherwise find calendar-review
    if (currentTemplateKey) {
      const [id] = currentTemplateKey.split('@@');
      if (id === 'calendar-review') return currentTemplateKey;
    }
    const calTpl = findCalendarTemplate(templates);
    return calTpl ? makeTemplateKey(calTpl) : '';
  }

  // New category is non-calendar
  if (isPrevCal) {
    // Switched from calendar to non-calendar: restore the previous non-calendar default
    if (params.defaultNonCalendarKey) {
      return params.defaultNonCalendarKey;
    }
    const defTpl = findDefaultNonCalendarTemplate(templates);
    return defTpl ? makeTemplateKey(defTpl) : '';
  }

  // Both categories are non-calendar: manual choice is not overridden without category change
  if (currentTemplateKey) {
    return currentTemplateKey;
  }
  if (params.defaultNonCalendarKey) {
    return params.defaultNonCalendarKey;
  }
  const defTpl = findDefaultNonCalendarTemplate(templates);
  return defTpl ? makeTemplateKey(defTpl) : '';
}

export function aspectWarning(
  cover?: { width: number; height: number } | null,
  artwork?: { width: number; height: number } | null,
  threshold = 0.15,
): boolean {
  if (!cover || !artwork) return false;
  if (cover.width <= 0 || cover.height <= 0 || artwork.width <= 0 || artwork.height <= 0) return false;
  const coverRatio = cover.width / cover.height;
  const artworkRatio = artwork.width / artwork.height;
  const diff = Math.abs(artworkRatio - coverRatio) / coverRatio;
  return diff > threshold;
}

export interface GenerateCheckParams {
  stagedImage: StagedImage | null;
  interiorArtworkStaged: StagedImage | null;
  isCalendar: boolean;
  normalizedSku: string | null;
  selectedCategoryId: string;
  selectedTemplateKey: string;
  renderedPrompt: RenderedPrompt | null;
  isQualityPassed: boolean;
  isProviderReady: boolean;
  isSubmitting: boolean;
}

export function isGenerateEnabled(params: GenerateCheckParams): boolean {
  if (params.isSubmitting) return false;
  if (!params.stagedImage) return false;
  if (params.isCalendar && !params.interiorArtworkStaged) return false;
  if (!params.normalizedSku) return false;
  if (!params.selectedCategoryId) return false;
  if (!params.selectedTemplateKey) return false;
  if (!params.renderedPrompt) return false;
  if (params.renderedPrompt.errors.length > 0) return false;
  if (!params.isQualityPassed) return false;
  if (!params.isProviderReady) return false;
  return true;
}

export interface BuildPayloadParams {
  clientRequestId: string;
  stagedImage: StagedImage;
  interiorArtworkStaged?: StagedImage | null;
  isCalendar: boolean;
  normalizedSku: string;
  selectedCategoryId: string;
  templateId: string;
  templateVersion: string;
  productName?: string;
  promptOverride?: string;
  durationSeconds?: number;
  aspectRatio?: AspectRatio;
}

export function buildCreateJobPayload(params: BuildPayloadParams): CreateJobInput {
  const {
    clientRequestId,
    stagedImage,
    interiorArtworkStaged,
    isCalendar,
    normalizedSku,
    selectedCategoryId,
    templateId,
    templateVersion,
    productName,
    promptOverride,
    durationSeconds,
    aspectRatio,
  } = params;

  const payload: CreateJobInput = {
    clientRequestId,
    sourceToken: stagedImage.token,
    sku: normalizedSku,
    categoryId: selectedCategoryId,
    templateId,
    templateVersion,
    fileName: stagedImage.fileName,
  };

  if (isCalendar && interiorArtworkStaged) {
    payload.interiorArtworkToken = interiorArtworkStaged.token;
  }

  if (productName && productName.trim()) {
    payload.productName = productName.trim();
  }
  if (promptOverride !== undefined && promptOverride !== '') {
    payload.promptOverride = promptOverride;
  }
  if (durationSeconds !== undefined) {
    payload.durationSeconds = durationSeconds;
  }
  if (aspectRatio !== undefined) {
    payload.aspectRatio = aspectRatio;
  }

  return payload;
}
