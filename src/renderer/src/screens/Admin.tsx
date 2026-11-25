import { useState, useEffect } from 'react';
import type { Category } from '@shared/domain';
import type { PromptTemplate, PromptTemplateSummary, QualityReport } from '@shared/prompt';
import type { DiagnosticsPreview, ProviderStatus } from '@shared/ipc';
import { getApi } from '../api';
import { en } from '../i18n/en';
import { useToast } from '../components/Toast';

interface AdminProps {
  isAdmin: boolean;
  providerStatus: ProviderStatus | null;
  onProviderStatusChange: (status: ProviderStatus) => void;
}

type AdminTab = 'provider' | 'promptMaster' | 'categories' | 'diagnostics';

export function Admin({
  isAdmin,
  providerStatus,
  onProviderStatusChange,
}: AdminProps): React.JSX.Element | null {
  const { showToast } = useToast();

  // If not admin, do not render Admin screen!
  if (!isAdmin) {
    return (
      <div className="card" style={{ backgroundColor: 'var(--danger-bg)', borderColor: 'var(--danger)' }}>
        <p className="error-text" style={{ fontWeight: 600 }}>
          {en.admin.accessDenied}
        </p>
      </div>
    );
  }

  return (
    <AdminContent
      providerStatus={providerStatus}
      onProviderStatusChange={onProviderStatusChange}
      showToast={showToast}
    />
  );
}

function AdminContent({
  providerStatus,
  onProviderStatusChange,
  showToast,
}: {
  providerStatus: ProviderStatus | null;
  onProviderStatusChange: (status: ProviderStatus) => void;
  showToast: (msg: string, type?: 'info' | 'success' | 'error') => void;
}): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<AdminTab>('provider');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Provider inputs
  const [bridgeBaseUrl, setBridgeBaseUrl] = useState('');
  const [platformOrigin, setPlatformOrigin] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [testingConnection, setTestingConnection] = useState(false);

  // Storage & Categories inputs
  const [libraryRoot, setLibraryRoot] = useState('');
  const [logRetentionDays, setLogRetentionDays] = useState(30);
  const [adminUsersStr, setAdminUsersStr] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [newCatId, setNewCatId] = useState('');
  const [newCatLabel, setNewCatLabel] = useState('');
  const [newCatGroup, setNewCatGroup] = useState<Category['promptGroup']>('apparel');

  // Prompt Master inputs
  const [templates, setTemplates] = useState<PromptTemplateSummary[]>([]);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState('');
  const [activeTemplate, setActiveTemplate] = useState<PromptTemplate | null>(null);
  const [newVersionTitle, setNewVersionTitle] = useState('');
  const [newVersionNote, setNewVersionNote] = useState('');
  const [newVersionBody, setNewVersionBody] = useState('');
  const [validationReport, setValidationReport] = useState<QualityReport | null>(null);
  const [templateErrors, setTemplateErrors] = useState<string[]>([]);

  // Diagnostics
  const [diagnostics, setDiagnostics] = useState<DiagnosticsPreview | null>(null);

  useEffect(() => {
    let active = true;
    const api = getApi();
    void Promise.all([api.admin.getSettings(), api.prompts.listTemplates()])
      .then(([settingsRes, tplsRes]) => {
        if (!active) return;
        if (settingsRes.ok) {
          const s = settingsRes.data;
          setBridgeBaseUrl(s.bridgeBaseUrl ?? '');
          setPlatformOrigin(s.musePlatformOrigin ?? '');
          setLibraryRoot(s.libraryRoot);
          setLogRetentionDays(s.logRetentionDays);
          setAdminUsersStr(s.adminUsers.join(', '));
          setCategories(s.categories);
        } else {
          setErrorMsg(settingsRes.error.message);
        }

        if (tplsRes.ok && tplsRes.data.length > 0) {
          setTemplates(tplsRes.data);
          const first = tplsRes.data[0];
          if (first) setSelectedTemplateKey(`${first.id}@@${first.version}`);
        }
      })
      .catch((err) => {
        if (!active) return;
        setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
      });

    return () => {
      active = false;
    };
  }, []);

  // Load selected template details
  useEffect(() => {
    if (!selectedTemplateKey) return;
    const [id, version] = selectedTemplateKey.split('@@');
    if (!id) return;
    let active = true;
    const api = getApi();
    void api.prompts.getTemplate({ id, version }).then((res) => {
      if (!active) return;
      if (res.ok) {
        setActiveTemplate(res.data);
        setNewVersionTitle(res.data.title);
        setNewVersionBody(res.data.body);
        setNewVersionNote('');
      }
    });
    return () => {
      active = false;
    };
  }, [selectedTemplateKey]);

  // Validate new template body as employee types (debounced 300ms)
  useEffect(() => {
    if (!newVersionBody) return;
    const timer = setTimeout(async () => {
      const api = getApi();
      const res = await api.prompts.validate({ text: newVersionBody });
      if (res.ok) {
        setValidationReport(res.data.quality);
        setTemplateErrors(res.data.errors);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [newVersionBody]);

  // Provider test connection
  const handleTestConnection = async () => {
    setTestingConnection(true);
    setErrorMsg(null);
    try {
      const api = getApi();
      const res = await api.provider.testConnection();
      if (res.ok) {
        onProviderStatusChange(res.data);
        showToast('Connection test succeeded', 'success');
      } else {
        setErrorMsg(res.error.message);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    } finally {
      setTestingConnection(false);
    }
  };

  // Provider save settings (bridge URL + platform origin)
  const handleSaveProviderSettings = async () => {
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const api = getApi();
      const res = await api.admin.updateSettings({
        bridgeBaseUrl: bridgeBaseUrl.trim() || null,
        musePlatformOrigin: platformOrigin.trim() || null,
      });
      if (res.ok) {
        showToast(en.admin.provider.savedSuccess, 'success');
      } else {
        setErrorMsg(res.error.message);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    }
  };

  // API Key set / clear
  const handleSetApiKey = async () => {
    if (!newApiKey) return;
    setErrorMsg(null);
    try {
      const api = getApi();
      const res = await api.admin.setBridgeApiKey({ apiKey: newApiKey });
      if (res.ok) {
        setNewApiKey('');
        showToast('API key saved securely.', 'success');
        const stRes = await api.provider.getStatus();
        if (stRes.ok) onProviderStatusChange(stRes.data);
      } else {
        setErrorMsg(res.error.message);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    }
  };

  const handleClearApiKey = async () => {
    setErrorMsg(null);
    try {
      const api = getApi();
      const res = await api.admin.clearBridgeApiKey();
      if (res.ok) {
        showToast('API key cleared.', 'info');
        const stRes = await api.provider.getStatus();
        if (stRes.ok) onProviderStatusChange(stRes.data);
      } else {
        setErrorMsg(res.error.message);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    }
  };

  // Template actions
  const handleSaveTemplateVersion = async () => {
    if (!activeTemplate || !newVersionBody) return;
    setErrorMsg(null);
    try {
      const api = getApi();
      const res = await api.prompts.saveVersion({
        id: activeTemplate.id,
        title: newVersionTitle.trim() || undefined,
        note: newVersionNote.trim() || undefined,
        body: newVersionBody,
      });
      if (res.ok) {
        showToast(`Saved version ${res.data.version}`, 'success');
        const tplsRes = await api.prompts.listTemplates();
        if (tplsRes.ok) setTemplates(tplsRes.data);
      } else {
        setErrorMsg(res.error.message);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    }
  };

  const handleSetDefaultTemplate = async () => {
    if (!activeTemplate) return;
    setErrorMsg(null);
    try {
      const api = getApi();
      const res = await api.prompts.setDefault({
        id: activeTemplate.id,
        version: activeTemplate.version,
      });
      if (res.ok) {
        showToast(`Template ${activeTemplate.id} (${activeTemplate.version}) set as default`, 'success');
        const tplsRes = await api.prompts.listTemplates();
        if (tplsRes.ok) setTemplates(tplsRes.data);
      } else {
        setErrorMsg(res.error.message);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    }
  };

  // Categories & Storage save
  const handleAddCategory = () => {
    if (!newCatId || !newCatLabel) return;
    const cleanId = newCatId.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (categories.some((c) => c.id === cleanId)) {
      setErrorMsg('Category ID already exists');
      return;
    }
    const updated = [...categories, { id: cleanId, label: newCatLabel.trim(), promptGroup: newCatGroup }];
    setCategories(updated);
    setNewCatId('');
    setNewCatLabel('');
  };

  const handleRemoveCategory = (id: string) => {
    setCategories((prev) => prev.filter((c) => c.id !== id));
  };

  const handleSaveStorageSettings = async () => {
    setErrorMsg(null);
    try {
      const api = getApi();
      const adminUsers = adminUsersStr
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean);
      const res = await api.admin.updateSettings({
        libraryRoot: libraryRoot.trim(),
        logRetentionDays: Number(logRetentionDays),
        categories,
        adminUsers,
      });
      if (res.ok) {
        showToast('Storage & Category settings saved', 'success');
      } else {
        setErrorMsg(res.error.message);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    }
  };

  // Diagnostics actions
  const handlePreviewDiagnostics = async () => {
    setErrorMsg(null);
    try {
      const api = getApi();
      const res = await api.admin.diagnosticsPreview();
      if (res.ok) {
        setDiagnostics(res.data);
      } else {
        setErrorMsg(res.error.message);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    }
  };

  const handleExportDiagnostics = async () => {
    setErrorMsg(null);
    try {
      const api = getApi();
      const res = await api.admin.diagnosticsExport();
      if (res.ok && res.data.saved) {
        showToast('Diagnostics exported successfully.', 'success');
      } else if (!res.ok) {
        setErrorMsg(res.error.message);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    }
  };

  const handleRunCleanup = async () => {
    setErrorMsg(null);
    try {
      const api = getApi();
      const res = await api.admin.runCleanup();
      if (res.ok) {
        showToast(
          en.admin.diagnostics.cleanupResult
            .replace('{logs}', String(res.data.removedLogFiles))
            .replace('{temp}', String(res.data.removedTempFiles)),
          'success',
        );
      } else {
        setErrorMsg(res.error.message);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : en.errors.generic);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>{en.admin.title}</h2>
      </div>

      {errorMsg && (
        <div className="card" style={{ backgroundColor: 'var(--danger-bg)', borderColor: 'var(--danger)' }}>
          <p className="error-text">{errorMsg}</p>
        </div>
      )}
      {statusMsg && (
        <div className="card" style={{ backgroundColor: 'var(--success-bg)', borderColor: 'var(--success)' }}>
          <p style={{ color: 'var(--success)', fontWeight: 600 }}>{statusMsg}</p>
        </div>
      )}

      {/* Tabs */}
      <div className="admin-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'provider'}
          className={`admin-tab ${activeTab === 'provider' ? 'active' : ''}`}
          onClick={() => setActiveTab('provider')}
        >
          {en.admin.tabs.provider}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'promptMaster'}
          className={`admin-tab ${activeTab === 'promptMaster' ? 'active' : ''}`}
          onClick={() => setActiveTab('promptMaster')}
        >
          {en.admin.tabs.promptMaster}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'categories'}
          className={`admin-tab ${activeTab === 'categories' ? 'active' : ''}`}
          onClick={() => setActiveTab('categories')}
        >
          {en.admin.tabs.categories}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'diagnostics'}
          className={`admin-tab ${activeTab === 'diagnostics' ? 'active' : ''}`}
          onClick={() => setActiveTab('diagnostics')}
        >
          {en.admin.tabs.diagnostics}
        </button>
      </div>

      {/* Tab 1: Provider Configuration */}
      {activeTab === 'provider' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="card">
            <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>
              {en.admin.provider.title}
            </h3>

            {/* Provider status details */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '180px 1fr',
                gap: '0.5rem',
                fontSize: '0.875rem',
                marginBottom: '1.5rem',
                padding: '0.75rem',
                backgroundColor: 'var(--bg-subtle)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <strong>{en.provider.mode}:</strong>
              <span>{providerStatus?.mode ?? '—'}</span>

              <strong>{en.provider.connectionState}:</strong>
              <span style={{ textTransform: 'capitalize' }}>
                {providerStatus ? en.provider.state[providerStatus.state] ?? providerStatus.state : '—'}
              </span>

              <strong>{en.provider.compatibility}:</strong>
              <span style={{ textTransform: 'capitalize' }}>{providerStatus?.compatibility ?? '—'}</span>

              <strong>{en.provider.hasApiKey}:</strong>
              <span>{providerStatus?.hasApiKey ? en.provider.configured : en.provider.notConfigured}</span>

              <strong>{en.provider.secretStore}:</strong>
              <span>{providerStatus?.secretStoreAvailable ? en.provider.available : en.provider.unavailable}</span>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <button
                type="button"
                className="btn-secondary"
                disabled={testingConnection}
                onClick={handleTestConnection}
              >
                {testingConnection ? en.app.loading : en.provider.testConnection}
              </button>
            </div>

            {/* URL settings form */}
            <div className="form-group">
              <label htmlFor="bridge-url">{en.admin.provider.bridgeUrl}</label>
              <input
                id="bridge-url"
                type="text"
                placeholder={en.admin.provider.bridgeUrlPlaceholder}
                value={bridgeBaseUrl}
                onChange={(e) => setBridgeBaseUrl(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label htmlFor="platform-origin">{en.admin.provider.origin}</label>
              <input
                id="platform-origin"
                type="text"
                placeholder={en.admin.provider.originPlaceholder}
                value={platformOrigin}
                onChange={(e) => setPlatformOrigin(e.target.value)}
              />
            </div>

            <div style={{ marginTop: '0.5rem', marginBottom: '1.5rem' }}>
              <button type="button" className="btn-primary" onClick={handleSaveProviderSettings}>
                {en.admin.provider.saveSettings}
              </button>
            </div>

            <hr style={{ border: 'none', borderTop: '1px solid var(--border-color)', margin: '1.5rem 0' }} />

            {/* API Key management */}
            <h4 style={{ fontSize: '0.9375rem', fontWeight: 600, marginBottom: '0.5rem' }}>
              {en.admin.provider.apiKey}
            </h4>

            {providerStatus?.hasApiKey && (
              <p className="info-text" style={{ color: 'var(--success)', marginBottom: '0.75rem' }}>
                ✓ {en.admin.provider.apiKeySaved}
              </p>
            )}

            {!providerStatus?.secretStoreAvailable && (
              <div
                style={{
                  backgroundColor: 'var(--danger-bg)',
                  padding: '0.75rem',
                  borderRadius: 'var(--radius-md)',
                  marginBottom: '1rem',
                }}
              >
                <p className="error-text">{en.admin.provider.secretStoreWarning}</p>
              </div>
            )}

            <div className="form-group">
              <input
                id="api-key-input"
                type="password"
                placeholder={en.admin.provider.apiKeyPlaceholder}
                value={newApiKey}
                disabled={!providerStatus?.secretStoreAvailable}
                onChange={(e) => setNewApiKey(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button
                type="button"
                className="btn-primary"
                disabled={!providerStatus?.secretStoreAvailable || !newApiKey}
                onClick={handleSetApiKey}
              >
                {en.admin.provider.setApiKey}
              </button>
              {providerStatus?.hasApiKey && (
                <button type="button" className="btn-secondary" onClick={handleClearApiKey}>
                  {en.admin.provider.clearApiKey}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: Prompt Master */}
      {activeTab === 'promptMaster' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="card">
            <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>
              {en.admin.promptMaster.title}
            </h3>

            {/* Template selector */}
            <div className="form-group">
              <label htmlFor="admin-tpl-select">{en.admin.promptMaster.templatesList}</label>
              <select
                id="admin-tpl-select"
                value={selectedTemplateKey}
                onChange={(e) => setSelectedTemplateKey(e.target.value)}
              >
                {templates.map((tpl) => (
                  <option key={`${tpl.id}@@${tpl.version}`} value={`${tpl.id}@@${tpl.version}`}>
                    {tpl.title} — {tpl.version} {tpl.isDefault ? '[DEFAULT]' : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* View body (Read-only) */}
            <div className="form-group">
              <label>{en.admin.promptMaster.viewBody}</label>
              <div className="prompt-box" style={{ maxHeight: '140px' }}>
                {activeTemplate?.body}
              </div>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <button
                type="button"
                className="btn-secondary btn-sm"
                disabled={activeTemplate?.isDefault}
                onClick={handleSetDefaultTemplate}
              >
                {en.admin.promptMaster.setDefault}
              </button>
            </div>

            <hr style={{ border: 'none', borderTop: '1px solid var(--border-color)', margin: '1.5rem 0' }} />

            {/* Save New Version Editor */}
            <h4 style={{ fontSize: '0.9375rem', fontWeight: 600, marginBottom: '1rem' }}>
              {en.admin.promptMaster.saveNewVersion}
            </h4>

            <div className="form-group">
              <label htmlFor="tpl-version-title">{en.admin.promptMaster.versionTitle}</label>
              <input
                id="tpl-version-title"
                type="text"
                value={newVersionTitle}
                onChange={(e) => setNewVersionTitle(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label htmlFor="tpl-version-note">{en.admin.promptMaster.versionNote}</label>
              <input
                id="tpl-version-note"
                type="text"
                placeholder="e.g. Added garment seam stability instructions"
                value={newVersionNote}
                onChange={(e) => setNewVersionNote(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label htmlFor="tpl-version-body">{en.admin.promptMaster.newBody}</label>
              <textarea
                id="tpl-version-body"
                rows={6}
                value={newVersionBody}
                onChange={(e) => setNewVersionBody(e.target.value)}
                style={{ fontFamily: 'monospace', fontSize: '0.8125rem' }}
              />
            </div>

            {/* Validation & Quality preview */}
            {templateErrors.length > 0 && (
              <div
                style={{
                  backgroundColor: 'var(--danger-bg)',
                  padding: '0.75rem',
                  borderRadius: 'var(--radius-md)',
                  marginBottom: '1rem',
                }}
              >
                <strong style={{ fontSize: '0.8125rem', color: 'var(--danger)' }}>Validation Errors:</strong>
                <ul style={{ paddingLeft: '1.25rem', fontSize: '0.8125rem', color: 'var(--danger)' }}>
                  {templateErrors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              </div>
            )}

            {validationReport && (
              <div style={{ marginBottom: '1rem' }}>
                <h5 style={{ fontSize: '0.8125rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                  {en.admin.promptMaster.qualityPreview}
                </h5>
                <div className="quality-checklist">
                  {validationReport.checks.map((chk) => (
                    <div
                      key={chk.rule}
                      className={`quality-item ${chk.passed ? 'passed' : 'failed'}`}
                    >
                      <span>{chk.passed ? '✓' : '✗'}</span>
                      <span>{chk.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button
              type="button"
              className="btn-primary"
              disabled={!newVersionBody || templateErrors.length > 0}
              onClick={handleSaveTemplateVersion}
            >
              {en.admin.promptMaster.saveButton}
            </button>
          </div>
        </div>
      )}

      {/* Tab 3: Categories & Storage */}
      {activeTab === 'categories' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="card">
            <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>
              {en.admin.categories.title}
            </h3>

            {/* Category list */}
            <h4 style={{ fontSize: '0.9375rem', fontWeight: 600, marginBottom: '0.5rem' }}>
              {en.admin.categories.categoryList}
            </h4>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
              {categories.map((c) => (
                <div
                  key={c.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.5rem 0.75rem',
                    backgroundColor: 'var(--bg-subtle)',
                    borderRadius: 'var(--radius-md)',
                  }}
                >
                  <div>
                    <strong>{c.label}</strong>{' '}
                    <span className="info-text">
                      (ID: {c.id} • Group: {c.promptGroup})
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn-danger btn-sm"
                    onClick={() => handleRemoveCategory(c.id)}
                  >
                    {en.admin.categories.removeCat}
                  </button>
                </div>
              ))}
            </div>

            {/* Add category row */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr auto',
                gap: '0.5rem',
                alignItems: 'center',
                marginBottom: '1.5rem',
              }}
            >
              <input
                type="text"
                placeholder={en.admin.categories.catId}
                value={newCatId}
                onChange={(e) => setNewCatId(e.target.value)}
              />
              <input
                type="text"
                placeholder={en.admin.categories.catLabel}
                value={newCatLabel}
                onChange={(e) => setNewCatLabel(e.target.value)}
              />
              <select
                value={newCatGroup}
                onChange={(e) => setNewCatGroup(e.target.value as Category['promptGroup'])}
              >
                <option value="apparel">Apparel</option>
                <option value="drinkware">Drinkware</option>
                <option value="home-decor">Home Decor</option>
                <option value="calendar">Calendar</option>
                <option value="other">Other</option>
              </select>
              <button type="button" className="btn-secondary" onClick={handleAddCategory}>
                {en.admin.categories.addCategory}
              </button>
            </div>

            <hr style={{ border: 'none', borderTop: '1px solid var(--border-color)', margin: '1.5rem 0' }} />

            {/* Storage roots & Admins */}
            <div className="form-group">
              <label htmlFor="library-root">{en.admin.categories.libraryRoot}</label>
              <input
                id="library-root"
                type="text"
                value={libraryRoot}
                onChange={(e) => setLibraryRoot(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label htmlFor="log-retention">{en.admin.categories.logRetentionDays}</label>
              <input
                id="log-retention"
                type="number"
                min={1}
                max={365}
                value={logRetentionDays}
                onChange={(e) => setLogRetentionDays(Number(e.target.value))}
              />
            </div>

            <div className="form-group">
              <label htmlFor="admin-users">{en.admin.categories.adminUsers}</label>
              <input
                id="admin-users"
                type="text"
                value={adminUsersStr}
                onChange={(e) => setAdminUsersStr(e.target.value)}
              />
            </div>

            <button type="button" className="btn-primary" onClick={handleSaveStorageSettings}>
              {en.admin.categories.saveCategories}
            </button>
          </div>
        </div>
      )}

      {/* Tab 4: Diagnostics & Maintenance */}
      {activeTab === 'diagnostics' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="card">
            <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>
              {en.admin.diagnostics.title}
            </h3>

            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem' }}>
              <button type="button" className="btn-secondary" onClick={handlePreviewDiagnostics}>
                {en.admin.diagnostics.previewButton}
              </button>
              <button type="button" className="btn-secondary" onClick={handleExportDiagnostics}>
                {en.admin.diagnostics.exportButton}
              </button>
              <button type="button" className="btn-danger" onClick={handleRunCleanup}>
                {en.admin.diagnostics.cleanupButton}
              </button>
            </div>

            {diagnostics && (
              <div>
                <p className="info-text" style={{ marginBottom: '0.5rem' }}>
                  Generated: {new Date(diagnostics.generatedAt).toLocaleString()}
                </p>
                <pre className="diagnostics-pre">{diagnostics.content}</pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
