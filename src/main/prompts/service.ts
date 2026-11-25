import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PodError } from '@shared/errors';
import type { PromptTemplate, PromptTemplateSummary } from '@shared/prompt';
import type { PromptService, RenderArgs } from '@shared/services';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { validatePrompt } from './quality';
import { renderPrompt } from './renderer';

export interface CreatePromptServiceOptions {
  builtinDir: string;
  adminDir: string;
  companyMasterPath?: string | null;
}

export interface PromptServiceInstance extends PromptService {
  readonly companyFileWarning?: string | null;
  readonly hasCompanyWarning: boolean;
}

type StoredTemplate = PromptTemplate;

function loadDefaultSelections(adminDir: string): Record<string, string> {
  const defaultPath = path.join(adminDir, 'default.json');
  try {
    if (fs.existsSync(defaultPath)) {
      const raw = fs.readFileSync(defaultPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, string>;
      }
    }
  } catch {
    // Ignore unreadable or corrupt default.json
  }
  return {};
}

function persistDefaultSelection(adminDir: string, id: string, version: string): void {
  fs.mkdirSync(adminDir, { recursive: true });
  const defaultPath = path.join(adminDir, 'default.json');
  const defaults = loadDefaultSelections(adminDir);
  defaults[id] = version;
  fs.writeFileSync(defaultPath, JSON.stringify(defaults, null, 2), 'utf8');
}

/**
 * Creates the PromptService manager for loading, rendering, versioning,
 * and validating prompt templates.
 */
export function createPromptService(opts: CreatePromptServiceOptions): PromptServiceInstance {
  const { builtinDir, adminDir, companyMasterPath } = opts;
  const templates: StoredTemplate[] = [];
  let companyFileWarning: string | null = null;

  // 1. Load built-in templates from <builtinDir>/master/*.md or <builtinDir>/*.md
  const masterDir = path.join(builtinDir, 'master');
  const dirToScan = fs.existsSync(masterDir) ? masterDir : builtinDir;

  if (fs.existsSync(dirToScan)) {
    const files = fs.readdirSync(dirToScan);
    for (const file of files) {
      if (!file.endsWith('.md')) {
        continue;
      }
      const fullPath = path.join(dirToScan, file);
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const defaultVersion = file.replace(/\.md$/, '').split('-').pop() ?? 'v1';
        const parsed = parseFrontmatter(content, {
          defaultId: 'product-review',
          defaultVersion,
          defaultPlaceholder: true,
        });

        templates.push({
          id: parsed.metadata.id,
          version: parsed.metadata.version,
          title: parsed.metadata.title,
          isPlaceholder: true,
          source: 'builtin',
          isDefault: parsed.metadata.default,
          createdAt: parsed.metadata.createdAt,
          note: parsed.metadata.note,
          body: parsed.body,
        });
      } catch {
        // Skip unparseable builtin files
      }
    }
  }

  // 2. Load company master if specified
  let companyLoaded = false;
  if (companyMasterPath && companyMasterPath.trim() !== '') {
    try {
      if (fs.existsSync(companyMasterPath)) {
        const content = fs.readFileSync(companyMasterPath, 'utf8');
        const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
        const parsed = parseFrontmatter(content, {
          defaultId: 'product-review',
          defaultVersion: `company-${hash}`,
          defaultPlaceholder: false,
        });

        const targetId = parsed.metadata.id || 'product-review';
        let targetVersion = parsed.metadata.version || `company-${hash}`;

        // Ensure (id, version) is unique across sources; suffix with -company on collision
        if (templates.some((t) => t.id === targetId && t.version === targetVersion)) {
          targetVersion = `${targetVersion}-company`;
        }

        templates.push({
          id: targetId,
          version: targetVersion,
          title: parsed.metadata.title || 'Company Product Review',
          isPlaceholder: false,
          source: 'company',
          isDefault: true,
          createdAt: parsed.metadata.createdAt,
          note: parsed.metadata.note,
          body: parsed.body,
        });
        companyLoaded = true;
      } else {
        // Safe fixed string (no path, no sensitive info)
        companyFileWarning = 'Company Prompt Master file not found';
      }
    } catch {
      // Safe fixed string (no raw error message, no sensitive info)
      companyFileWarning = 'Company Prompt Master file could not be read';
    }
  }

  // 3. Load admin templates from <adminDir>/<id>/*.md
  if (fs.existsSync(adminDir)) {
    try {
      const entries = fs.readdirSync(adminDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const templateId = entry.name;
        const subDir = path.join(adminDir, templateId);
        const mdFiles = fs.readdirSync(subDir);
        for (const mdFile of mdFiles) {
          if (!mdFile.endsWith('.md')) {
            continue;
          }
          const fullPath = path.join(subDir, mdFile);
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const defaultVer = mdFile.replace(/\.md$/, '');
            const parsed = parseFrontmatter(content, {
              defaultId: templateId,
              defaultVersion: defaultVer,
              defaultPlaceholder: false,
            });

            let adminVersion = parsed.metadata.version;
            if (templates.some((t) => t.id === parsed.metadata.id && t.version === adminVersion)) {
              adminVersion = `${adminVersion}-admin`;
            }

            templates.push({
              id: parsed.metadata.id,
              version: adminVersion,
              title: parsed.metadata.title,
              isPlaceholder: false,
              source: 'admin',
              isDefault: false,
              createdAt: parsed.metadata.createdAt,
              note: parsed.metadata.note,
              body: parsed.body,
            });
          } catch {
            // Skip unparseable admin file
          }
        }
      }
    } catch {
      // Admin dir scan failure
    }
  }

  // 4. Resolve default versions
  const defaultSelections = loadDefaultSelections(adminDir);
  const templateIds = Array.from(new Set(templates.map((t) => t.id)));

  for (const id of templateIds) {
    const matching = templates.filter((t) => t.id === id);
    const persistedDefaultVer = defaultSelections[id];

    if (persistedDefaultVer && matching.some((t) => t.version === persistedDefaultVer)) {
      for (const t of matching) {
        t.isDefault = t.version === persistedDefaultVer;
      }
    } else if (companyLoaded && matching.some((t) => t.source === 'company')) {
      // Company template wins as default
      for (const t of matching) {
        t.isDefault = t.source === 'company';
      }
    } else if (id === 'calendar-review') {
      // Only for calendar-review without a persisted admin default:
      // isDefault only if explicitly marked in frontmatter (builtin v1 has default: false -> not default)
      const explicitDefault = matching.find((t) => t.isDefault);
      for (const t of matching) {
        t.isDefault = explicitDefault ? t.version === explicitDefault.version : false;
      }
    } else {
      // Pick builtin template marked default, or v2, or latest version
      const explicitDefault = matching.find((t) => t.isDefault);
      const v2Default = matching.find((t) => t.version === 'v2');
      const targetDefault = explicitDefault ?? v2Default ?? matching[matching.length - 1];

      for (const t of matching) {
        t.isDefault = targetDefault ? t.version === targetDefault.version : false;
      }
    }
  }

  // Helper to load category snippet with path traversal defense
  function loadCategorySnippet(group: string): string | undefined {
    const safeGroupPattern = /^[a-z0-9-]{1,64}$/;
    const normalizedGroup = group.toLowerCase().replace(/\.md$/, '');
    const isValid = safeGroupPattern.test(normalizedGroup);

    const candidates: string[] = [];
    if (isValid) {
      candidates.push(
        path.join(builtinDir, 'categories', `${normalizedGroup}.md`),
        path.join(builtinDir, 'categories', 'other.md'),
      );
    } else {
      // Invalid group name (e.g. traversal attempt like '../../secret') -> immediately fall back to other.md
      candidates.push(path.join(builtinDir, 'categories', 'other.md'));
    }

    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        try {
          return fs.readFileSync(cand, 'utf8');
        } catch {
          // Ignore
        }
      }
    }
    return undefined;
  }

  return {
    get companyFileWarning() {
      return companyFileWarning;
    },
    get hasCompanyWarning() {
      return companyFileWarning !== null;
    },

    listTemplates(): PromptTemplateSummary[] {
      // Return summaries sorted by id, then by version
      return templates
        .map((t) => ({
          id: t.id,
          version: t.version,
          title: t.title,
          isPlaceholder: t.isPlaceholder,
          source: t.source,
          isDefault: t.isDefault,
          createdAt: t.createdAt,
          note: t.note,
        }))
        .sort((a, b) => {
          if (a.id !== b.id) {
            return a.id.localeCompare(b.id);
          }
          return a.version.localeCompare(b.version, undefined, { numeric: true });
        });
    },

    getTemplate(id: string, version?: string): PromptTemplate {
      let target: StoredTemplate | undefined;
      if (version) {
        target = templates.find((t) => t.id === id && t.version === version);
      } else {
        // Resolve to admin/company version if one exists, otherwise builtin v1 / default
        target =
          templates.find((t) => t.id === id && t.isDefault) ??
          templates.filter((t) => t.id === id && (t.source === 'admin' || t.source === 'company')).pop() ??
          templates.find((t) => t.id === id);
      }

      if (!target) {
        throw new PodError('TEMPLATE_NOT_FOUND', `Template "${id}" (version: ${version ?? 'default'}) was not found`);
      }

      return {
        id: target.id,
        version: target.version,
        title: target.title,
        isPlaceholder: target.isPlaceholder,
        source: target.source,
        isDefault: target.isDefault,
        createdAt: target.createdAt,
        note: target.note,
        body: target.body,
      };
    },

    render(args: RenderArgs) {
      const template = this.getTemplate(args.templateId, args.templateVersion);
      const categorySnippet = loadCategorySnippet(args.categoryGroup);

      return renderPrompt({
        templateId: template.id,
        templateVersion: template.version,
        templateBody: template.body,
        isPlaceholder: template.isPlaceholder,
        variables: args.variables,
        categorySnippet,
        maxChars: args.maxChars,
        supportsDuration: args.supportsDuration,
        supportsAspectRatio: args.supportsAspectRatio,
      });
    },

    validatePrompt(text: string, maxChars: number) {
      return validatePrompt(text, maxChars);
    },

    saveTemplateVersion(args: { id: string; title?: string; body: string; note?: string }): PromptTemplateSummary {
      const matching = templates.filter((t) => t.id === args.id);

      // Determine next version number v<N+1>
      let maxN = 0;
      for (const t of matching) {
        const m = /^v(\d+)$/.exec(t.version);
        if (m && m[1]) {
          const num = parseInt(m[1], 10);
          if (num > maxN) {
            maxN = num;
          }
        }
      }
      let nextVersion = `v${maxN + 1}`;
      while (matching.some((t) => t.version === nextVersion)) {
        maxN++;
        nextVersion = `v${maxN + 1}`;
      }

      const title = args.title ?? (matching[0]?.title ?? args.id);
      const createdAt = new Date().toISOString().split('T')[0] ?? null;

      const serialized = serializeFrontmatter(
        {
          id: args.id,
          version: nextVersion,
          title,
          placeholder: false,
          createdAt,
          note: args.note ?? null,
          default: false,
        },
        args.body,
      );

      const targetDir = path.join(adminDir, args.id);
      fs.mkdirSync(targetDir, { recursive: true });
      const targetPath = path.join(targetDir, `${nextVersion}.md`);

      // Write with wx flag so we never overwrite an existing file
      fs.writeFileSync(targetPath, serialized, { flag: 'wx', encoding: 'utf8' });

      const newTemplate: StoredTemplate = {
        id: args.id,
        version: nextVersion,
        title,
        isPlaceholder: false,
        source: 'admin',
        isDefault: false,
        createdAt,
        note: args.note ?? null,
        body: args.body,
      };

      templates.push(newTemplate);

      return {
        id: newTemplate.id,
        version: newTemplate.version,
        title: newTemplate.title,
        isPlaceholder: newTemplate.isPlaceholder,
        source: newTemplate.source,
        isDefault: newTemplate.isDefault,
        createdAt: newTemplate.createdAt,
        note: newTemplate.note,
      };
    },

    setDefault(id: string, version: string): void {
      const target = templates.find((t) => t.id === id && t.version === version);
      if (!target) {
        throw new PodError('TEMPLATE_NOT_FOUND', `Cannot set default: template "${id}" version "${version}" not found`);
      }

      for (const t of templates) {
        if (t.id === id) {
          t.isDefault = t.version === version;
        }
      }

      persistDefaultSelection(adminDir, id, version);
    },
  };
}
