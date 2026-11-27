import { describe, expect, it } from 'vitest';
import {
  aspectWarning,
  buildCreateJobPayload,
  findDefaultNonCalendarTemplate,
  isGenerateEnabled,
  makeTemplateKey,
  pickTemplateForCategory,
  type BuildPayloadParams,
  type GenerateCheckParams,
} from './create-video-logic';
import type { Category } from '@shared/domain';
import type { PromptTemplateSummary } from '@shared/prompt';
import type { StagedImage } from '@shared/ipc';

describe('create-video-logic pure functions', () => {
  const frontCoverImage: StagedImage = {
    token: 'token_front_cover_123',
    fileName: 'front-cover.png',
    info: { mime: 'image/png', width: 1000, height: 1000, bytes: 50000 },
    previewUrl: 'pod-media://staged/token_front_cover_123',
  };

  const interiorArtworkImage: StagedImage = {
    token: 'token_interior_art_456',
    fileName: 'january-art.png',
    info: { mime: 'image/png', width: 1000, height: 1000, bytes: 60000 },
    previewUrl: 'pod-media://staged/token_interior_art_456',
  };

  const sampleTemplates: PromptTemplateSummary[] = [
    {
      id: 'product-review',
      version: 'v1',
      title: 'Product Review V1',
      isPlaceholder: false,
      source: 'builtin',
      isDefault: false,
      createdAt: '2026-11-01',
      note: null,
    },
    {
      id: 'product-review',
      version: 'v2',
      title: 'Product Review V2',
      isPlaceholder: false,
      source: 'builtin',
      isDefault: true,
      createdAt: '2026-11-10',
      note: null,
    },
    {
      id: 'calendar-review',
      version: 'v1',
      title: 'Calendar Review V1',
      isPlaceholder: false,
      source: 'builtin',
      isDefault: true,
      createdAt: '2026-11-25',
      note: null,
    },
    {
      id: 'quick-showcase',
      version: 'v1',
      title: 'Quick Showcase',
      isPlaceholder: true,
      source: 'builtin',
      isDefault: false,
      createdAt: '2026-11-05',
      note: null,
    },
  ];

  const tshirtCategory: Category = { id: 't-shirt', label: 'T-shirt', promptGroup: 'apparel' };
  const hoodieCategory: Category = { id: 'hoodie', label: 'Hoodie', promptGroup: 'apparel' };
  const calendarCategory: Category = { id: 'desk-calendar', label: 'Desk Calendar', promptGroup: 'calendar' };

  describe('buildCreateJobPayload', () => {
    it('Apparel: payload has sourceToken and omits interiorArtworkToken', () => {
      const params: BuildPayloadParams = {
        clientRequestId: 'req-uuid-1',
        stagedImage: frontCoverImage,
        interiorArtworkStaged: null,
        isCalendar: false,
        normalizedSku: 'TS-001',
        selectedCategoryId: 't-shirt',
        templateId: 'product-review',
        templateVersion: 'v2',
      };

      const payload = buildCreateJobPayload(params);
      expect(payload.sourceToken).toBe('token_front_cover_123');
      expect(payload.interiorArtworkToken).toBeUndefined();
      expect(payload.sku).toBe('TS-001');
      expect(payload.clientRequestId).toBe('req-uuid-1');
    });

    it('Calendar: payload has both sourceToken and interiorArtworkToken', () => {
      const params: BuildPayloadParams = {
        clientRequestId: 'req-uuid-2',
        stagedImage: frontCoverImage,
        interiorArtworkStaged: interiorArtworkImage,
        isCalendar: true,
        normalizedSku: 'CAL-001',
        selectedCategoryId: 'desk-calendar',
        templateId: 'calendar-review',
        templateVersion: 'v1',
      };

      const payload = buildCreateJobPayload(params);
      expect(payload.sourceToken).toBe('token_front_cover_123');
      expect(payload.interiorArtworkToken).toBe('token_interior_art_456');
      expect(payload.sku).toBe('CAL-001');
    });

    it('Switching calendar → T-shirt with artwork staged in params: payload omits interiorArtworkToken', () => {
      const params: BuildPayloadParams = {
        clientRequestId: 'req-uuid-3',
        stagedImage: frontCoverImage,
        interiorArtworkStaged: interiorArtworkImage, // Stale state kept from switching back
        isCalendar: false, // Selected category is now apparel!
        normalizedSku: 'TS-002',
        selectedCategoryId: 't-shirt',
        templateId: 'product-review',
        templateVersion: 'v2',
      };

      const payload = buildCreateJobPayload(params);
      expect(payload.sourceToken).toBe('token_front_cover_123');
      expect(payload.interiorArtworkToken).toBeUndefined();
      expect('interiorArtworkToken' in payload).toBe(false);
    });
  });

  describe('isGenerateEnabled', () => {
    const baseParams: GenerateCheckParams = {
      stagedImage: frontCoverImage,
      interiorArtworkStaged: null,
      isCalendar: false,
      normalizedSku: 'TS-001',
      selectedCategoryId: 't-shirt',
      selectedTemplateKey: 'product-review@@v2',
      renderedPrompt: {
        text: 'valid prompt',
        chars: 12,
        maxChars: 4000,
        templateId: 'product-review',
        templateVersion: 'v2',
        isPlaceholder: false,
        quality: { passed: true, checks: [] },
        errors: [],
      },
      isQualityPassed: true,
      isProviderReady: true,
      isSubmitting: false,
    };

    it('Apparel: Generate enabled with single image staged', () => {
      expect(isGenerateEnabled(baseParams)).toBe(true);
    });

    it('Calendar: Generate disabled until both images are staged', () => {
      // Calendar with only front cover staged
      const calParams1: GenerateCheckParams = {
        ...baseParams,
        isCalendar: true,
        interiorArtworkStaged: null,
      };
      expect(isGenerateEnabled(calParams1)).toBe(false);

      // Calendar with both front cover and interior artwork staged
      const calParams2: GenerateCheckParams = {
        ...baseParams,
        isCalendar: true,
        interiorArtworkStaged: interiorArtworkImage,
      };
      expect(isGenerateEnabled(calParams2)).toBe(true);
    });

    it('Disabled when missing required fields or checks fail', () => {
      expect(isGenerateEnabled({ ...baseParams, stagedImage: null })).toBe(false);
      expect(isGenerateEnabled({ ...baseParams, normalizedSku: null })).toBe(false);
      expect(isGenerateEnabled({ ...baseParams, selectedCategoryId: '' })).toBe(false);
      expect(isGenerateEnabled({ ...baseParams, selectedTemplateKey: '' })).toBe(false);
      expect(isGenerateEnabled({ ...baseParams, renderedPrompt: null })).toBe(false);
      expect(
        isGenerateEnabled({
          ...baseParams,
          renderedPrompt: { ...baseParams.renderedPrompt!, errors: ['some error'] },
        }),
      ).toBe(false);
      expect(isGenerateEnabled({ ...baseParams, isQualityPassed: false })).toBe(false);
      expect(isGenerateEnabled({ ...baseParams, isProviderReady: false })).toBe(false);
      expect(isGenerateEnabled({ ...baseParams, isSubmitting: true })).toBe(false);
    });
  });

  describe('pickTemplateForCategory', () => {
    const defaultNonCalKey = makeTemplateKey(sampleTemplates[1]!); // product-review@@v2

    it('Selecting calendar picks calendar-review', () => {
      const selected = pickTemplateForCategory({
        prevCategory: tshirtCategory,
        newCategory: calendarCategory,
        currentTemplateKey: defaultNonCalKey,
        templates: sampleTemplates,
        defaultNonCalendarKey: defaultNonCalKey,
      });

      expect(selected).toBe('calendar-review@@v1');
    });

    it('Selecting T-shirt after calendar restores product-review / configured default', () => {
      const selected = pickTemplateForCategory({
        prevCategory: calendarCategory,
        newCategory: tshirtCategory,
        currentTemplateKey: 'calendar-review@@v1',
        templates: sampleTemplates,
        defaultNonCalendarKey: defaultNonCalKey,
      });

      expect(selected).toBe('product-review@@v2');
    });

    it('Manual choice is not overridden without category change or when changing between non-calendar categories', () => {
      const manualChoiceKey = 'quick-showcase@@v1';

      // Switching between non-calendar categories (T-shirt -> Hoodie)
      const selected = pickTemplateForCategory({
        prevCategory: tshirtCategory,
        newCategory: hoodieCategory,
        currentTemplateKey: manualChoiceKey,
        templates: sampleTemplates,
        defaultNonCalendarKey: defaultNonCalKey,
      });

      expect(selected).toBe(manualChoiceKey);
    });

    it('Prefers calendar-review-2clip; keeps a manual calendar-review choice', () => {
      const withAi: PromptTemplateSummary[] = [
        ...sampleTemplates,
        { ...sampleTemplates[2]!, id: 'calendar-review-ai', version: 'v1', title: 'AI inside page' },
        { ...sampleTemplates[2]!, id: 'calendar-review-2clip', version: 'v1', title: 'Two clips' },
      ];
      expect(
        pickTemplateForCategory({
          prevCategory: tshirtCategory,
          newCategory: calendarCategory,
          currentTemplateKey: defaultNonCalKey,
          templates: withAi,
          defaultNonCalendarKey: defaultNonCalKey,
        })
      ).toBe('calendar-review-2clip@@v1');
      // Staying in calendar keeps the compositing template the user picked by hand.
      expect(
        pickTemplateForCategory({
          prevCategory: calendarCategory,
          newCategory: calendarCategory,
          currentTemplateKey: 'calendar-review@@v1',
          templates: withAi,
        })
      ).toBe('calendar-review@@v1');
      // Neither calendar template is offered as the non-calendar default.
      expect(findDefaultNonCalendarTemplate(withAi)?.id).toBe('product-review');
    });

    it('Returns empty string when calendar-review is missing from templates', () => {
      const templatesWithoutCalendar = sampleTemplates.filter((t) => t.id !== 'calendar-review');

      const selected = pickTemplateForCategory({
        prevCategory: tshirtCategory,
        newCategory: calendarCategory,
        currentTemplateKey: defaultNonCalKey,
        templates: templatesWithoutCalendar,
        defaultNonCalendarKey: defaultNonCalKey,
      });

      expect(selected).toBe('');
    });
  });

  describe('aspectWarning threshold (15%)', () => {
    it('returns false when aspect ratios are identical', () => {
      const cover = { width: 1000, height: 1000 }; // AR = 1.0
      const artwork = { width: 1000, height: 1000 }; // AR = 1.0
      expect(aspectWarning(cover, artwork)).toBe(false);
    });

    it('returns false when aspect ratio diff is <= 15%', () => {
      const cover = { width: 1000, height: 1000 }; // AR = 1.0
      // diff = 10%
      const artwork1 = { width: 1100, height: 1000 }; // AR = 1.10 (diff = 0.10)
      expect(aspectWarning(cover, artwork1)).toBe(false);

      // diff = 15% exactly
      const artwork2 = { width: 1150, height: 1000 }; // AR = 1.15 (diff = 0.15)
      expect(aspectWarning(cover, artwork2)).toBe(false);

      // diff = 14%
      const artwork3 = { width: 860, height: 1000 }; // AR = 0.86 (diff = 0.14)
      expect(aspectWarning(cover, artwork3)).toBe(false);
    });

    it('returns true when aspect ratio diff is > 15%', () => {
      const cover = { width: 1000, height: 1000 }; // AR = 1.0
      // diff = 16% > 15%
      const artwork1 = { width: 1160, height: 1000 }; // AR = 1.16
      expect(aspectWarning(cover, artwork1)).toBe(true);

      // diff = 25% > 15%
      const artwork2 = { width: 1250, height: 1000 }; // AR = 1.25
      expect(aspectWarning(cover, artwork2)).toBe(true);

      // diff = 20% > 15% (narrower)
      const artwork3 = { width: 800, height: 1000 }; // AR = 0.80
      expect(aspectWarning(cover, artwork3)).toBe(true);
    });

    it('returns false when cover or artwork is missing or invalid', () => {
      expect(aspectWarning(null, { width: 1000, height: 1000 })).toBe(false);
      expect(aspectWarning({ width: 1000, height: 1000 }, null)).toBe(false);
      expect(aspectWarning({ width: 0, height: 1000 }, { width: 1000, height: 1000 })).toBe(false);
      expect(aspectWarning({ width: 1000, height: 1000 }, { width: 1000, height: 0 })).toBe(false);
    });
  });
});
