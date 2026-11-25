// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PodApi, ProviderStatus, SetupStatus } from '@shared/ipc';
import { setApiOverride } from '../api';
import { Setup, needsSetup } from './Setup';

function status(setup: SetupStatus | undefined, extra: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    mode: 'bridge',
    state: 'needs_login',
    capabilities: null,
    platformOrigin: 'https://muse.ai',
    bridgeBaseUrl: 'http://127.0.0.1:47821',
    compatibility: 'compatible',
    hasApiKey: true,
    secretStoreAvailable: true,
    checkedAt: new Date().toISOString(),
    ...(setup ? { setup } : {}),
    ...extra,
  };
}

describe('Setup screen', () => {
  let setupAction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setupAction = vi.fn().mockResolvedValue({ ok: true, data: status({ managed: true, muse4ai: 'running', message: null }) });
    setApiOverride({
      provider: { getStatus: vi.fn().mockResolvedValue({ ok: true, data: status(undefined) }), testConnection: vi.fn(), setupAction },
    } as unknown as PodApi);
  });

  it('needsSetup: only for the bundled Muse4AI and only until it is ready', () => {
    expect(needsSetup(null)).toBe(false);
    expect(needsSetup(status(undefined))).toBe(false);
    expect(needsSetup(status({ managed: true, muse4ai: 'starting', message: null }))).toBe(true);
    expect(needsSetup(status({ managed: true, muse4ai: 'running', message: null }, { state: 'needs_login' }))).toBe(true);
    expect(needsSetup(status({ managed: true, muse4ai: 'running', message: null }, { state: 'ready' }))).toBe(false);
    expect(needsSetup(status({ managed: true, muse4ai: 'running', message: null }, { state: 'busy' }))).toBe(false);
  });

  it('Muse4AI running, not signed in: shows the sign-in button and opens the sign-in window', async () => {
    const onChange = vi.fn();
    render(<Setup status={status({ managed: true, muse4ai: 'running', message: null })} onStatusChange={onChange} pollMs={60_000} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Muse' }));
    await waitFor(() => expect(setupAction).toHaveBeenCalledWith({ action: 'login' }));
    expect(await screen.findByText(/Sign-in window opened/)).toBeTruthy();
  });

  it('another Muse4AI running: offers to use the bundled one', async () => {
    render(
      <Setup
        status={status({ managed: true, muse4ai: 'outdated', message: 'Another Muse4AI is running.' })}
        onStatusChange={vi.fn()}
        pollMs={60_000}
      />
    );
    expect(screen.getByText('Another Muse4AI is running.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in to Muse' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use the bundled version' }));
    await waitFor(() => expect(setupAction).toHaveBeenCalledWith({ action: 'useBundled' }));
  });

  it('failed start: offers to try again', async () => {
    render(<Setup status={status({ managed: true, muse4ai: 'failed', message: 'Muse4AI did not start.' })} onStatusChange={vi.fn()} pollMs={60_000} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(setupAction).toHaveBeenCalledWith({ action: 'retry' }));
  });
});
