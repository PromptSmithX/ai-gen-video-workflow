import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PodError } from '@shared/errors';
import type { Logger, LogFields } from '@shared/services';
import { createIpcHandler } from '../../src/main/ipc/handler';

describe('IPC Helper E2E', () => {
  const capturedLogs: Array<{ level: string; event: string; fields?: LogFields }> = [];
  const testLogger: Logger = {
    debug: (event, fields) => capturedLogs.push({ level: 'debug', event, fields }),
    info: (event, fields) => capturedLogs.push({ level: 'info', event, fields }),
    warn: (event, fields) => capturedLogs.push({ level: 'warn', event, fields }),
    error: (event, fields) => capturedLogs.push({ level: 'error', event, fields }),
    child: () => testLogger,
  };

  const TestPayloadSchema = z.object({
    jobId: z.string().uuid(),
    count: z.number().int().positive(),
  });

  // 1. Invalid payload -> ok: false with code, no throw
  it('invalid payload -> ok:false with code, no throw', async () => {
    const handler = createIpcHandler({
      channel: 'test:action',
      schema: TestPayloadSchema,
      logger: testLogger,
      handler: (input) => {
        return { received: input.jobId };
      },
    });

    const invalidInputs = [
      null,
      undefined,
      {},
      { jobId: 'not-a-uuid', count: 5 },
      { jobId: '00000000-0000-0000-0000-000000000000', count: -1 },
      'string-instead-of-object',
    ];

    for (const badInput of invalidInputs) {
      const res = await handler(badInput);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('CONFIG_INVALID');
        expect(res.error.message).toBeTruthy();
      }
    }
  });

  // 2. Non-admin calling admin channel -> FORBIDDEN
  it('non-admin calling admin channel -> FORBIDDEN', async () => {
    let isAdminUser = false;
    const adminHandler = createIpcHandler({
      channel: 'admin:action',
      schema: z.object({ setting: z.string() }),
      adminOnly: true,
      isAdmin: () => isAdminUser,
      logger: testLogger,
      handler: (input) => ({ success: true, setting: input.setting }),
    });

    // When isAdmin is false
    isAdminUser = false;
    const deniedRes = await adminHandler({ setting: 'dark_mode' });
    expect(deniedRes.ok).toBe(false);
    if (!deniedRes.ok) {
      expect(deniedRes.error.code).toBe('FORBIDDEN');
    }

    // When isAdmin is true
    isAdminUser = true;
    const allowedRes = await adminHandler({ setting: 'dark_mode' });
    expect(allowedRes.ok).toBe(true);
    if (allowedRes.ok) {
      expect(allowedRes.data.setting).toBe('dark_mode');
    }
  });

  // 3. Error conversion
  it('converts PodError to SafeError and unknown errors to INTERNAL', async () => {
    const podErrorHandler = createIpcHandler({
      channel: 'test:podError',
      logger: testLogger,
      handler: () => {
        throw new PodError('NOT_FOUND', 'Item 123 not found');
      },
    });

    const podRes = await podErrorHandler();
    expect(podRes.ok).toBe(false);
    if (!podRes.ok) {
      expect(podRes.error.code).toBe('NOT_FOUND');
      expect(podRes.error.message).toBe('Item 123 not found');
    }

    const unexpectedHandler = createIpcHandler({
      channel: 'test:unexpected',
      logger: testLogger,
      handler: () => {
        throw new Error('Database disk image is malformed (sqlite error 11)');
      },
    });

    const unexpRes = await unexpectedHandler();
    expect(unexpRes.ok).toBe(false);
    if (!unexpRes.ok) {
      expect(unexpRes.error.code).toBe('INTERNAL');
      expect(unexpRes.error.message).toBe('An unexpected error occurred.');
    }
  });

  // 4. SenderFrame validation: null frame / unauthorized frame -> FORBIDDEN; no event -> allowed
  it('senderFrame validation: null frame / unauthorized frame -> FORBIDDEN; no event -> allowed', async () => {
    const handler = createIpcHandler({
      channel: 'test:frame',
      logger: testLogger,
      isDev: false,
      handler: () => ({ success: true }),
    });

    // 4a. Unit test path: event === undefined -> allowed
    const noEventRes = await handler();
    expect(noEventRes.ok).toBe(true);

    // 4b. Event present but senderFrame is null (destroyed/navigated frame) -> FORBIDDEN
    const nullFrameEvent = { senderFrame: null } as unknown as import('electron').IpcMainInvokeEvent;
    const nullFrameRes = await handler({}, nullFrameEvent);
    expect(nullFrameRes.ok).toBe(false);
    if (!nullFrameRes.ok) {
      expect(nullFrameRes.error.code).toBe('FORBIDDEN');
    }

    // 4c. Event present with invalid / unauthorized origin -> FORBIDDEN
    const untrustedFrameEvent = {
      senderFrame: { url: 'http://malicious.example.com' },
    } as unknown as import('electron').IpcMainInvokeEvent;
    const untrustedRes = await handler({}, untrustedFrameEvent);
    expect(untrustedRes.ok).toBe(false);
    if (!untrustedRes.ok) {
      expect(untrustedRes.error.code).toBe('FORBIDDEN');
    }
  });
});
