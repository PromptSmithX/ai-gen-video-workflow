/**
 * Polling helper for orchestrator status polling.
 * Computes next delay using bounded exponential backoff with jitter.
 */
export function nextPollDelay(
  attempt: number,
  baseMs = 2000,
  maxMs = 30000,
  random: () => number = Math.random
): number {
  if (baseMs <= 0 || maxMs <= 0) return 0;
  const clampedAttempt = Math.max(0, Math.floor(attempt));
  const exp = Math.min(maxMs, baseMs * Math.pow(2, clampedAttempt));
  // Jitter is strictly bounded to prevent exceeding maxMs and preserve monotonic progression
  const jitterRange = Math.min(exp * 0.1, maxMs - exp > 0 ? maxMs - exp : 0);
  const jitter = jitterRange > 0 ? random() * jitterRange : 0;
  return Math.min(maxMs, Math.round(exp + jitter));
}
