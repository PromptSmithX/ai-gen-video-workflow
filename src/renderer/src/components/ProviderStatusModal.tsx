import { useState } from 'react';
import type { ProviderStatus } from '@shared/ipc';
import { getApi } from '../api';
import { en } from '../i18n/en';
import { Modal } from './Modal';

interface ProviderStatusModalProps {
  isOpen: boolean;
  onClose: () => void;
  status: ProviderStatus | null;
  onStatusUpdated: (updated: ProviderStatus) => void;
}

export function ProviderStatusModal({
  isOpen,
  onClose,
  status,
  onStatusUpdated,
}: ProviderStatusModalProps): React.JSX.Element {
  const [testing, setTesting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleTestConnection = async () => {
    setTesting(true);
    setErrorMsg(null);
    try {
      const api = getApi();
      const res = await api.provider.testConnection();
      if (res.ok) {
        onStatusUpdated(res.data);
      } else {
        setErrorMsg(res.error.message);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={en.provider.modalTitle}
      footer={
        <>
          <button
            type="button"
            className="btn-primary"
            onClick={handleTestConnection}
            disabled={testing}
          >
            {testing ? en.app.loading : en.provider.testConnection}
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {en.provider.close}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
        {errorMsg && <div className="error-text">{errorMsg}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '0.5rem', fontSize: '0.875rem' }}>
          <strong>{en.provider.mode}:</strong>
          <span>{status?.mode ?? '—'}</span>

          <strong>{en.provider.connectionState}:</strong>
          <span style={{ textTransform: 'capitalize' }}>
            {status ? en.provider.state[status.state] ?? status.state : '—'}
          </span>

          <strong>{en.provider.origin}:</strong>
          <span>{status?.platformOrigin ?? '—'}</span>

          <strong>{en.provider.bridgeUrl}:</strong>
          <span>{status?.bridgeBaseUrl ?? '—'}</span>

          <strong>{en.provider.compatibility}:</strong>
          <span style={{ textTransform: 'capitalize' }}>{status?.compatibility ?? '—'}</span>

          <strong>{en.provider.hasApiKey}:</strong>
          <span>{status?.hasApiKey ? en.provider.configured : en.provider.notConfigured}</span>

          <strong>{en.provider.secretStore}:</strong>
          <span>{status?.secretStoreAvailable ? en.provider.available : en.provider.unavailable}</span>

          <strong>{en.provider.checkedAt}:</strong>
          <span>{status?.checkedAt ? new Date(status.checkedAt).toLocaleString() : '—'}</span>
        </div>
      </div>
    </Modal>
  );
}
