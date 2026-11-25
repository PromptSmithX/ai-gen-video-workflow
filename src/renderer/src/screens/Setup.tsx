import { useEffect, useState } from 'react';
import type { ProviderStatus } from '@shared/ipc';
import { getApi } from '../api';
import { en } from '../i18n/en';

/** True while the bundled Muse4AI still needs the employee (or is still starting). */
export function needsSetup(status: ProviderStatus | null): boolean {
  if (!status?.setup) return false;
  return status.setup.muse4ai !== 'running' || status.state === 'needs_login' || status.state === 'not_installed' || status.state === 'error';
}

type StepState = 'done' | 'active' | 'waiting' | 'error';

function Step({ label, state, detail }: { label: string; state: StepState; detail?: string | null }): React.JSX.Element {
  const icon = state === 'done' ? '✓' : state === 'error' ? '!' : state === 'active' ? '…' : '○';
  const color = state === 'done' ? 'var(--success)' : state === 'error' ? 'var(--danger)' : 'var(--text-muted)';
  return (
    <li style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', padding: '0.6rem 0' }}>
      <span aria-hidden style={{ width: '1.5rem', textAlign: 'center', fontWeight: 700, color }}>
        {icon}
      </span>
      <div>
        <div style={{ fontWeight: 600 }}>{label}</div>
        {detail && <div className="info-text">{detail}</div>}
      </div>
    </li>
  );
}

export function Setup({
  status,
  onStatusChange,
  pollMs = 3000,
}: {
  status: ProviderStatus;
  onStatusChange: (s: ProviderStatus) => void;
  pollMs?: number;
}): React.JSX.Element {
  const [loginOpened, setLoginOpened] = useState(false);
  const [busy, setBusy] = useState(false);

  // Keep the status fresh while this screen is shown; it disappears by itself once Muse is ready.
  useEffect(() => {
    const api = getApi();
    const t = setInterval(() => {
      void api.provider.getStatus().then((r) => {
        if (r.ok) onStatusChange(r.data);
      });
    }, pollMs);
    return () => clearInterval(t);
  }, [onStatusChange, pollMs]);

  const setup = status.setup;
  const app = setup?.muse4ai ?? 'starting';
  const appState: StepState = app === 'running' ? 'done' : app === 'starting' ? 'active' : 'error';
  const connected = app === 'running' && status.hasApiKey && status.state !== 'error' && status.state !== 'not_installed';
  const connState: StepState = connected ? 'done' : app === 'running' ? 'active' : 'waiting';
  const loggedIn = connected && status.state !== 'needs_login';
  const loginState: StepState = loggedIn ? 'done' : connected ? 'active' : 'waiting';

  const act = async (action: 'login' | 'useBundled' | 'retry'): Promise<void> => {
    setBusy(true);
    try {
      const r = await getApi().provider.setupAction({ action });
      if (r.ok) onStatusChange(r.data);
      if (action === 'login') setLoginOpened(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem 1rem' }}>
      <div className="card" style={{ maxWidth: '560px', width: '100%', padding: '2rem' }}>
        <h1 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: '0.5rem' }}>{en.setup.title}</h1>
        <p className="info-text" style={{ marginBottom: '1.25rem' }}>
          {en.setup.subtitle}
        </p>

        <ol style={{ listStyle: 'none', padding: 0, margin: '0 0 1.25rem' }}>
          <Step
            label={en.setup.stepApp}
            state={appState}
            detail={app === 'starting' ? en.setup.starting : setup?.message ?? null}
          />
          <Step label={en.setup.stepConnection} state={connState} />
          <Step
            label={en.setup.stepLogin}
            state={loginState}
            detail={loginState === 'active' ? (loginOpened ? en.setup.loginOpened : en.setup.loginHint) : null}
          />
        </ol>

        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          {loginState === 'active' && (
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void act('login')}>
              {en.setup.loginButton}
            </button>
          )}
          {app === 'outdated' && (
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void act('useBundled')}>
              {en.setup.outdatedButton}
            </button>
          )}
          {app === 'failed' && (
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void act('retry')}>
              {en.setup.retryButton}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
