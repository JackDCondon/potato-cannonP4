export interface RetryableMatch {
  retryable: boolean;
  retryAt: string | null;
  patternName: string;
}

interface RetryablePattern {
  name: string;
  test: RegExp;
  extractRetryTime?: (reason: string) => string | null;
}

/**
 * Hardcoded for initial scope — credits exhaustion is the only known retryable
 * pattern. When a second pattern is needed, extract to global config.
 */
const RETRYABLE_PATTERNS: RetryablePattern[] = [
  {
    name: "credits-exhausted",
    test: /hit your limit|rate limit reached|credits? (exhausted|exceeded)/i,
    extractRetryTime: (reason: string): string | null => {
      // Match "Resets at <datetime>" — handles locale strings and ISO 8601
      const match = reason.match(/resets at (.+?)\.?\s*$/im);
      if (!match) return null;
      const parsed = new Date(match[1].trim());
      if (isNaN(parsed.getTime())) return null;
      // Add 5-minute buffer
      return new Date(parsed.getTime() + 5 * 60 * 1000).toISOString();
    },
  },
];

export function matchRetryableError(reason: string): RetryableMatch {
  for (const pattern of RETRYABLE_PATTERNS) {
    if (pattern.test.test(reason)) {
      const retryAt = pattern.extractRetryTime
        ? pattern.extractRetryTime(reason)
        : null;
      return { retryable: true, retryAt, patternName: pattern.name };
    }
  }
  return { retryable: false, retryAt: null, patternName: "none" };
}
