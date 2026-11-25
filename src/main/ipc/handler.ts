import type { IpcMain, IpcMainInvokeEvent, WebFrameMain } from 'electron';
import type { z } from 'zod';
import { PodError, SAFE_ERROR_MESSAGES, type IpcResult } from '@shared/errors';
import type { Logger } from '@shared/services';

export function isValidSenderFrame(frame: WebFrameMain | null | undefined, isDev: boolean): boolean {
  if (!frame) return false;
  const frameUrl = frame.url;
  if (!frameUrl) return false;

  try {
    const parsed = new URL(frameUrl);
    // The window loads the Vite dev server only when ELECTRON_RENDERER_URL is set (dev); otherwise it always
    // loads the bundled renderer from file:// (packaged app, or `electron .` after a build). Navigation and
    // window.open are blocked, so no other page can be in this frame.
    const devUrl = isDev ? process.env['ELECTRON_RENDERER_URL'] : undefined;
    if (devUrl) {
      try {
        return parsed.origin === new URL(devUrl).origin;
      } catch {
        return false;
      }
    }
    return parsed.protocol === 'file:';
  } catch {
    return false;
  }
}

export interface IpcHandlerOpts<TSchema extends z.ZodTypeAny, TResult> {
  channel: string;
  schema?: TSchema;
  adminOnly?: boolean;
  isAdmin?: () => boolean;
  isDev?: boolean;
  logger: Logger;
  handler: (input: z.infer<TSchema>, event?: IpcMainInvokeEvent) => Promise<TResult> | TResult;
}

export function createIpcHandler<TSchema extends z.ZodTypeAny, TResult>(
  opts: IpcHandlerOpts<TSchema, TResult>
): (rawInput?: unknown, event?: IpcMainInvokeEvent) => Promise<IpcResult<TResult>> {
  return async (rawInput?: unknown, event?: IpcMainInvokeEvent): Promise<IpcResult<TResult>> => {
    // 1. Frame origin validation
    if (event !== undefined) {
      if (!event.senderFrame || !isValidSenderFrame(event.senderFrame, opts.isDev ?? false)) {
        return {
          ok: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Unauthorized frame URL',
          },
        };
      }
    }

    // 2. Admin authorization
    if (opts.adminOnly) {
      const allowed = opts.isAdmin ? opts.isAdmin() : false;
      if (!allowed) {
        return {
          ok: false,
          error: {
            code: 'FORBIDDEN',
            message: SAFE_ERROR_MESSAGES.FORBIDDEN,
          },
        };
      }
    }

    // 3. Schema validation
    let input: z.infer<TSchema>;
    if (opts.schema) {
      const parsed = opts.schema.safeParse(rawInput);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: 'CONFIG_INVALID',
            message: `Invalid payload for channel ${opts.channel}`,
          },
        };
      }
      input = parsed.data;
    } else {
      input = rawInput as z.infer<TSchema>;
    }

    // 4. Handler execution & error boundary
    try {
      const data = await opts.handler(input, event);
      return { ok: true, data };
    } catch (err: unknown) {
      if (err instanceof PodError) {
        return {
          ok: false,
          error: {
            code: err.code,
            message: err.safeMessage,
          },
        };
      }

      opts.logger.error('ipc_handler_unhandled_error', {
        channel: opts.channel,
        error: String(err),
      });

      return {
        ok: false,
        error: {
          code: 'INTERNAL',
          message: SAFE_ERROR_MESSAGES.INTERNAL,
        },
      };
    }
  };
}

export function registerIpcHandler<TSchema extends z.ZodTypeAny, TResult>(
  ipcMain: IpcMain,
  opts: IpcHandlerOpts<TSchema, TResult>
): void {
  const handlerFn = createIpcHandler(opts);
  ipcMain.handle(opts.channel, (event, rawInput) => handlerFn(rawInput, event));
}
