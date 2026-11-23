/**
 * Mock bridge HTTP server implementing the approved local Muse REST bridge.
 * Binds strictly to 127.0.0.1 on a dynamic port (port 0).
 * Supports switchable behaviors for testing happy paths, failures, quotas,
 * timeouts, and security edge cases.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMinimalValidMp4 } from '../../src/main/providers/muse/mp4';

export type MockBridgeBehavior =
  | 'healthy'
  | 'needs_login'
  | 'quota'
  | 'refused'
  | 'provider_5xx'
  | 'hang_after_request_body'
  | 'success_no_asset'
  | 'truncated_download'
  | 'oversized_download'
  | 'redirect_to_foreign_host'
  | 'asset_url_foreign_host'
  | 'auth_error';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  rawBody: Buffer;
  jsonBody?: unknown;
}

interface MockServerJob {
  id: string;
  idempotencyKey: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  polls: number;
}

export class MockBridgeServer {
  private server: http.Server | null = null;
  private port = 0;
  private behavior: MockBridgeBehavior = 'healthy';
  private expectedToken = 'test-token';
  private requests: RecordedRequest[] = [];
  private jobs = new Map<string, MockServerJob>();
  private jobsByIdempotencyKey = new Map<string, MockServerJob>();
  private idCounter = 1;

  constructor(options: { behavior?: MockBridgeBehavior; expectedToken?: string } = {}) {
    if (options.behavior) this.behavior = options.behavior;
    if (options.expectedToken) this.expectedToken = options.expectedToken;
  }

  setBehavior(behavior: MockBridgeBehavior): void {
    this.behavior = behavior;
  }

  getBehavior(): MockBridgeBehavior {
    return this.behavior;
  }

  setExpectedToken(token: string): void {
    this.expectedToken = token;
  }

  getRequests(): RecordedRequest[] {
    return [...this.requests];
  }

  clearRequests(): void {
    this.requests = [];
  }

  reset(): void {
    this.requests = [];
    this.jobs.clear();
    this.jobsByIdempotencyKey.clear();
    this.idCounter = 1;
    this.behavior = 'healthy';
  }

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server?.address() as AddressInfo;
        this.port = address.port;
        resolve(`http://127.0.0.1:${this.port}`);
      });
      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.closeAllConnections?.();
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  getBaseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks);
    let jsonBody: unknown;
    try {
      if (rawBody.length > 0) {
        jsonBody = JSON.parse(rawBody.toString('utf8'));
      }
    } catch {
      // Non-JSON body
    }

    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      rawBody,
      jsonBody,
    };
    this.requests.push(recorded);

    const parsedUrl = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const pathname = parsedUrl.pathname;
    const authHeader = req.headers['authorization'];

    const checkAuth = (): boolean => {
      if (this.behavior === 'auth_error') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Authentication failed.' }));
        return false;
      }
      if (!authHeader || authHeader !== `Bearer ${this.expectedToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Missing or invalid token.' }));
        return false;
      }
      return true;
    };

    // 1. Health check (unauthenticated)
    if (pathname === '/v1/health') {
      if (this.behavior === 'provider_5xx') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INTERNAL_ERROR' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', healthy: true }));
      return;
    }

    // 2. Status check (authenticated)
    if (pathname === '/v1/status') {
      if (!checkAuth()) return;

      if (this.behavior === 'needs_login') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'needs_login', needs_login: true }));
        return;
      }
      if (this.behavior === 'quota') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'quota_limited', quota_limited: true }));
        return;
      }
      if (this.behavior === 'provider_5xx') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INTERNAL_ERROR' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ready',
          authenticated: true,
          capabilities: {
            can_cancel: true,
            reports_progress: true,
            supported_durations: [5, 10],
            supported_aspect_ratios: ['9:16', '16:9', '1:1'],
            max_prompt_chars: 4000,
            max_upload_bytes: 20 * 1024 * 1024,
            can_lookup_by_request_id: true,
          },
        })
      );
      return;
    }

    // 3. Upload reference image (authenticated)
    if (pathname === '/v1/references' && req.method === 'POST') {
      if (!checkAuth()) return;

      if (rawBody.length > 20 * 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'PAYLOAD_TOO_LARGE' }));
        return;
      }

      const referenceId = `ref-${this.idCounter++}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          reference_id: referenceId,
          kind: 'image',
          mime: req.headers['content-type'] ?? 'image/png',
          bytes: rawBody.length,
        })
      );
      return;
    }

    // 4. Submit video job (authenticated)
    if (pathname === '/v1/jobs' && req.method === 'POST') {
      if (!checkAuth()) return;

      if (this.behavior === 'hang_after_request_body') {
        // Hang indefinitely without responding (triggers client timeout)
        return;
      }

      if (this.behavior === 'refused') {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'CONTENT_REFUSED',
            message: 'Artwork content was refused by policy.',
            submitted: false,
          })
        );
        return;
      }

      if (this.behavior === 'quota') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'QUOTA_LIMITED',
            message: 'Generation quota exceeded.',
            submitted: false,
          })
        );
        return;
      }

      if (this.behavior === 'provider_5xx') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INTERNAL_SERVER_ERROR' }));
        return;
      }

      if (this.behavior === 'redirect_to_foreign_host') {
        res.writeHead(302, { Location: 'http://example.com/foreign-submit' });
        res.end();
        return;
      }

      const idempotencyKey = (req.headers['idempotency-key'] as string) || `auto-${this.idCounter++}`;
      const existing = this.jobsByIdempotencyKey.get(idempotencyKey);
      if (existing) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: existing.id, state: existing.state }));
        return;
      }

      const jobId = `job-${this.idCounter++}`;
      const newJob: MockServerJob = {
        id: jobId,
        idempotencyKey,
        state: 'queued',
        polls: 0,
      };

      this.jobs.set(jobId, newJob);
      this.jobsByIdempotencyKey.set(idempotencyKey, newJob);

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: jobId, state: 'queued' }));
      return;
    }

    // 5. Query jobs by query parameter (idempotency key lookup)
    if (pathname === '/v1/jobs' && req.method === 'GET') {
      if (!checkAuth()) return;
      const idempotencyKey = parsedUrl.searchParams.get('idempotency_key');
      if (idempotencyKey) {
        const job = this.jobsByIdempotencyKey.get(idempotencyKey);
        if (!job) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'NOT_FOUND' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              id: job.id,
              state: job.state,
              asset_id: `asset-${job.id}`,
            },
          ])
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }

    // 6. Query job by ID
    const jobMatch = pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    if (jobMatch && req.method === 'GET') {
      if (!checkAuth()) return;
      const jobId = decodeURIComponent(jobMatch[1] ?? '');
      const job = this.jobs.get(jobId);
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND' }));
        return;
      }

      job.polls++;
      if (job.state !== 'cancelled' && job.state !== 'failed') {
        if (job.polls === 1) {
          job.state = 'running';
        } else {
          job.state = 'succeeded';
        }
      }

      const progress = job.state === 'running' ? 0.5 : job.state === 'succeeded' ? 1.0 : 0.0;

      let assetUrl: string | undefined;
      let assetId: string | undefined;

      if (job.state === 'succeeded') {
        if (this.behavior === 'success_no_asset') {
          // Omit asset_id and asset_url
        } else if (this.behavior === 'asset_url_foreign_host') {
          assetId = `asset-${job.id}`;
          assetUrl = 'http://example.com/videos/foreign.mp4';
        } else {
          assetId = `asset-${job.id}`;
          assetUrl = `http://127.0.0.1:${this.port}/v1/assets/${assetId}/download`;
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: job.id,
          state: job.state,
          progress,
          asset_id: assetId,
          asset_url: assetUrl,
        })
      );
      return;
    }

    // 7. Cancel job
    const cancelMatch = pathname.match(/^\/v1\/jobs\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      if (!checkAuth()) return;
      const jobId = decodeURIComponent(cancelMatch[1] ?? '');
      const job = this.jobs.get(jobId);
      if (job) {
        job.state = 'cancelled';
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'cancelled' }));
      return;
    }

    // 8. Download asset
    const assetMatch = pathname.match(/^\/v1\/assets\/([^/]+)\/download$/);
    if (assetMatch && req.method === 'GET') {
      if (!checkAuth()) return;

      if (this.behavior === 'redirect_to_foreign_host') {
        res.writeHead(302, { Location: 'http://example.com/asset.mp4' });
        res.end();
        return;
      }

      if (this.behavior === 'truncated_download') {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': '1000',
        });
        res.write(Buffer.from('truncated'));
        res.destroy(); // Abruptly disconnect
        return;
      }

      if (this.behavior === 'oversized_download') {
        // Stream 25 MiB of dummy bytes (exceeds default 20 MiB limit)
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        const chunk = Buffer.alloc(1024 * 1024, 0x55);
        for (let i = 0; i < 25; i++) {
          res.write(chunk);
        }
        res.end();
        return;
      }

      const validMp4 = createMinimalValidMp4();
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': validMp4.length.toString(),
      });
      res.end(validMp4);
      return;
    }

    // 404 fallback
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  }
}
