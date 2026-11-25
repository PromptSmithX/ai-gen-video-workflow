import type { QualityCheck, QualityReport, QualityRuleId } from '@shared/prompt';

export interface QualityRuleDef {
  id: QualityRuleId;
  label: string;
  description: string;
  /** Patterns representing accepted phrasings. If any pattern matches, the check passes. */
  patterns: RegExp[];
  /** When true, matches preceded by negation words (not, never, don't) are rejected. */
  guardNegation?: boolean;
}

/**
 * Canonical rule definitions for prompt quality checks.
 * Admins can inspect these rule definitions and accepted phrasings.
 */
export const QUALITY_RULES: readonly QualityRuleDef[] = [
  {
    id: 'preserve_artwork',
    label: 'Preserve exact artwork and print design',
    description: 'Requires preserving the exact uploaded design, artwork, or print without redesign.',
    guardNegation: true,
    patterns: [
      /(?:preserve|keep|maintain|retaining|retain)\s+.*?(?:artwork|design|print|graphic)/i,
      /(?:exact|original|uploaded)\s+.*?(?:artwork|design|print|graphic)/i,
      /preserve\s+(?:the\s+)?artwork/i,
    ],
  },
  {
    id: 'no_design_changes',
    label: 'Prohibit artwork and design modifications',
    description: 'Prohibits altering, modifying, recoloring, repositioning, distorting, mirroring, or replacing artwork.',
    patterns: [
      /(?:do not|never|no|prohibit|avoid)\s+.*?(?:alter|modify|recolor|reposition|distort|mirror|replace|redesign|change)\s+.*?(?:artwork|design|print|graphic)/i,
      /(?:no|prohibit)\s+design\s+changes/i,
      /(?:without|do not allow)\s+(?:altering|modifying|changing)\s+.*?(?:design|artwork|print)/i,
      // Comma-separated verb lists: "Do not redesign, replace, simplify, mirror, … the original printed artwork"
      /(?:do not|never)\s+(?:alter|modify|recolor|reposition|distort|mirror|replace|redesign|change|reinterpret|simplify|duplicate)\b[^.\n]*?(?:artwork|design|print|graphic)/i,
    ],
  },
  {
    id: 'consistent_product',
    label: 'Maintain consistent product identity and construction',
    description: 'Requires maintaining consistent product identity, garment construction, and appearance throughout the video.',
    patterns: [
      /(?:consistent|maintain|preserve)\s+.*?(?:product\s+identity|garment\s+construction|product\s+construction|appearance\s+throughout)/i,
      /consistent\s+(?:product|garment|construction)/i,
      /product\s+identity\s+.*?(?:consistent|maintained)/i,
    ],
  },
  {
    id: 'natural_texture',
    label: 'Natural material, skin, and hand textures',
    description: 'Ensures natural, non-plastic appearance for fabric, hands, skin, and materials.',
    guardNegation: true,
    patterns: [
      /(?:natural|realistic)\s+.*?(?:texture|material|skin|hands|fabric)/i,
      /non-plastic/i,
      /natural\s+textures?/i,
    ],
  },
  {
    id: 'physical_continuity',
    label: 'Physical continuity and realistic physics',
    description: 'Requires physically continuous motion, realistic gravity, folds, and object permanence.',
    guardNegation: true,
    patterns: [
      /(?:physically|physical)\s+continuous/i,
      /(?:continuous\s+(?:motion|movement)|object\s+permanence|realistic\s+gravity)/i,
      /physical\s+continuity/i,
    ],
  },
  {
    id: 'no_impossible_transitions',
    label: 'Avoid impossible transitions and morphing',
    description: 'Prohibits impossible transitions, sudden object morphing, teleporting, or hands passing through objects.',
    patterns: [
      /(?:no|avoid|prohibit|prevent)\s+.*?(?:impossible\s+transitions|teleport|sudden\s+morphing|pass\s+through)/i,
      /no\s+impossible\s+transitions/i,
      /avoid\s+impossible\s+transitions/i,
    ],
  },
  {
    id: 'human_review_action',
    label: 'Authentic human product review action',
    description: 'Requires an authentic human product review interaction presenting features rather than a static zoom or pan.',
    patterns: [
      /(?:human\s+)?product\s+review(?:\s+action)?/i,
      /reviewer\s+(?:presents|examines|demonstrates|interacts|holds)/i,
      /(?:presents?\s+and\s+examines?|showcases?\s+the\s+product|demonstrating\s+its\s+features)/i,
      /human\s+review\s+action/i,
    ],
  },
  {
    id: 'no_fake_claims',
    label: 'Prohibit fake claims, ratings, and badges',
    description: 'Prohibits adding fake ratings, unauthorized discounts, fabricated testimonials, or platform badges.',
    patterns: [
      /(?:no|do not|never|prohibit|avoid)\s+.*?(?:fake|unauthorized|fabricated)\s+.*?(?:claim|rating|discount|testimonial|badge)/i,
      /(?:no|prohibit)\s+fake\s+claims/i,
      /do\s+not\s+add\s+fake/i,
      // "Do not invent product claims" — invented claims are fabricated claims
      /(?:do not|never)\s+(?:invent|fabricate|make up)\s+[^.\n]*?(?:claims?|ratings?|testimonials?|badges?)/i,
    ],
  },
];

/**
 * Checks whether a regex match is preceded by negation words in the preceding ~3 words.
 */
function isMatchNegated(text: string, matchIndex: number): boolean {
  const sliceStart = Math.max(0, matchIndex - 50);
  const precedingText = text.slice(sliceStart, matchIndex);
  const words = precedingText.trim().split(/\s+/);
  const last3Words = words.slice(-3).join(' ');
  return /\b(not|never|don't|dont|no)\b/i.test(last3Words);
}

/**
 * Tests if a pattern matches within text, rejecting negated matches when guardNegation is active.
 */
function matchPattern(pattern: RegExp, text: string, guardNegation?: boolean): boolean {
  if (!guardNegation) {
    return pattern.test(text);
  }

  // Iterate over matches to find at least one non-negated match
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const globalRegex = new RegExp(pattern.source, flags);
  let match: RegExpExecArray | null;

  while ((match = globalRegex.exec(text)) !== null) {
    if (!isMatchNegated(text, match.index)) {
      return true;
    }
  }

  return false;
}

/**
 * Runs all quality checks against the given prompt text.
 */
export function checkQuality(text: string): QualityReport {
  const checks: QualityCheck[] = QUALITY_RULES.map((rule) => {
    const passed = rule.patterns.some((pattern) => matchPattern(pattern, text, rule.guardNegation));
    return {
      rule: rule.id,
      label: rule.label,
      passed,
    };
  });

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

/**
 * Validates an employee-edited prompt override against quality rules, character limits,
 * and unresolved template placeholders.
 */
export function validatePrompt(
  text: string,
  maxChars: number,
): { quality: QualityReport; errors: string[] } {
  const errors: string[] = [];
  const quality = checkQuality(text);

  if (!text || text.trim().length === 0) {
    errors.push('Prompt text cannot be empty');
  }

  // Check for unresolved template placeholders (e.g. {{sku}}, {{product_name}}, or leftover braces)
  if (text.includes('{{') || text.includes('}}')) {
    errors.push('Prompt contains unresolved template placeholders');
  }

  if (text.length > maxChars) {
    errors.push(`PROMPT_TOO_LONG: prompt length ${text.length} exceeds maximum of ${maxChars} characters`);
  }

  return {
    quality,
    errors,
  };
}
