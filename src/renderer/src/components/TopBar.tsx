import { useState, useEffect, useCallback } from 'react';
import type { AppInfo, ProviderStatus } from '@shared/ipc';
import { getApi, isFakeApi } from '../api';
import { en } from '../i18n/en';
import { ProviderStatusModal } from './ProviderStatusModal';

interface TopBarProps {
  title: string;
  appInfo: AppInfo | null;
  providerStatus: ProviderStatus | null;
  onProviderStatusChange: (status: ProviderStatus) => void;
}

export function TopBar({
  title,
  appInfo,
  providerStatus,
  onProviderStatusChange,
}: TopBarProps): React.JSX.Element {
  const [modalOpen, setModalOpen] = useState(false);
  const showDemoBadge = isFakeApi();

  const fetchStatus = useCallback(async () => {
    try {
      const api = getApi();
      const res = await api.provider.getStatus();
      if (res.ok) {
        onProviderStatusChange(res.data);
      }
    } catch {
      // ignore periodic polling failure
    }
  }, [onProviderStatusChange]);

  useEffect(() => {
    // Poll every 15s
    const interval = setInterval(fetchStatus, 15000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const stateClass = providerStatus ? `status-${providerStatus.state}` : 'status-needs_login';
  const stateLabel = providerStatus ? en.provider.state[providerStatus.state] ?? providerStatus.state : en.app.loading;

  return (
    <header className="topbar">
      <div className="topbar-left">
        <h1 className="topbar-title">{title}</h1>
      </div>
      <div className="topbar-right">
        {showDemoBadge && <span className="badge-demo">{en.app.demoData}</span>}

        <button
          type="button"
          className="provider-pill"
          onClick={() => setModalOpen(true)}
          title="Click to view provider connection details"
          aria-label="Provider Status"
        >
          <span className={`status-dot ${stateClass}`} />
          <span>
            {en.provider.statusLabel}: {stateLabel}
          </span>
        </button>

        <span className="employee-badge">
          {en.app.employee}: {appInfo?.employeeId ?? '—'}
        </span>
      </div>

      <ProviderStatusModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        status={providerStatus}
        onStatusUpdated={(updated) => onProviderStatusChange(updated)}
      />
    </header>
  );
}
