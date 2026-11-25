import { useState, useEffect, useCallback } from 'react';
import type { AppInfo, ProviderStatus, JobView } from '@shared/ipc';
import { ACTIVE_JOB_STATES } from '@shared/job-state';
import { getApi, isBackendUnavailable } from './api';
import { en } from './i18n/en';
import { ToastProvider } from './components/Toast';
import { Sidebar, type ScreenId } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { CreateVideo } from './screens/CreateVideo';
import { Queue } from './screens/Queue';
import { Library } from './screens/Library';
import { Admin } from './screens/Admin';
import { Setup, needsSetup } from './screens/Setup';
import './styles.css';

export function App(): React.JSX.Element {
  if (isBackendUnavailable()) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          backgroundColor: 'var(--bg-app)',
          padding: '1.5rem',
        }}
      >
        <div
          className="card"
          style={{
            maxWidth: '500px',
            textAlign: 'center',
            padding: '2.5rem 2rem',
            borderColor: 'var(--danger)',
          }}
        >
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠️</div>
          <h1
            style={{
              fontSize: '1.35rem',
              fontWeight: 700,
              color: 'var(--danger)',
              marginBottom: '0.75rem',
            }}
          >
            {en.app.backendUnavailable}
          </h1>
          <p className="info-text">{en.app.backendUnavailableDesc}</p>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}

function AppContent(): React.JSX.Element {
  const [currentScreen, setCurrentScreen] = useState<ScreenId>('create');
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [activeJobsCount, setActiveJobsCount] = useState<number>(0);
  const [highlightJobId, setHighlightJobId] = useState<string | null>(null);

  // Initial app load: getInfo, getStatus, count active jobs
  useEffect(() => {
    let active = true;
    const api = getApi();

    void Promise.all([api.app.getInfo(), api.provider.getStatus(), api.jobs.list()])
      .then(([infoRes, statusRes, jobsRes]) => {
        if (!active) return;
        if (infoRes.ok) setAppInfo(infoRes.data);
        if (statusRes.ok) setProviderStatus(statusRes.data);
        if (jobsRes.ok) {
          const count = jobsRes.data.filter((j) => ACTIVE_JOB_STATES.includes(j.job.state)).length;
          setActiveJobsCount(count);
        }
      })
      .catch(() => {
        // handled gracefully
      });

    const unsubscribe = api.jobs.onUpdated((_updatedView: JobView) => {
      // Refresh count on job updates
      api.jobs.list().then((res) => {
        if (res.ok && active) {
          const count = res.data.filter((j) => ACTIVE_JOB_STATES.includes(j.job.state)).length;
          setActiveJobsCount(count);
        }
      });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const handleJobCreated = useCallback((jobId: string) => {
    setHighlightJobId(jobId);
    setCurrentScreen('queue');
    setActiveJobsCount((prev) => prev + 1);
  }, []);

  const handleNavigate = (screen: ScreenId) => {
    // If navigating to something other than queue, clear highlight
    if (screen !== 'queue') {
      setHighlightJobId(null);
    }
    // Prevent non-admin navigation to admin
    if (screen === 'admin' && !appInfo?.isAdmin) {
      setCurrentScreen('create');
      return;
    }
    setCurrentScreen(screen);
  };

  // Bundled Muse4AI not ready yet: the Setup screen replaces the work screens (Admin stays reachable).
  const showSetup = needsSetup(providerStatus) && currentScreen !== 'admin';

  const getScreenTitle = () => {
    if (showSetup) return en.setup.title;
    switch (currentScreen) {
      case 'create':
        return en.nav.create;
      case 'queue':
        return en.nav.queue;
      case 'library':
        return en.nav.library;
      case 'admin':
        return en.nav.admin;
    }
  };

  return (
    <div className="app-container">
      <Sidebar
        currentScreen={currentScreen}
        onNavigate={handleNavigate}
        appInfo={appInfo}
        activeJobsCount={activeJobsCount}
      />

      <div className="main-wrapper">
        <TopBar
          title={getScreenTitle()}
          appInfo={appInfo}
          providerStatus={providerStatus}
          onProviderStatusChange={(updated) => setProviderStatus(updated)}
        />

        <main className="content-area">
          {showSetup && providerStatus && (
            <Setup status={providerStatus} onStatusChange={setProviderStatus} />
          )}

          {!showSetup && currentScreen === 'create' && (
            <CreateVideo
              providerStatus={providerStatus}
              onJobCreated={handleJobCreated}
            />
          )}

          {!showSetup && currentScreen === 'queue' && <Queue highlightJobId={highlightJobId} />}

          {!showSetup && currentScreen === 'library' && <Library />}

          {currentScreen === 'admin' && (
            <Admin
              isAdmin={appInfo?.isAdmin ?? false}
              providerStatus={providerStatus}
              onProviderStatusChange={(updated) => setProviderStatus(updated)}
            />
          )}
        </main>
      </div>
    </div>
  );
}
