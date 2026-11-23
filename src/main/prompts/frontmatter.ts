import { PodError } from '@shared/errors';

export interface ParsedFrontmatter {
  id: string;
  version: string;
  title: string;
  placeholder: boolean;
  createdAt: string | null;
  note: string | null;
  default: boolean;
}

export interface ParseResult {
  metadata: ParsedFrontmatter;
  body: string;
}

export interface FrontmatterDefaults {
  defaultId?: string;
  defaultVersion?: string;
  defaultPlaceholder?: boolean;
}

/**
 * Parses YAML-like frontmatter enclosed by `---` markers.
 * Simple key-value parser with no external dependencies.
 */
export function parseFrontmatter(content: string, defaults?: FrontmatterDefaults): ParseResult {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith('---')) {
    const id = defaults?.defaultId ?? 'product-review';
    return {
      metadata: {
        id,
        version: defaults?.defaultVersion ?? 'v1',
        title: id,
        placeholder: defaults?.defaultPlaceholder ?? false,
        createdAt: null,
        note: null,
        default: false,
      },
      body: content.trim(),
    };
  }

  // Find closing `---` after the opening line
  const afterFirst = trimmed.slice(3);
  const closingMatch = /(?:^|\r?\n)---\s*(?:\r?\n|$)/.exec(afterFirst);

  if (!closingMatch) {
    throw new PodError('INVALID_PROMPT', 'Invalid template frontmatter: unclosed --- delimiter');
  }

  const frontmatterBlock = afterFirst.slice(0, closingMatch.index);
  const body = afterFirst.slice(closingMatch.index + closingMatch[0].length).trim();

  const raw: Record<string, string> = {};
  const lines = frontmatterBlock.split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }
    const colonIdx = trimmedLine.indexOf(':');
    if (colonIdx === -1) {
      continue;
    }
    const key = trimmedLine.slice(0, colonIdx).trim().toLowerCase();
    let val = trimmedLine.slice(colonIdx + 1).trim();

    // Strip wrapping quotes
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1).trim();
    }
    raw[key] = val;
  }

  const id = raw['id'] || defaults?.defaultId || 'product-review';
  const version = raw['version'] || defaults?.defaultVersion || 'v1';
  const title = raw['title'] || id;

  let placeholder = defaults?.defaultPlaceholder ?? true;
  if (raw['placeholder'] !== undefined) {
    placeholder = raw['placeholder'].toLowerCase() === 'true';
  }

  let isDefault = false;
  if (raw['default'] !== undefined) {
    isDefault = raw['default'].toLowerCase() === 'true';
  }

  const createdAt = raw['created_at'] || raw['createdat'] || null;
  const note = raw['note'] || null;

  return {
    metadata: {
      id,
      version,
      title,
      placeholder,
      createdAt,
      note,
      default: isDefault,
    },
    body,
  };
}

/**
 * Serializes frontmatter metadata and body into a markdown string.
 */
export function serializeFrontmatter(
  metadata: {
    id: string;
    version: string;
    title?: string;
    placeholder?: boolean;
    createdAt?: string | null;
    note?: string | null;
    default?: boolean;
  },
  body: string,
): string {
  const lines: string[] = ['---'];
  lines.push(`id: ${metadata.id}`);
  lines.push(`version: ${metadata.version}`);
  lines.push(`title: ${metadata.title ?? metadata.id}`);
  lines.push(`placeholder: ${metadata.placeholder ? 'true' : 'false'}`);
  if (metadata.createdAt) {
    lines.push(`created_at: ${metadata.createdAt}`);
  }
  if (metadata.note) {
    lines.push(`note: ${metadata.note}`);
  }
  if (metadata.default !== undefined) {
    lines.push(`default: ${metadata.default ? 'true' : 'false'}`);
  }
  lines.push('---');
  lines.push('');
  lines.push(body.trim());
  lines.push('');
  return lines.join('\n');
}
