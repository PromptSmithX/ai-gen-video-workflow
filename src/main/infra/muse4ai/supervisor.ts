import fs from 'node:fs';
import path from 'node:path';
import type { SetupStatus } from '@shared/ipc';
import type { Logger, SecretStore } from '@shared/services';

/**
 * Starts and provisions the Muse4AI copy shipped with the installer, so the employee only signs in to Muse.
 *
 * The bundled build carries a local patch (vendor/muse4ai/patches): `--pod-bootstrap <json>` turns on its API on
 * this machine only, runs the loopback proxy, adds one account and writes an API key for POD to `keyOut`;
 * `--pod-login` opens its Muse sign-in window; `/v1/health` reports `pod: true`. POD itself opens no listener.
 */
export interface Muse4aiSupervisorDeps {
  exePath: string;
  bridgeBaseUrl: string;
  proxyPort: number;
  /** POD-private folder for the bootstrap request and the one-time key hand-over. */
  workDir: string;
  secrets: SecretStore;
  getApiKey(): string | null;
  logger: Logger;
  spawn(exe: string, args: string[]): void;
  fetch(url: string, init?: { headers?: Record<string, string> }): Promise<{ status: number; json(): Promise<unknown> }>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** How long to wait for Muse4AI to answer / to hand over a key. */
  startTimeoutMs?: number;
}

type Health = { up: false } | { up: true; pod: boolean };

export class Muse4aiSupervisor {
  private state: SetupStatus = { managed: true, muse4ai: 'starting', message: null };
  private running: Promise<void> | null = null;

  constructor(private readonly d: Muse4aiSupervisorDeps) {}

  status(): SetupStatus {
    return { ...this.state };
  }

  /** Make sure the bundled Muse4AI runs and POD holds a working key. Concurrent calls share one run. */
  ensure(): Promise<void> {
    this.running ??= this.doEnsure().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Opens Muse4AI's own sign-in window for the account (the user signs in to muse.ai there). */
  login(): void {
    this.d.spawn(this.d.exePath, ['--pod-login']);
    this.d.logger.info('muse4ai.login_opened');
  }

  /** Another (unpatched) Muse4AI is running: ask it to quit, then start the bundled one. */
  async useBundled(): Promise<void> {
    this.d.spawn(this.d.exePath, ['--quit']);
    const until = this.d.now() + (this.d.startTimeoutMs ?? 30_000);
    while (this.d.now() < until) {
      await this.d.sleep(1000);
      if (!(await this.health()).up) break;
    }
    await this.ensure();
  }

  private async doEnsure(): Promise<void> {
    try {
      let health = await this.health();
      if (health.up && !health.pod) {
        this.set('outdated', 'Another Muse4AI is running. Close it so POD can use the bundled version.');
        return;
      }
      const keyOk = health.up ? await this.keyWorks() : false;
      if (health.up && keyOk) {
        this.set('running');
        return;
      }

      // Not running, or running without a key POD can use: start / ask it to provision.
      this.set('starting');
      const keyOut = path.join(this.d.workDir, 'muse4ai.key');
      const request = path.join(this.d.workDir, 'muse4ai-bootstrap.json');
      fs.mkdirSync(this.d.workDir, { recursive: true });
      this.removeQuietly(keyOut);
      const rotateKey = !keyOk;
      fs.writeFileSync(request, JSON.stringify({ keyOut, proxyPort: this.d.proxyPort, rotateKey }), { mode: 0o600 });
      this.d.spawn(this.d.exePath, ['--hidden', '--pod-bootstrap', request]);
      this.d.logger.info('muse4ai.started', { wasRunning: health.up, rotateKey });

      const until = this.d.now() + (this.d.startTimeoutMs ?? 60_000);
      let gotKey = false;
      while (this.d.now() < until) {
        await this.d.sleep(1000);
        if (fs.existsSync(keyOut)) {
          const token = fs.readFileSync(keyOut, 'utf8').trim();
          this.removeQuietly(keyOut);
          if (token) {
            this.d.secrets.set('bridge_api_key', token);
            gotKey = true;
            this.d.logger.info('muse4ai.key_received');
          }
        }
        health = await this.health();
        if (health.up && gotKey) break;
      }
      this.removeQuietly(request);

      if (!health.up) {
        this.set('failed', 'Muse4AI did not start. Restart POD Video Studio; if it keeps failing, export diagnostics.');
        return;
      }
      if (!gotKey && !(await this.keyWorks())) {
        this.set('failed', 'Muse4AI started but did not hand over an API key.');
        return;
      }
      this.set('running');
    } catch (err) {
      this.d.logger.error('muse4ai.ensure_failed', { error: err instanceof Error ? err.name : 'unknown' });
      this.set('failed', 'Could not start Muse4AI.');
    }
  }

  private async health(): Promise<Health> {
    try {
      const r = await this.d.fetch(`${this.d.bridgeBaseUrl}/v1/health`);
      if (r.status !== 200) return { up: false };
      const body = (await r.json()) as { pod?: unknown } | null;
      return { up: true, pod: body?.pod === true };
    } catch {
      return { up: false };
    }
  }

  private async keyWorks(): Promise<boolean> {
    const key = this.d.getApiKey();
    if (!key) return false;
    try {
      const r = await this.d.fetch(`${this.d.bridgeBaseUrl}/v1/status`, { headers: { Authorization: `Bearer ${key}` } });
      return r.status === 200;
    } catch {
      return false;
    }
  }

  private set(muse4ai: SetupStatus['muse4ai'], message: string | null = null): void {
    if (this.state.muse4ai !== muse4ai) this.d.logger.info('muse4ai.state', { state: muse4ai });
    this.state = { managed: true, muse4ai, message };
  }

  private removeQuietly(p: string): void {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // ignore
    }
  }
}
