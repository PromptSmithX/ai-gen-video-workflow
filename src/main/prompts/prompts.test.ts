import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PodError } from '@shared/errors';
import {
  checkQuality,
  createPromptService,
  parseFrontmatter,
  QUALITY_RULES,
  validatePrompt,
} from './index';

describe('Prompt Master Manager (W2)', () => {
  let tempBaseDir: string;
  let builtinDir: string;
  let adminDir: string;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-test-'));
    builtinDir = path.join(tempBaseDir, 'prompts');
    adminDir = path.join(tempBaseDir, 'admin');

    fs.mkdirSync(path.join(builtinDir, 'master'), { recursive: true });
    fs.mkdirSync(path.join(builtinDir, 'categories'), { recursive: true });
    fs.mkdirSync(adminDir, { recursive: true });

    // Copy repo templates
    const repoPromptsDir = path.resolve(__dirname, '../../../prompts');
    if (fs.existsSync(repoPromptsDir)) {
      fs.cpSync(repoPromptsDir, builtinDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(tempBaseDir)) {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    }
  });

  describe('1. Frontmatter parsing', () => {
    it('parses frontmatter correctly with all fields present', () => {
      const content = `---
id: product-review
version: v2
title: Product Review V2
placeholder: true
created_at: 2026-11-23
note: Test note
default: true
---
Body content here`;

      const result = parseFrontmatter(content);
      expect(result.metadata.id).toBe('product-review');
      expect(result.metadata.version).toBe('v2');
      expect(result.metadata.title).toBe('Product Review V2');
      expect(result.metadata.placeholder).toBe(true);
      expect(result.metadata.createdAt).toBe('2026-11-23');
      expect(result.metadata.note).toBe('Test note');
      expect(result.metadata.default).toBe(true);
      expect(result.body).toBe('Body content here');
    });

    it('assigns sensible defaults when fields are missing', () => {
      const content = `---
title: Minimal Template
---
Just the body`;

      const result = parseFrontmatter(content, {
        defaultId: 'fallback-id',
        defaultVersion: 'v9',
        defaultPlaceholder: false,
      });

      expect(result.metadata.id).toBe('fallback-id');
      expect(result.metadata.version).toBe('v9');
      expect(result.metadata.title).toBe('Minimal Template');
      expect(result.metadata.placeholder).toBe(false);
      expect(result.metadata.createdAt).toBeNull();
      expect(result.metadata.note).toBeNull();
      expect(result.metadata.default).toBe(false);
      expect(result.body).toBe('Just the body');
    });

    it('throws error when opening delimiter exists without closing delimiter', () => {
      const unclosedContent = `---
id: test-id
title: Unclosed
This is missing closing delimiter`;

      expect(() => parseFrontmatter(unclosedContent)).toThrowError(PodError);
      expect(() => parseFrontmatter(unclosedContent)).toThrowError(/unclosed --- delimiter/i);
    });

    it('treats content without frontmatter as raw body with sensible defaults', () => {
      const plainContent = 'Plain prompt body with {{sku}}';
      const result = parseFrontmatter(plainContent, {
        defaultId: 'custom-id',
        defaultVersion: 'v1',
      });
      expect(result.metadata.id).toBe('custom-id');
      expect(result.metadata.version).toBe('v1');
      expect(result.body).toBe(plainContent);
    });
  });

  describe('2. Builtin vs Company vs Admin source loading', () => {
    it('lists builtin v1+v2; default is v2 placeholder; company file overrides default and is not placeholder', () => {
      const companyPath = path.join(tempBaseDir, 'company-master.md');
      fs.writeFileSync(
        companyPath,
        `---
id: product-review
version: v2.1-company
title: Company Approved Prompt Master
note: Officially approved text
---
Company master prompt body for {{sku}}`,
        'utf8',
      );

      // Without company file
      const serviceNoCompany = createPromptService({
        builtinDir,
        adminDir,
        companyMasterPath: null,
      });

      const templates = serviceNoCompany.listTemplates();
      expect(templates.length).toBeGreaterThanOrEqual(2);

      const v1 = templates.find((t) => t.version === 'v1');
      const v2 = templates.find((t) => t.version === 'v2');
      expect(v1).toBeDefined();
      expect(v2).toBeDefined();
      expect(v2?.isPlaceholder).toBe(true);
      expect(v2?.isDefault).toBe(true);
      expect(v1?.isDefault).toBe(false);

      // With company file
      const serviceWithCompany = createPromptService({
        builtinDir,
        adminDir,
        companyMasterPath: companyPath,
      });

      const companyTemplates = serviceWithCompany.listTemplates();
      const companyTmpl = companyTemplates.find((t) => t.source === 'company');
      expect(companyTmpl).toBeDefined();
      expect(companyTmpl?.version).toBe('v2.1-company');
      expect(companyTmpl?.isPlaceholder).toBe(false);
      expect(companyTmpl?.isDefault).toBe(true);

      // Check default template returned by getTemplate without version
      const defaultTmpl = serviceWithCompany.getTemplate('product-review');
      expect(defaultTmpl.source).toBe('company');
      expect(defaultTmpl.version).toBe('v2.1-company');
    });

    it('missing company file → no crash, placeholder remains default with safe warning message', () => {
      const nonExistentPath = path.join(tempBaseDir, 'does-not-exist.md');
      const service = createPromptService({
        builtinDir,
        adminDir,
        companyMasterPath: nonExistentPath,
      });

      expect(service.hasCompanyWarning).toBe(true);
      // Safe warning must not leak absolute path or internal errors
      expect(service.companyFileWarning).toBe('Company Prompt Master file not found');
      expect(service.companyFileWarning).not.toContain(nonExistentPath);

      const defaultTmpl = service.getTemplate('product-review');
      expect(defaultTmpl.isPlaceholder).toBe(true);
      expect(defaultTmpl.version).toBe('v2');
      expect(defaultTmpl.isDefault).toBe(true);
    });

    it('company master version collision: suffixes version to v2-company and company wins as default', () => {
      const companyPath = path.join(tempBaseDir, 'company-v2-colliding.md');
      fs.writeFileSync(
        companyPath,
        `---
id: product-review
version: v2
title: Company Master with Colliding Version
---
Company prompt body text for {{sku}}`,
        'utf8',
      );

      const service = createPromptService({
        builtinDir,
        adminDir,
        companyMasterPath: companyPath,
      });

      const all = service.listTemplates();
      const versions = all.map((t) => t.version);

      // Must have both builtin v2 and suffixed v2-company
      expect(versions).toContain('v2');
      expect(versions).toContain('v2-company');

      // (id, version) is unique
      const v2Templates = all.filter((t) => t.id === 'product-review' && t.version === 'v2');
      expect(v2Templates).toHaveLength(1);
      expect(v2Templates[0]?.source).toBe('builtin');

      const companyTemplate = all.find((t) => t.version === 'v2-company');
      expect(companyTemplate).toBeDefined();
      expect(companyTemplate?.source).toBe('company');

      // Company wins as default
      expect(companyTemplate?.isDefault).toBe(true);
      const defaultTmpl = service.getTemplate('product-review');
      expect(defaultTmpl.version).toBe('v2-company');
      expect(defaultTmpl.source).toBe('company');

      // Explicitly fetching v2 returns the builtin template
      const builtinV2 = service.getTemplate('product-review', 'v2');
      expect(builtinV2.source).toBe('builtin');
    });
  });

  describe('3. Template rendering and placeholder validation', () => {
    it('render replaces all variables; unknown placeholder rejected; unclosed braces rejected', () => {
      const service = createPromptService({ builtinDir, adminDir, companyMasterPath: null });

      // Valid render
      const validRender = service.render({
        templateId: 'product-review',
        templateVersion: 'v2',
        variables: {
          sku: 'TSHIRT-001',
          product_category: 'apparel',
          product_name: 'Classic Vintage Tee',
          review_style: 'casual and enthusiastic',
          duration_seconds: 15,
          aspect_ratio: '16:9',
        },
        categoryGroup: 'apparel',
        maxChars: 4000,
        supportsDuration: true,
        supportsAspectRatio: true,
      });

      expect(validRender.errors).toEqual([]);
      expect(validRender.text).toContain('Product SKU: TSHIRT-001');
      expect(validRender.text).toContain('Category: apparel');
      expect(validRender.text).toContain('Product Name: Classic Vintage Tee');
      expect(validRender.text).toContain('Review Style: casual and enthusiastic');
      expect(validRender.text).toContain('Duration: 15 seconds');
      expect(validRender.text).toContain('Aspect Ratio: 16:9');
      expect(validRender.text).toContain('Category handling notes (Apparel)');

      // Template with unknown placeholder
      const customAdminDir = path.join(adminDir, 'custom-test');
      fs.mkdirSync(customAdminDir, { recursive: true });
      fs.writeFileSync(
        path.join(customAdminDir, 'v1.md'),
        `---
id: custom-test
version: v1
title: Custom Test
---
SKU: {{sku}} with unknown {{hacked_field}}`,
        'utf8',
      );

      const serviceWithCustom = createPromptService({ builtinDir, adminDir, companyMasterPath: null });
      const badRender = serviceWithCustom.render({
        templateId: 'custom-test',
        variables: {
          sku: 'SKU-001',
          product_category: 'other',
        },
        categoryGroup: 'other',
        maxChars: 4000,
        supportsDuration: false,
        supportsAspectRatio: false,
      });

      expect(badRender.errors).toContain('Unknown placeholder: {{hacked_field}}');
      expect(badRender.text).toBe('');

      // Template with unclosed braces
      fs.writeFileSync(
        path.join(customAdminDir, 'v2.md'),
        `---
id: custom-test
version: v2
title: Unclosed
---
SKU: {{sku and no close`,
        'utf8',
      );

      const serviceUnclosed = createPromptService({ builtinDir, adminDir, companyMasterPath: null });
      const unclosedRender = serviceUnclosed.render({
        templateId: 'custom-test',
        templateVersion: 'v2',
        variables: {
          sku: 'SKU-001',
          product_category: 'other',
        },
        categoryGroup: 'other',
        maxChars: 4000,
        supportsDuration: false,
        supportsAspectRatio: false,
      });

      expect(unclosedRender.errors.some((e) => /unclosed placeholder/i.test(e))).toBe(true);
      expect(unclosedRender.text).toBe('');
    });

    it('injection: SKU or product name containing {{sku}} / }}{{x is rendered literally-neutralized, no expansion', () => {
      const service = createPromptService({ builtinDir, adminDir, companyMasterPath: null });

      const renderResult = service.render({
        templateId: 'product-review',
        variables: {
          sku: 'SKU-{{sku}}-PAYLOAD',
          product_category: 'drinkware',
          product_name: 'Mug }}{{unknown_injected_var',
          review_style: 'clean',
        },
        categoryGroup: 'drinkware',
        maxChars: 4000,
        supportsDuration: true,
        supportsAspectRatio: true,
      });

      expect(renderResult.errors).toEqual([]);
      // Ensure recursive expansion of {{sku}} did not happen
      expect(renderResult.text).not.toContain('SKU-SKU-');
      // Ensure unknown injected placeholder did not cause error or evaluate
      expect(renderResult.errors).not.toContain('Unknown placeholder: {{unknown_injected_var}}');
      // Ensure {{ was neutralized so downstream parsers will not interpret it as a token
      expect(renderResult.text).toContain('SKU-{ {sku} }-PAYLOAD');
      expect(renderResult.text).toContain('Mug } }{ {unknown_injected_var');
    });

    it('duration/aspect lines removed when unsupported; kept when supported and provided', () => {
      const service = createPromptService({ builtinDir, adminDir, companyMasterPath: null });

      // Case A: Unsupported by provider
      const unsupported = service.render({
        templateId: 'product-review',
        variables: {
          sku: 'TS-001',
          product_category: 'apparel',
          duration_seconds: 10,
          aspect_ratio: '9:16',
        },
        categoryGroup: 'apparel',
        maxChars: 4000,
        supportsDuration: false,
        supportsAspectRatio: false,
      });

      expect(unsupported.text).not.toContain('Duration:');
      expect(unsupported.text).not.toContain('Aspect Ratio:');

      // Case B: Supported by provider and provided
      const supported = service.render({
        templateId: 'product-review',
        variables: {
          sku: 'TS-001',
          product_category: 'apparel',
          duration_seconds: 12,
          aspect_ratio: '16:9',
        },
        categoryGroup: 'apparel',
        maxChars: 4000,
        supportsDuration: true,
        supportsAspectRatio: true,
      });

      expect(supported.text).toContain('Duration: 12 seconds');
      expect(supported.text).toContain('Aspect Ratio: 16:9');

      // Case C: Supported by provider but value missing from variables
      const missingVals = service.render({
        templateId: 'product-review',
        variables: {
          sku: 'TS-001',
          product_category: 'apparel',
        },
        categoryGroup: 'apparel',
        maxChars: 4000,
        supportsDuration: true,
        supportsAspectRatio: true,
      });

      expect(missingVals.text).not.toContain('Duration:');
      expect(missingVals.text).not.toContain('Aspect Ratio:');
    });

    it('optional vars missing (product_name, review_style) → remove the line containing them', () => {
      const service = createPromptService({ builtinDir, adminDir, companyMasterPath: null });

      const result = service.render({
        templateId: 'product-review',
        variables: {
          sku: 'TS-999',
          product_category: 'home-decor',
        },
        categoryGroup: 'home-decor',
        maxChars: 4000,
        supportsDuration: false,
        supportsAspectRatio: false,
      });

      expect(result.text).not.toContain('Product Name:');
      expect(result.text).not.toContain('Review Style:');
      expect(result.text).toContain('Product SKU: TS-999');
      expect(result.text).toContain('Category: home-decor');
    });

    it('over-length prompt → error, chars reported', () => {
      const service = createPromptService({ builtinDir, adminDir, companyMasterPath: null });

      const result = service.render({
        templateId: 'product-review',
        variables: {
          sku: 'TS-100',
          product_category: 'apparel',
          product_name: 'Very long product name '.repeat(50),
        },
        categoryGroup: 'apparel',
        maxChars: 150,
        supportsDuration: false,
        supportsAspectRatio: false,
      });

      expect(result.chars).toBeGreaterThan(150);
      expect(result.errors.some((e) => e.includes('PROMPT_TOO_LONG') && e.includes(String(result.chars)))).toBe(true);
    });

    it('loadCategorySnippet validates categoryGroup and falls back to other.md on path traversal like ../../secret', () => {
      const service = createPromptService({ builtinDir, adminDir, companyMasterPath: null });

      const result = service.render({
        templateId: 'product-review',
        variables: {
          sku: 'TS-SAFE-01',
          product_category: 'apparel',
        },
        categoryGroup: '../../secret',
        maxChars: 4000,
        supportsDuration: false,
        supportsAspectRatio: false,
      });

      expect(result.errors).toEqual([]);
      // Should safely fall back to other.md
      expect(result.text).toContain('Category handling notes (General)');
    });
  });

  describe('4. Quality checker and employee validation', () => {
    it('all 8 quality rules are defined in the canonical rules table', () => {
      expect(QUALITY_RULES).toHaveLength(8);
      const ruleIds = QUALITY_RULES.map((r) => r.id);
      expect(ruleIds).toContain('preserve_artwork');
      expect(ruleIds).toContain('no_design_changes');
      expect(ruleIds).toContain('consistent_product');
      expect(ruleIds).toContain('natural_texture');
      expect(ruleIds).toContain('physical_continuity');
      expect(ruleIds).toContain('no_impossible_transitions');
      expect(ruleIds).toContain('human_review_action');
      expect(ruleIds).toContain('no_fake_claims');
    });

    it('shipped placeholder v2 and v1 pass all checks', () => {
      const service = createPromptService({ builtinDir, adminDir, companyMasterPath: null });

      const v2 = service.getTemplate('product-review', 'v2');
      const reportV2 = checkQuality(v2.body);
      expect(reportV2.passed).toBe(true);
      for (const check of reportV2.checks) {
        expect(check.passed).toBe(true);
      }

      const v1 = service.getTemplate('product-review', 'v1');
      const reportV1 = checkQuality(v1.body);
      expect(reportV1.passed).toBe(true);
      for (const check of reportV1.checks) {
        expect(check.passed).toBe(true);
      }
    });

    it('a "slow zoom on the image" prompt fails human_review_action and preserve_artwork', () => {
      const promptText = 'A slow zoom on the image of the product.';
      const report = checkQuality(promptText);

      expect(report.passed).toBe(false);

      const humanReview = report.checks.find((c) => c.rule === 'human_review_action');
      const preserveArtwork = report.checks.find((c) => c.rule === 'preserve_artwork');

      expect(humanReview?.passed).toBe(false);
      expect(preserveArtwork?.passed).toBe(false);
    });

    it('fake-claims rule detects missing prohibition', () => {
      const promptWithoutFakeClaims = `
Create a realistic human product review video showcasing the product.
A reviewer presents and examines the product.
1. Preserve artwork: Keep the exact uploaded design and artwork.
2. No design changes: Do not alter or modify the design.
3. Consistent product: Maintain consistent product identity throughout.
4. Natural texture: Ensure natural, non-plastic textures for materials and skin.
5. Physical continuity: Require physically continuous motion and gravity.
6. No impossible transitions: Avoid impossible transitions and teleporting.
7. Human review action: Believable human product review action demonstrating features.
`;

      const report = checkQuality(promptWithoutFakeClaims);
      expect(report.passed).toBe(false);

      const fakeClaimsCheck = report.checks.find((c) => c.rule === 'no_fake_claims');
      expect(fakeClaimsCheck?.passed).toBe(false);

      // Now add the prohibition
      const promptWithFakeClaims = `${promptWithoutFakeClaims}\n8. No fake claims: Do not add fake claims, ratings, or badges.`;
      const reportWith = checkQuality(promptWithFakeClaims);
      const fakeClaimsCheckWith = reportWith.checks.find((c) => c.rule === 'no_fake_claims');
      expect(fakeClaimsCheckWith?.passed).toBe(true);
    });

    it('negation guard rejects negated text for preserve_artwork, natural_texture, and physical_continuity', () => {
      // 1. Negated preserve_artwork
      const negatedArtwork = `
Reviewer presents and examines the product.
Do not preserve the artwork.
Consistent product construction.
Natural, non-plastic textures.
Physical continuity and gravity.
No impossible transitions.
No fake claims.
`;
      const report1 = checkQuality(negatedArtwork);
      const artworkCheck = report1.checks.find((c) => c.rule === 'preserve_artwork');
      expect(artworkCheck?.passed).toBe(false);

      // 2. Negated natural_texture
      const negatedTexture = `
Reviewer presents and examines the product.
Preserve exact artwork and printed graphic.
Do not alter the design.
Consistent product construction.
Never use natural textures for materials.
Physical continuity and gravity.
No impossible transitions.
No fake claims.
`;
      const report2 = checkQuality(negatedTexture);
      const textureCheck = report2.checks.find((c) => c.rule === 'natural_texture');
      expect(textureCheck?.passed).toBe(false);

      // 3. Negated physical_continuity
      const negatedPhysics = `
Reviewer presents and examines the product.
Preserve exact artwork and printed graphic.
Do not alter the design.
Consistent product construction.
Natural, non-plastic textures.
Don't maintain physical continuity or gravity.
No impossible transitions.
No fake claims.
`;
      const report3 = checkQuality(negatedPhysics);
      const physicsCheck = report3.checks.find((c) => c.rule === 'physical_continuity');
      expect(physicsCheck?.passed).toBe(false);
    });

    it('accepts comma-list and "invent" phrasings, and the company T-shirt Master V2 passes all 8 rules', () => {
      const designCheck = checkQuality(
        'Do not redesign, replace, simplify, mirror, duplicate or reinterpret any part of the original printed artwork.'
      ).checks.find((c) => c.rule === 'no_design_changes');
      expect(designCheck?.passed).toBe(true);

      const claimsCheck = checkQuality('Do not invent product claims or spoken descriptions.').checks.find(
        (c) => c.rule === 'no_fake_claims'
      );
      expect(claimsCheck?.passed).toBe(true);

      // The company Prompt Master is kept out of the public repo; check it only where it exists locally.
      const masterPath = path.resolve(__dirname, '../../../prompts/company/tshirt-review-v2.md');
      if (fs.existsSync(masterPath)) {
        const report = checkQuality(fs.readFileSync(masterPath, 'utf8'));
        expect(report.checks.filter((c) => !c.passed).map((c) => c.rule)).toEqual([]);
        expect(report.passed).toBe(true);
      }
    });

    it('validatePrompt detects unresolved template placeholders and validates length and quality', () => {
      const validText = `
Human product review action where the reviewer presents and examines the product.
Preserve exact artwork and printed graphic.
Do not alter or change the artwork.
Consistent product construction throughout.
Ensure natural, non-plastic textures for hands and materials; avoid plastic look.
Physically continuous movement with gravity.
No impossible transitions or teleporting.
No fake claims or ratings.
`;
      const res = validatePrompt(validText, 4000);
      expect(res.quality.passed).toBe(true);
      expect(res.errors).toEqual([]);

      // Override containing unresolved {{sku}} or leftover braces
      const withUnresolved = `${validText}\nSKU identifier: {{sku}}`;
      const resUnresolved = validatePrompt(withUnresolved, 4000);
      expect(resUnresolved.errors).toContain('Prompt contains unresolved template placeholders');

      const withLeftoverBrace = `${validText}\nSome text with unresolved }}`;
      const resLeftover = validatePrompt(withLeftoverBrace, 4000);
      expect(resLeftover.errors).toContain('Prompt contains unresolved template placeholders');

      // Over length
      const overLengthRes = validatePrompt(validText, 50);
      expect(overLengthRes.errors.some((e) => e.includes('PROMPT_TOO_LONG'))).toBe(true);
    });
  });

  describe('5. Admin template versioning and default persistence', () => {
    it('saveTemplateVersion creates v3 without touching v2; second save creates v4; setDefault persists across a new service instance', () => {
      const service = createPromptService({ builtinDir, adminDir, companyMasterPath: null });

      // Builtin v2 is initially default
      const initialDefault = service.getTemplate('product-review');
      expect(initialDefault.version).toBe('v2');

      // First save -> creates v3
      const v3Summary = service.saveTemplateVersion({
        id: 'product-review',
        title: 'Product Review V3 (Admin Revision)',
        note: 'Added custom instructions',
        body: 'Custom body for V3: {{sku}}',
      });

      expect(v3Summary.version).toBe('v3');
      expect(v3Summary.source).toBe('admin');
      expect(v3Summary.isPlaceholder).toBe(false);

      // Verify v2 file is untouched in builtinDir
      const v2Path = path.join(builtinDir, 'master', 'product-review-v2.md');
      const v2Content = fs.readFileSync(v2Path, 'utf8');
      expect(v2Content).toContain('id: product-review');
      expect(v2Content).toContain('version: v2');

      // Verify v3 was written in adminDir
      const v3Path = path.join(adminDir, 'product-review', 'v3.md');
      expect(fs.existsSync(v3Path)).toBe(true);
      const v3Content = fs.readFileSync(v3Path, 'utf8');
      expect(v3Content).toContain('version: v3');
      expect(v3Content).toContain('Custom body for V3: {{sku}}');

      // Second save -> creates v4
      const v4Summary = service.saveTemplateVersion({
        id: 'product-review',
        title: 'Product Review V4 (Admin Revision 2)',
        note: 'Refined instructions',
        body: 'Custom body for V4: {{sku}} and {{product_category}}',
      });

      expect(v4Summary.version).toBe('v4');
      const v4Path = path.join(adminDir, 'product-review', 'v4.md');
      expect(fs.existsSync(v4Path)).toBe(true);

      // Set default to v3
      service.setDefault('product-review', 'v3');
      const currentDefault = service.getTemplate('product-review');
      expect(currentDefault.version).toBe('v3');

      // Verify default persists across a new service instance
      const newService = createPromptService({ builtinDir, adminDir, companyMasterPath: null });
      const newDefault = newService.getTemplate('product-review');
      expect(newDefault.version).toBe('v3');
      expect(newDefault.source).toBe('admin');

      // Rollback to v2
      newService.setDefault('product-review', 'v2');
      const rolledBackDefault = newService.getTemplate('product-review');
      expect(rolledBackDefault.version).toBe('v2');
      expect(rolledBackDefault.source).toBe('builtin');

      // Verify rollback persists across yet another service instance
      const thirdService = createPromptService({ builtinDir, adminDir, companyMasterPath: null });
      expect(thirdService.getTemplate('product-review').version).toBe('v2');
    });

    it('throws TEMPLATE_NOT_FOUND when requesting non-existent template or version', () => {
      const service = createPromptService({ builtinDir, adminDir, companyMasterPath: null });
      expect(() => service.getTemplate('non-existent-id')).toThrowError(PodError);
      expect(() => service.getTemplate('product-review', 'v999')).toThrowError(PodError);
      expect(() => service.setDefault('product-review', 'v999')).toThrowError(PodError);
    });
  });
});
