/**
 * Mock of the Muse4AI local agent API (2.0.0-beta.35 shapes; see docs/api/bridge-openapi.json).
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
  | 'auth_error'
  | 'needs_review'
  /** Chat turn succeeds but Muse only answers with text (no video output). */
  | 'chat_no_video';

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
  state: 'queued' | 'running' | 'needs_review' | 'succeeded' | 'failed' | 'cancelled';
  polls: number;
  kind: 'video' | 'chat';
}

export interface CustomResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: unknown;
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
  private customJobResponse: CustomResponse | null = null;
  private customGetJobResponse: CustomResponse | null = null;

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

  setCustomJobResponse(response: CustomResponse | null): void {
    this.customJobResponse = response;
  }

  setCustomGetJobResponse(response: CustomResponse | null): void {
    this.customGetJobResponse = response;
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
    this.customJobResponse = null;
    this.customGetJobResponse = null;
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

  /** Muse4AI public Job view. */
  private jobView(job: MockServerJob): Record<string, unknown> {
    const outputs: unknown[] = [];
    const textOnly = job.kind === 'chat' && this.behavior === 'chat_no_video';
    if (job.state === 'succeeded' && this.behavior !== 'success_no_asset' && !textOnly) {
      const assetId = `asset-${job.id}`;
      outputs.push({
        asset_id: assetId,
        kind: 'video',
        mime: 'video/mp4',
        available: true,
        download_url:
          this.behavior === 'asset_url_foreign_host'
            ? 'http://example.com/videos/foreign.mp4'
            : `http://127.0.0.1:${this.port}/v1/assets/${assetId}/content?exp=1&kid=k&sig=s`,
      });
    }
    let error: unknown = null;
    if (job.state === 'failed') {
      error =
        this.behavior === 'quota'
          ? { code: 'QUOTA_LIMIT', message: 'Usage limit reached' }
          : this.behavior === 'refused'
            ? { code: 'CONTENT_REFUSED', message: 'Muse refused' }
            : { code: 'PROVIDER_ERROR', message: 'Muse failed' };
    }
    return {
      id: job.id,
      kind: job.kind,
      mode: job.kind === 'video' ? 'reference' : undefined,
      conversation_id: job.kind === 'chat' ? `mc_${job.id}` : null,
      result: job.kind === 'chat' && job.state === 'succeeded' ? { text: 'Here is your video.' } : null,
      status: job.state,
      state: job.state === 'running' ? 'generating' : job.state,
      needs_human: job.state === 'needs_review',
      error,
      outputs,
      version: job.polls + 1,
    };
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
        res.end(JSON.stringify({ status: 401, code: 'invalid_api_key', detail: 'Authentication failed.' }));
        return false;
      }
      if (!authHeader || authHeader !== `Bearer ${this.expectedToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 401, code: 'invalid_api_key', detail: 'Missing or invalid token.' }));
        return false;
      }
      return true;
    };

    const json = (status: number, payload: unknown, type = 'application/json'): void => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(JSON.stringify(payload));
    };
    const problem = (status: number, code: string, detail = code): void =>
      json(
        status,
        { type: 'about:blank', title: code, status, detail, code, request_id: `req-${this.idCounter++}` },
        'application/problem+json'
      );

    // 1. Health check (unauthenticated)
    if (pathname === '/v1/health') {
      if (this.behavior === 'provider_5xx') return problem(500, 'internal_error');
      return json(200, { ok: true, service: 'muse4ai', instance: 'mock-instance' });
    }

    // 2. Status check (authenticated) — Muse4AI shape: capabilities, accounts, key, limits
    if (pathname === '/v1/status') {
      if (!checkAuth()) return;
      if (this.behavior === 'provider_5xx') return problem(500, 'internal_error');

      let accounts: Record<string, unknown> = {
        total: 1,
        ready: 1,
        busy: 0,
        waiting: 0,
        needs_user: 0,
        paused: 0,
        items: [{ alias: 'mock', group: 'ready', quota: { tier: 'ok' } }],
      };
      if (this.behavior === 'needs_login') {
        accounts = {
          total: 1,
          ready: 0,
          busy: 0,
          waiting: 0,
          needs_user: 1,
          paused: 0,
          items: [{ alias: 'mock', group: 'needs_user', quota: null }],
        };
      }
      return json(200, {
        service: 'muse4ai',
        version: '2.0.0-beta.35',
        capabilities: { video_from_image: true, video_from_text: true, image_from_text: true, chat: true },
        accounts,
        key: { name: 'mock', scope: 'generate', unfinished_jobs: 0 },
        limits: { prompt_max_chars: 4000, chat_prompt_max_chars: 32000, upload_max_bytes: 20 * 1024 * 1024 },
      });
    }

    // 3. Upload reference image (authenticated, raw bytes) -> 201
    if (pathname === '/v1/references' && req.method === 'POST') {
      if (!checkAuth()) return;
      if (rawBody.length > 20 * 1024 * 1024) return problem(413, 'payload_too_large');
      return json(201, {
        reference_id: `ref-${this.idCounter++}`,
        kind: 'image',
        mime: req.headers['content-type'] ?? 'image/png',
        bytes: rawBody.length,
      });
    }

    // 4. Submit video job (authenticated) -> 202 { jobs: [Job] }
    if (pathname === '/v1/jobs' && req.method === 'POST') {
      if (!checkAuth()) return;

      if (this.customJobResponse) {
        res.writeHead(this.customJobResponse.statusCode, {
          'Content-Type': 'application/json',
          ...(this.customJobResponse.headers ?? {}),
        });
        const bodyStr =
          typeof this.customJobResponse.body === 'string'
            ? this.customJobResponse.body
            : JSON.stringify(this.customJobResponse.body ?? {});
        res.end(bodyStr);
        return;
      }

      if (this.behavior === 'hang_after_request_body') return; // never answers (client timeout)
      if (this.behavior === 'provider_5xx') return problem(500, 'internal_error');
      if (this.behavior === 'redirect_to_foreign_host') {
        res.writeHead(302, { Location: 'http://example.com/foreign-submit' });
        res.end();
        return;
      }

      // Muse4AI CreateJob / CreateChat schemas are additionalProperties:false
      const body = (jsonBody ?? {}) as Record<string, unknown>;
      const kind = body['kind'];
      const allowed =
        kind === 'chat'
          ? new Set(['kind', 'prompt', 'attachments', 'conversation_id', 'account'])
          : new Set([
              'kind',
              'prompt',
              'mode',
              'reference_id',
              'reference_asset_id',
              'reference_ids',
              'repeat',
              'account',
              'site',
            ]);
      const maxPrompt = kind === 'chat' ? 32000 : 4000;
      if (
        Object.keys(body).some((k) => !allowed.has(k)) ||
        (kind !== 'video' && kind !== 'chat') ||
        typeof body['prompt'] !== 'string' ||
        body['prompt'].length < 1 ||
        body['prompt'].length > maxPrompt
      ) {
        return problem(400, 'invalid_request');
      }

      const idempotencyKey = (req.headers['idempotency-key'] as string) || `auto-${this.idCounter++}`;
      const existing = this.jobsByIdempotencyKey.get(idempotencyKey);
      if (existing) return json(202, { jobs: [this.jobView(existing)] });

      const newJob: MockServerJob = {
        id: `job-${this.idCounter++}`,
        idempotencyKey,
        state: 'queued',
        polls: 0,
        kind: kind === 'chat' ? 'chat' : 'video',
      };
      this.jobs.set(newJob.id, newJob);
      this.jobsByIdempotencyKey.set(idempotencyKey, newJob);
      return json(202, { jobs: [this.jobView(newJob)] });
    }

    // 5. List jobs (Muse4AI has no lookup by idempotency key)
    if (pathname === '/v1/jobs' && req.method === 'GET') {
      if (!checkAuth()) return;
      return json(200, { jobs: [...this.jobs.values()].map((j) => this.jobView(j)), next_cursor: null });
    }

    // 6. Query job by ID
    const jobMatch = pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    if (jobMatch && req.method === 'GET') {
      if (!checkAuth()) return;

      if (this.customGetJobResponse) {
        res.writeHead(this.customGetJobResponse.statusCode, {
          'Content-Type': 'application/json',
          ...(this.customGetJobResponse.headers ?? {}),
        });
        const bodyStr =
          typeof this.customGetJobResponse.body === 'string'
            ? this.customGetJobResponse.body
            : JSON.stringify(this.customGetJobResponse.body ?? {});
        res.end(bodyStr);
        return;
      }

      const job = this.jobs.get(decodeURIComponent(jobMatch[1] ?? ''));
      if (!job) return problem(404, 'not_found');

      // Refusal / quota surface as a failed job while polling (Muse4AI accepts first, Muse answers later).
      job.polls++;
      if (job.state === 'queued' || job.state === 'running') {
        if (job.polls === 1) job.state = 'running';
        else if (this.behavior === 'refused' || this.behavior === 'quota') job.state = 'failed';
        else if (this.behavior === 'needs_review') job.state = 'needs_review';
        else job.state = 'succeeded';
      }
      return json(200, this.jobView(job));
    }

    // 7. Cancel job
    const cancelMatch = pathname.match(/^\/v1\/jobs\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      if (!checkAuth()) return;
      if (this.behavior === 'hang_after_request_body') return;
      const job = this.jobs.get(decodeURIComponent(cancelMatch[1] ?? ''));
      if (!job) return problem(404, 'not_found');
      job.state = 'cancelled';
      return json(200, this.jobView(job));
    }

    // 8. Download asset (bearer)
    const assetMatch = pathname.match(/^\/v1\/assets\/([^/]+)\/content$/);
    if (assetMatch && req.method === 'GET') {
      if (!checkAuth()) return;

      if (this.behavior === 'redirect_to_foreign_host') {
        res.writeHead(302, { Location: 'http://example.com/asset.mp4' });
        res.end();
        return;
      }

      if (this.behavior === 'truncated_download') {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '1000' });
        res.write(Buffer.from('truncated'));
        res.destroy(); // Abruptly disconnect
        return;
      }

      if (this.behavior === 'oversized_download') {
        // Stream 25 MiB of dummy bytes (exceeds default 20 MiB limit)
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        const chunk = Buffer.alloc(1024 * 1024, 0x55);
        for (let i = 0; i < 25; i++) res.write(chunk);
        res.end();
        return;
      }

      const validMp4 = createMinimalValidMp4();
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': validMp4.length.toString() });
      res.end(validMp4);
      return;
    }

    // 404 fallback
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 404, code: 'not_found' }));
  }
}
