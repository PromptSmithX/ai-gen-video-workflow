import { useState, useEffect } from 'react';
import type { Category, ReviewStatus } from '@shared/domain';
import type { JobView } from '@shared/ipc';
import { getApi } from '../api';
import { en } from '../i18n/en';
import { useToast } from '../components/Toast';
import { Modal } from '../components/Modal';

export function Library(): React.JSX.Element {
  const { showToast } = useToast();
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Filters
  const [skuFilter, setSkuFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [fromFilter, setFromFilter] = useState('');
  const [toFilter, setToFilter] = useState('');
  const [templateVersionFilter, setTemplateVersionFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [reviewStatusFilter, setReviewStatusFilter] = useState<string>('');

  // Modals
  const [previewJob, setPreviewJob] = useState<JobView | null>(null);
  const [regenerateJob, setRegenerateJob] = useState<JobView | null>(null);
  const [pendingJobIds, setPendingJobIds] = useState<Set<string>>(new Set());

  const setJobPending = (jobId: string, pending: boolean) => {
    setPendingJobIds((prev) => {
      const next = new Set(prev);
      if (pending) next.add(jobId);
      else next.delete(jobId);
      return next;
    });
  };

  useEffect(() => {
    let active = true;
    const api = getApi();
    void Promise.all([
      api.jobs.list({
        sku: skuFilter.trim() || undefined,
        categoryId: categoryFilter || undefined,
        employeeId: employeeFilter.trim() || undefined,
        from: fromFilter ? new Date(fromFilter).toISOString() : undefined,
        to: toFilter ? new Date(toFilter).toISOString() : undefined,
        templateVersion: templateVersionFilter.trim() || undefined,
        reviewStatus: (reviewStatusFilter as ReviewStatus) || undefined,
        states: statusFilter ? [statusFilter] : undefined,
      }),
      api.catalog.listCategories(),
    ])
      .then(([jobsRes, catsRes]) => {
        if (!active) return;
        if (jobsRes.ok) setJobs(jobsRes.data);
        else setErrorMsg(jobsRes.error.message);

        if (catsRes.ok) setCategories(catsRes.data);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    skuFilter,
    categoryFilter,
    employeeFilter,
    fromFilter,
    toFilter,
    templateVersionFilter,
    statusFilter,
    reviewStatusFilter,
  ]);

  const handleClearFilters = () => {
    setSkuFilter('');
    setCategoryFilter('');
    setEmployeeFilter('');
    setFromFilter('');
    setToFilter('');
    setTemplateVersionFilter('');
    setStatusFilter('');
    setReviewStatusFilter('');
  };

  const handleOpenFolder = async (jobId: string) => {
    setJobPending(jobId, true);
    try {
      const api = getApi();
      const res = await api.library.openFolder({ jobId });
      if (res.ok) {
        showToast(en.library.toasts.folderOpened, 'success');
      } else {
        setErrorMsg(res.error.message);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    } finally {
      setJobPending(jobId, false);
    }
  };

  const handleCopyPath = async (jobId: string) => {
    setJobPending(jobId, true);
    try {
      const api = getApi();
      const res = await api.library.copyPath({ jobId });
      if (res.ok) {
        showToast(en.library.toasts.pathCopied, 'success');
      } else {
        setErrorMsg(res.error.message);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    } finally {
      setJobPending(jobId, false);
    }
  };

  const handleSetReview = async (jobId: string, status: ReviewStatus) => {
    setJobPending(jobId, true);
    try {
      const api = getApi();
      const res = await api.jobs.setReview({ jobId, status });
      if (res.ok) {
        setJobs((prev) => prev.map((j) => (j.job.id === jobId ? res.data : j)));
      } else {
        setErrorMsg(res.error.message);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    } finally {
      setJobPending(jobId, false);
    }
  };

  const handleConfirmRegenerate = async () => {
    if (!regenerateJob) return;
    const jobId = regenerateJob.job.id;
    setRegenerateJob(null);
    setJobPending(jobId, true);
    try {
      const api = getApi();
      const res = await api.jobs.regenerate({
        jobId,
        confirmed: true,
        clientRequestId: crypto.randomUUID(),
      });
      if (res.ok) {
        showToast('New generation job queued', 'success');
        const jobsRes = await api.jobs.list();
        if (jobsRes.ok) setJobs(jobsRes.data);
      } else {
        setErrorMsg(res.error.message);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    } finally {
      setJobPending(jobId, false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>{en.library.title}</h2>
      </div>

      {errorMsg && (
        <div className="card" style={{ backgroundColor: 'var(--danger-bg)', borderColor: 'var(--danger)' }}>
          <p className="error-text">{errorMsg}</p>
        </div>
      )}

      {/* Filters Bar */}
      <div className="filter-bar">
        <div className="filter-item">
          <label htmlFor="filter-sku">{en.library.filters.sku}</label>
          <input
            id="filter-sku"
            type="text"
            placeholder="e.g. TS-001"
            value={skuFilter}
            onChange={(e) => setSkuFilter(e.target.value)}
          />
        </div>

        <div className="filter-item">
          <label htmlFor="filter-category">{en.library.filters.category}</label>
          <select
            id="filter-category"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          >
            <option value="">{en.library.filters.allCategories}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-item">
          <label htmlFor="filter-employee">{en.library.filters.employee}</label>
          <input
            id="filter-employee"
            type="text"
            placeholder="Employee ID"
            value={employeeFilter}
            onChange={(e) => setEmployeeFilter(e.target.value)}
          />
        </div>

        <div className="filter-item">
          <label htmlFor="filter-from">{en.library.filters.from}</label>
          <input
            id="filter-from"
            type="date"
            value={fromFilter}
            onChange={(e) => setFromFilter(e.target.value)}
          />
        </div>

        <div className="filter-item">
          <label htmlFor="filter-to">{en.library.filters.to}</label>
          <input
            id="filter-to"
            type="date"
            value={toFilter}
            onChange={(e) => setToFilter(e.target.value)}
          />
        </div>

        <div className="filter-item">
          <label htmlFor="filter-version">{en.library.filters.templateVersion}</label>
          <input
            id="filter-version"
            type="text"
            placeholder="e.g. v2"
            value={templateVersionFilter}
            onChange={(e) => setTemplateVersionFilter(e.target.value)}
          />
        </div>

        <div className="filter-item">
          <label htmlFor="filter-review">{en.library.filters.reviewStatus}</label>
          <select
            id="filter-review"
            value={reviewStatusFilter}
            onChange={(e) => setReviewStatusFilter(e.target.value)}
          >
            <option value="">{en.library.filters.allReviews}</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>

        <div className="filter-item" style={{ alignSelf: 'flex-end' }}>
          <button type="button" className="btn-secondary btn-sm" onClick={handleClearFilters}>
            {en.library.filters.clear}
          </button>
        </div>
      </div>

      {/* Library Cards Grid */}
      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
          <div className="spinner" />
          <p style={{ marginTop: '0.75rem', color: 'var(--text-muted)' }}>{en.app.loading}</p>
        </div>
      ) : jobs.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
          <p style={{ color: 'var(--text-muted)' }}>{en.library.empty}</p>
        </div>
      ) : (
        <div className="library-grid">
          {jobs.map((item) => {
            const { job, category, productName, sourceUrl, videoUrl } = item;
            const isPending = pendingJobIds.has(job.id);

            return (
              <div key={job.id} className="library-card">
                {/* Side-by-side Source Mockup and Video (no autoplay) */}
                <div className="media-comparison">
                  {sourceUrl ? (
                    <img src={sourceUrl} alt={`Source for ${job.skuSnapshot}`} />
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
                      No image
                    </div>
                  )}

                  {videoUrl ? (
                    <video
                      controls
                      preload="metadata"
                      src={videoUrl}
                      aria-label={`Generated video for ${job.skuSnapshot}`}
                    />
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
                      No video
                    </div>
                  )}
                </div>

                {/* Card Details */}
                <div className="library-details">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <h3 style={{ fontSize: '1rem', fontWeight: 700 }}>{job.skuSnapshot}</h3>
                      {productName && <p className="info-text">{productName}</p>}
                    </div>
                    <span
                      className={`badge-status ${
                        job.reviewStatus === 'approved'
                          ? 'badge-status-succeeded'
                          : job.reviewStatus === 'rejected'
                            ? 'badge-status-failed'
                            : 'badge-status-neutral'
                      }`}
                    >
                      {en.library.card.review[job.reviewStatus]}
                    </span>
                  </div>

                  <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                    <div>
                      {en.library.card.category.replace('{category}', category)} • {job.promptTemplateId} (
                      {job.promptTemplateVersion})
                    </div>
                    <div>
                      {en.library.card.created.replace(
                        '{date}',
                        new Date(job.createdAt).toLocaleDateString(),
                      )}{' '}
                      by {job.employeeId}
                    </div>
                  </div>

                  {/* Actions Bar */}
                  <div className="library-actions">
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => setPreviewJob(item)}
                    >
                      {en.library.actions.preview}
                    </button>

                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      disabled={isPending}
                      onClick={() => handleOpenFolder(job.id)}
                    >
                      {en.library.actions.openFolder}
                    </button>

                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      disabled={isPending}
                      onClick={() => handleCopyPath(job.id)}
                    >
                      {en.library.actions.copyPath}
                    </button>

                    {job.reviewStatus !== 'approved' && (
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        style={{ color: 'var(--success)' }}
                        disabled={isPending}
                        onClick={() => handleSetReview(job.id, 'approved')}
                      >
                        {en.library.actions.approve}
                      </button>
                    )}

                    {job.reviewStatus !== 'rejected' && (
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        style={{ color: 'var(--danger)' }}
                        disabled={isPending}
                        onClick={() => handleSetReview(job.id, 'rejected')}
                      >
                        {en.library.actions.reject}
                      </button>
                    )}

                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      disabled={isPending}
                      onClick={() => setRegenerateJob(item)}
                    >
                      {en.library.actions.regenerate}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Large Preview Modal */}
      <Modal
        isOpen={previewJob !== null}
        onClose={() => setPreviewJob(null)}
        title={previewJob ? en.library.modal.title.replace('{sku}', previewJob.job.skuSnapshot) : ''}
        maxWidth="720px"
        footer={
          <button type="button" className="btn-secondary" onClick={() => setPreviewJob(null)}>
            {en.library.modal.close}
          </button>
        }
      >
        {previewJob && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', alignItems: 'center' }}>
            {previewJob.videoUrl ? (
              <video
                controls
                autoPlay={false}
                src={previewJob.videoUrl}
                style={{ width: '100%', maxHeight: '420px', borderRadius: 'var(--radius-md)', backgroundColor: '#000' }}
              />
            ) : (
              <p style={{ color: 'var(--text-muted)' }}>No video available</p>
            )}
            <div style={{ width: '100%', fontSize: '0.875rem' }}>
              <strong>SKU:</strong> {previewJob.job.skuSnapshot} • <strong>Category:</strong> {previewJob.category} •{' '}
              <strong>Template:</strong> {previewJob.job.promptTemplateId} ({previewJob.job.promptTemplateVersion})
            </div>
          </div>
        )}
      </Modal>

      {/* Confirm Regenerate Dialog */}
      <Modal
        isOpen={regenerateJob !== null}
        onClose={() => setRegenerateJob(null)}
        title={en.queue.confirmRegenerate.title}
        footer={
          <>
            <button type="button" className="btn-primary" onClick={handleConfirmRegenerate}>
              {en.queue.confirmRegenerate.confirm}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setRegenerateJob(null)}
            >
              {en.queue.confirmRegenerate.cancel}
            </button>
          </>
        }
      >
        <p>{en.queue.confirmRegenerate.message}</p>
        {regenerateJob && (
          <p style={{ marginTop: '0.5rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
            SKU: <strong>{regenerateJob.job.skuSnapshot}</strong>
          </p>
        )}
      </Modal>
    </div>
  );
}
