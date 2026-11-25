import { PROMPT_VARIABLES, type PromptVariables, type RenderedPrompt } from '@shared/prompt';
import { checkQuality } from './quality';

export interface RenderPromptOptions {
  templateId: string;
  templateVersion: string;
  templateBody: string;
  isPlaceholder: boolean;
  variables: PromptVariables;
  categorySnippet?: string;
  maxChars: number;
  supportsDuration: boolean;
  supportsAspectRatio: boolean;
}

/**
 * Extracts the base name from a file path regardless of Windows or POSIX separator.
 */
function extractBaseName(filePath: string): string {
  const parts = filePath.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : filePath;
}

/**
 * Strips non-printable control characters (preserving tab, newline, carriage return).
 */
function stripControlChars(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // Allow tab (9), line feed (10), carriage return (13). Strip other control chars < 32 and DEL (127).
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      continue;
    }
    result += value[i];
  }
  return result;
}

/**
 * Sanitizes variable values: strips control chars, collapses newlines in single-line
 * values, and neutralizes {{ / }} so values can never inject template syntax.
 */
function sanitizeValue(value: unknown, isSingleLine = true): string {
  if (value === undefined || value === null) {
    return '';
  }
  let str = String(value);
  str = stripControlChars(str);
  if (isSingleLine) {
    str = str.replace(/[\r\n]+/g, ' ').trim();
  }
  // Neutralize any {{ and }} to prevent template injection
  str = str.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');
  return str;
}

/**
 * Checks template syntax for unclosed {{ or unknown placeholder names.
 */
function checkTemplateSyntax(template: string): { errors: string[]; placeholders: string[] } {
  const errors: string[] = [];
  const placeholders: string[] = [];

  const placeholderRegex = /\{\{([^{}]*?)\}\}/g;
  let match: RegExpExecArray | null;
  const matchedRanges: [number, number][] = [];

  while ((match = placeholderRegex.exec(template)) !== null) {
    const rawContent = match[1] ?? '';
    const name = rawContent.trim();
    matchedRanges.push([match.index, match.index + match[0].length]);

    if (!name) {
      errors.push('Unknown placeholder: {{}}');
      continue;
    }
    placeholders.push(name);
    const isAllowed = (PROMPT_VARIABLES as readonly string[]).includes(name) || name === 'category_rules';
    if (!isAllowed) {
      errors.push(`Unknown placeholder: {{${name}}}`);
    }
  }

  // Check for any unclosed '{{' outside matched ranges
  for (let i = 0; i < template.length - 1; i++) {
    if (template[i] === '{' && template[i + 1] === '{') {
      const isInside = matchedRanges.some(([start, end]) => i >= start && i < end);
      if (!isInside) {
        errors.push('Unclosed placeholder: missing closing }}');
        break;
      }
    }
  }

  return { errors, placeholders };
}

/**
 * Renders a prompt template with provided variables, category snippet, and provider constraints.
 */
export function renderPrompt(opts: RenderPromptOptions): RenderedPrompt {
  const {
    templateId,
    templateVersion,
    templateBody,
    isPlaceholder,
    variables,
    categorySnippet,
    maxChars,
    supportsDuration,
    supportsAspectRatio,
  } = opts;

  // 1. Validate template syntax
  const { errors: syntaxErrors } = checkTemplateSyntax(templateBody);
  if (syntaxErrors.length > 0) {
    return {
      text: '',
      chars: 0,
      maxChars,
      templateId,
      templateVersion,
      isPlaceholder,
      quality: { passed: false, checks: [] },
      errors: syntaxErrors,
    };
  }

  const errors: string[] = [];

  // 2. Validate required variables
  if (!variables.sku || variables.sku.trim() === '') {
    errors.push('Missing required variable: sku');
  }
  if (!variables.product_category || variables.product_category.trim() === '') {
    errors.push('Missing required variable: product_category');
  }

  // 3. Handle category snippet insertion
  let currentText = templateBody;
  const hasCategorySlot = /\{\{\s*category_rules\s*\}\}/.test(currentText);
  if (hasCategorySlot) {
    currentText = currentText.replace(/\{\{\s*category_rules\s*\}\}/g, categorySnippet?.trim() ?? '');
  } else if (categorySnippet && categorySnippet.trim().length > 0) {
    currentText = `${currentText.trim()}\n\n${categorySnippet.trim()}`;
  }

  // 4. Line-based conditional removal
  const lines = currentText.split(/\r?\n/);
  const filteredLines: string[] = [];

  for (const line of lines) {
    // duration_seconds line
    if (/\{\{\s*duration_seconds\s*\}\}/.test(line)) {
      if (!supportsDuration || variables.duration_seconds === undefined || variables.duration_seconds === null) {
        continue;
      }
    }

    // aspect_ratio line
    if (/\{\{\s*aspect_ratio\s*\}\}/.test(line)) {
      if (!supportsAspectRatio || !variables.aspect_ratio || variables.aspect_ratio.trim() === '') {
        continue;
      }
    }

    // optional product_name line
    if (/\{\{\s*product_name\s*\}\}/.test(line)) {
      if (!variables.product_name || variables.product_name.trim() === '') {
        continue;
      }
    }

    // optional review_style line
    if (/\{\{\s*review_style\s*\}\}/.test(line)) {
      if (!variables.review_style || variables.review_style.trim() === '') {
        continue;
      }
    }

    // optional source_image_filename line
    if (/\{\{\s*source_image_filename\s*\}\}/.test(line)) {
      if (!variables.source_image_filename || variables.source_image_filename.trim() === '') {
        continue;
      }
    }

    filteredLines.push(line);
  }

  currentText = filteredLines.join('\n');

  // 5. Sanitize variables and perform single-pass substitution
  const sanitizedValues: Record<string, string> = {
    sku: sanitizeValue(variables.sku),
    product_category: sanitizeValue(variables.product_category),
    product_name: sanitizeValue(variables.product_name),
    source_image_filename: variables.source_image_filename
      ? sanitizeValue(extractBaseName(variables.source_image_filename))
      : '',
    duration_seconds:
      variables.duration_seconds !== undefined && variables.duration_seconds !== null
        ? sanitizeValue(variables.duration_seconds)
        : '',
    aspect_ratio: sanitizeValue(variables.aspect_ratio),
    review_style: sanitizeValue(variables.review_style),
  };

  currentText = currentText.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, name) => {
    return sanitizedValues[name] ?? '';
  });

  // Normalize multiple consecutive blank lines
  currentText = currentText.replace(/\n{3,}/g, '\n\n').trim();

  // 6. Character limit check
  const chars = currentText.length;
  if (chars > maxChars) {
    errors.push(`PROMPT_TOO_LONG: prompt length ${chars} exceeds maximum of ${maxChars} characters`);
  }

  // 7. Quality check
  const quality = checkQuality(currentText);

  return {
    text: currentText,
    chars,
    maxChars,
    templateId,
    templateVersion,
    isPlaceholder,
    quality,
    errors,
  };
}
