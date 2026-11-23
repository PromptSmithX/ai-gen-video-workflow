import { writeFileSync } from 'node:fs';
import os from 'node:os';
import type { AppConfig } from '@shared/config';
import { redactText } from '../logging/redact';

export interface DiagnosticsInput {
  appVersion: string;
  config: AppConfig;
  providerStatus: unknown;
  recentLogLines: string[];
  jobCounts: Record<string, number>;
  hasApiKey?: boolean;
}

/**
 * Builds a human-readable diagnostics report for admin review.
 * All URLs are host-only, secret keys are never included (only a hasApiKey boolean is shown),
 * and the entire report is processed through redactText so no prompt text, image bytes,
 * or raw paths can ever leak.
 */
export function buildDiagnostics(input: {
  appVersion: string;
  config: AppConfig;
  providerStatus: unknown;
  recentLogLines: string[];
  jobCounts: Record<string, number>;
  hasApiKey?: boolean;
}): string {
  const { appVersion, config, providerStatus, recentLogLines, jobCounts } = input;

  // Format bridgeBaseUrl as host-only
  let bridgeHost = 'not configured';
  if (config.bridgeBaseUrl) {
    try {
      const parsed = new URL(config.bridgeBaseUrl);
      bridgeHost = `${parsed.protocol}//${parsed.host}`;
    } catch {
      bridgeHost = 'invalid URL';
    }
  }

  // Format musePlatformOrigin as host-only
  let originHost = 'not configured';
  if (config.musePlatformOrigin) {
    try {
      const parsed = new URL(config.musePlatformOrigin);
      originHost = parsed.host;
    } catch {
      originHost = 'invalid Origin';
    }
  }

  // Determine hasApiKey boolean
  const hasApiKey =
    input.hasApiKey !== undefined
      ? input.hasApiKey
      : (input as unknown as { apiKey?: string }).apiKey !== undefined
      ? Boolean((input as unknown as { apiKey?: string }).apiKey)
      : false;

  const lines: string[] = [];

  lines.push('============================================================');
  lines.push('             POD VIDEO STUDIO - DIAGNOSTICS REPORT          ');
  lines.push('============================================================');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`App Version: ${appVersion}`);
  lines.push(`Node Version: ${process.versions.node}`);
  lines.push(`Electron Version: ${process.versions.electron ?? 'N/A'}`);
  lines.push(`Platform: ${process.platform} (${os.release()})`);
  lines.push(`Architecture: ${process.arch}`);
  lines.push('');

  lines.push('------------------------------------------------------------');
  lines.push(' CONFIGURATION (Sanitized)');
  lines.push('------------------------------------------------------------');
  lines.push(`Provider Mode: ${config.providerMode}`);
  lines.push(`Bridge Host: ${bridgeHost}`);
  lines.push(`Platform Origin Host: ${originHost}`);
  lines.push(`Has Configured API Key: ${hasApiKey}`);
  lines.push(`Prompt Max Characters: ${config.promptMaxChars}`);
  lines.push(`Poll Interval: ${config.pollIntervalMs} ms (max: ${config.pollMaxIntervalMs} ms)`);
  lines.push(`Max Source Bytes: ${config.maxSourceBytes}`);
  lines.push(`Max Source Pixels: ${config.maxSourcePixels}`);
  lines.push(`Max Video Bytes: ${config.maxVideoBytes}`);
  lines.push(`Log Retention Days: ${config.logRetentionDays}`);
  lines.push(`Admin Users Configured: ${config.adminUsers.length}`);
  lines.push(`Categories Configured: ${config.categories.length}`);
  lines.push(`Development Mode: ${config.isDev}`);
  lines.push('');

  lines.push('------------------------------------------------------------');
  lines.push(' JOB COUNTS BY STATUS');
  lines.push('------------------------------------------------------------');
  const countEntries = Object.entries(jobCounts);
  if (countEntries.length === 0) {
    lines.push('  No jobs recorded.');
  } else {
    for (const [status, count] of countEntries) {
      lines.push(`  ${status}: ${count}`);
    }
  }
  lines.push('');

  lines.push('------------------------------------------------------------');
  lines.push(' PROVIDER STATUS');
  lines.push('------------------------------------------------------------');
  try {
    lines.push(JSON.stringify(providerStatus, null, 2));
  } catch {
    lines.push('  [Provider status unavailable or non-serializable]');
  }
  lines.push('');

  lines.push('------------------------------------------------------------');
  lines.push(' RECENT LOG LINES (Last ~200 lines)');
  lines.push('------------------------------------------------------------');
  const lastLogs = recentLogLines.slice(-200);
  if (lastLogs.length === 0) {
    lines.push('  No recent logs available.');
  } else {
    for (const logLine of lastLogs) {
      lines.push(logLine);
    }
  }
  lines.push('');
  lines.push('============================================================');
  lines.push('                   END OF DIAGNOSTICS                       ');
  lines.push('============================================================');

  const rawReport = lines.join('\n');

  // Defense-in-depth: run entire output through redactText
  return redactText(rawReport);
}

/**
 * Opt-in export function to save the exact previewed diagnostics string to a file.
 */
export function exportDiagnosticsToFile(filePath: string, content: string): void {
  // Ensure the content written is thoroughly redacted
  const safeContent = redactText(content);
  writeFileSync(filePath, safeContent, { encoding: 'utf-8', mode: 0o600 });
}
