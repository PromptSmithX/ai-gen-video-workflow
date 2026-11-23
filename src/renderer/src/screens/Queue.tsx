import { useState, useEffect } from 'react';
import type { JobView, JobNextAction } from '@shared/ipc';
import { ACTIVE_JOB_STATES } from '@shared/job-state';
import { getApi } from '../api';
import { en } from '../i18n/en';
import { Modal } from '../components/Modal';

interface QueueProps {
  highlightJobId?: string | null;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}

export function Queue({ highlightJobId }: QueueProps): React.JSX.Element {
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Per-job action pending state
  const [pendingJobIds, setPendingJobIds] = useState<Set<string>>(new Set());

  // Confirm dialog states
  const [retryDialogJob, setRetryDialogJob] = useState<JobView | null>(null);
  const [ambiguousDialogJob, setAmbiguousDialogJob] = useState<JobView | null>(null);
  const [regenerateDialogJob, setRegenerateDialogJob] = useState<JobView | null>(null);

  // Ticking timer for elapsed time using initializer function to maintain purity
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let isMounted = true;
    const api = getApi();

    api.jobs
      .list()
      .then((res) => {
        if (!isMounted) return;
        if (res.ok) {
          setJobs(res.data);
        } else {
          setErrorMsg(res.error.message);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (!isMounted) return;
        setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
        setLoading(false);
      });

    const unsubscribe = api.jobs.onUpdated((updatedView) => {
      setJobs((prev) => {
        const index = prev.findIndex((j) => j.job.id === updatedView.job.id);
        if (index >= 0) {
          const next = [...prev];
          next[index] = updatedView;
          return next;
        }
        return [updatedView, ...prev];
      });
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  const setJobPending = (jobId: string, pending: boolean) => {
    setPendingJobIds((prev) => {
      const next = new Set(prev);
      if (pending) next.add(jobId);
      else next.delete(jobId);
      return next;
    });
  };

  const handleAction = async (jobView: JobView, action: JobNextAction) => {
    const jobId = jobView.job.id;
    if (pendingJobIds.has(jobId)) return;

    if (action === 'retry') {
      setRetryDialogJob(jobView);
      return;
    }
    if (action === 'check_ambiguous') {
      setAmbiguousDialogJob(jobView);
      return;
    }
    if (action === 'regenerate') {
      setRegenerateDialogJob(jobView);
      return;
    }

    // Direct actions: retry_download, cancel
    setJobPending(jobId, true);
    try {
      const api = getApi();
      if (action === 'retry_download') {
        const res = await api.jobs.retryDownload({ jobId });
        if (!res.ok) setErrorMsg(res.error.message);
      } else if (action === 'cancel') {
        const res = await api.jobs.cancel({ jobId });
        if (!res.ok) setErrorMsg(res.error.message);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    } finally {
      setJobPending(jobId, false);
    }
  };

  // Confirm Retry execution
  const executeRetry = async () => {
    if (!retryDialogJob) return;
    const jobId = retryDialogJob.job.id;
    setRetryDialogJob(null);
    setJobPending(jobId, true);
    try {
      const api = getApi();
      const res = await api.jobs.retry({ jobId, acknowledged: true });
      if (!res.ok) setErrorMsg(res.error.message);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    } finally {
      setJobPending(jobId, false);
    }
  };

  // Ambiguous resolution (check_again OR mark_failed) - NEVER calls jobs.retry
  const executeResolveAmbiguous = async (resolution: 'check_again' | 'mark_failed') => {
    if (!ambiguousDialogJob) return;
    const jobId = ambiguousDialogJob.job.id;
    setAmbiguousDialogJob(null);
    setJobPending(jobId, true);
    try {
      const api = getApi();
      const res = await api.jobs.resolveAmbiguous({ jobId, resolution });
      if (!res.ok) setErrorMsg(res.error.message);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    } finally {
      setJobPending(jobId, false);
    }
  };

  // Confirm Regenerate execution
  const executeRegenerate = async () => {
    if (!regenerateDialogJob) return;
    const jobId = regenerateDialogJob.job.id;
    setRegenerateDialogJob(null);
    setJobPending(jobId, true);
    try {
      const api = getApi();
      const res = await api.jobs.regenerate({
        jobId,
        confirmed: true,
        clientRequestId: crypto.randomUUID(),
      });
      if (!res.ok) setErrorMsg(res.error.message);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    } finally {
      setJobPending(jobId, false);
    }
  };

  const activeJobs = jobs.filter((v) => ACTIVE_JOB_STATES.includes(v.job.state));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>{en.queue.title}</h2>
          <p className="info-text">
            {en.queue.activeCount.replace('{count}', String(activeJobs.length))}
          </p>
        </div>
      </div>

      {errorMsg && (
        <div className="card" style={{ backgroundColor: 'var(--danger-bg)', borderColor: 'var(--danger)' }}>
          <p className="error-text">{errorMsg}</p>
        </div>
      )}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
          <div className="spinner" />
          <p style={{ marginTop: '0.75rem', color: 'var(--text-muted)' }}>{en.app.loading}</p>
        </div>
      ) : jobs.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
          <p style={{ color: 'var(--text-muted)' }}>{en.queue.empty}</p>
        </div>
      ) : (
        <div className="table-container">
          <table className="queue-table">
            <thead>
              <tr>
                <th>{en.queue.table.source}</th>
                <th>{en.queue.table.sku}</th>
                <th>{en.queue.table.category}</th>
                <th>{en.queue.table.status}</th>
                <th>{en.queue.table.created}</th>
                <th>{en.queue.table.elapsed}</th>
                <th>{en.queue.table.employee}</th>
                <th>{en.queue.table.progress}</th>
                <th>{en.queue.table.actions}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((item) => {
                const { job, stateLabel, category, sourceUrl, progress, nextActions } = item;
                const isHighlighted = highlightJobId === job.id;
                const isActive = ACTIVE_JOB_STATES.includes(job.state);
                const isPending = pendingJobIds.has(job.id);
                const elapsedMs = now - new Date(job.createdAt).getTime();

                return (
                  <tr key={job.id} className={isHighlighted ? 'highlighted' : ''}>
                    {/* Source Thumbnail */}
                    <td>
                      {sourceUrl ? (
                        <img
                          src={sourceUrl}
                          alt={`Mockup for ${job.skuSnapshot}`}
                          className="queue-thumbnail"
                        />
                      ) : (
                        <div
                          className="queue-thumbnail"
                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                          🖼️
                        </div>
                      )}
                    </td>

                    {/* SKU */}
                    <td>
                      <strong>{job.skuSnapshot}</strong>
                      {job.safeErrorMessage && (
                        <div className="error-text" style={{ fontSize: '0.75rem', marginTop: '0.2rem' }}>
                          {job.safeErrorMessage}
                        </div>
                      )}
                    </td>

                    {/* Category */}
                    <td>{category}</td>

                    {/* Status */}
                    <td>
                      <span
                        className={`badge-status ${
                          job.state === 'SUCCEEDED'
                            ? 'badge-status-succeeded'
                            : job.state.startsWith('FAILED')
                              ? 'badge-status-failed'
                              : isActive
                                ? 'badge-status-running'
                                : 'badge-status-neutral'
                        }`}
                      >
                        {stateLabel}
                      </span>
                    </td>

                    {/* Created */}
                    <td style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                      {new Date(job.createdAt).toLocaleTimeString()}
                    </td>

                    {/* Elapsed */}
                    <td style={{ fontSize: '0.8125rem' }}>{formatElapsed(elapsedMs)}</td>

                    {/* Employee */}
                    <td style={{ fontSize: '0.8125rem' }}>{job.employeeId}</td>

                    {/* Progress Bar / Indeterminate Spinner */}
                    <td>
                      {progress !== null ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: '100px' }}>
                          <progress value={Math.round(progress * 100)} max={100} style={{ width: '80px' }} />
                          <span style={{ fontSize: '0.75rem', fontWeight: 600 }}>
                            {Math.round(progress * 100)}%
                          </span>
                        </div>
                      ) : isActive ? (
                        <div
                          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                          role="progressbar"
                          aria-label={en.queue.indeterminate}
                        >
                          <div className="spinner" />
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>—</span>
                      )}
                    </td>

                    {/* Action buttons (renders ONLY actions from nextActions) */}
                    <td>
                      <div className="actions-cell">
                        {nextActions.map((action) => {
                          if (action === 'none') return null;
                          return (
                            <button
                              key={action}
                              type="button"
                              className={`btn-sm ${
                                action === 'retry'
                                  ? 'btn-primary'
                                  : action === 'cancel'
                                    ? 'btn-danger'
                                    : 'btn-secondary'
                              }`}
                              disabled={isPending}
                              onClick={() => handleAction(item, action)}
                            >
                              {en.queue.actions[action]}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Retry Confirmation Dialog */}
      <Modal
        isOpen={retryDialogJob !== null}
        onClose={() => setRetryDialogJob(null)}
        title={en.queue.confirmRetry.title}
        footer={
          <>
            <button type="button" className="btn-primary" onClick={executeRetry}>
              {en.queue.confirmRetry.confirm}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setRetryDialogJob(null)}>
              {en.queue.confirmRetry.cancel}
            </button>
          </>
        }
      >
        <p>{en.queue.confirmRetry.message}</p>
        {retryDialogJob && (
          <p style={{ marginTop: '0.5rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
            SKU: <strong>{retryDialogJob.job.skuSnapshot}</strong>
          </p>
        )}
      </Modal>

      {/* Ambiguous Generation Dialog (Never calls jobs.retry) */}
      <Modal
        isOpen={ambiguousDialogJob !== null}
        onClose={() => setAmbiguousDialogJob(null)}
        title={en.queue.ambiguousDialog.title}
        footer={
          <>
            <button
              type="button"
              className="btn-primary"
              onClick={() => executeResolveAmbiguous('check_again')}
            >
              {en.queue.ambiguousDialog.checkAgain}
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={() => executeResolveAmbiguous('mark_failed')}
            >
              {en.queue.ambiguousDialog.markFailed}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setAmbiguousDialogJob(null)}
            >
              {en.queue.ambiguousDialog.cancel}
            </button>
          </>
        }
      >
        <p>{en.queue.ambiguousDialog.message}</p>
        {ambiguousDialogJob && (
          <p style={{ marginTop: '0.5rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
            SKU: <strong>{ambiguousDialogJob.job.skuSnapshot}</strong>
          </p>
        )}
      </Modal>

      {/* Regenerate Confirmation Dialog */}
      <Modal
        isOpen={regenerateDialogJob !== null}
        onClose={() => setRegenerateDialogJob(null)}
        title={en.queue.confirmRegenerate.title}
        footer={
          <>
            <button type="button" className="btn-primary" onClick={executeRegenerate}>
              {en.queue.confirmRegenerate.confirm}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setRegenerateDialogJob(null)}
            >
              {en.queue.confirmRegenerate.cancel}
            </button>
          </>
        }
      >
        <p>{en.queue.confirmRegenerate.message}</p>
        {regenerateDialogJob && (
          <p style={{ marginTop: '0.5rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
            SKU: <strong>{regenerateDialogJob.job.skuSnapshot}</strong>
          </p>
        )}
      </Modal>
    </div>
  );
}
