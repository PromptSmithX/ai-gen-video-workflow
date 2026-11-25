import type { AppInfo } from '@shared/ipc';
import { en } from '../i18n/en';

export type ScreenId = 'create' | 'queue' | 'library' | 'admin';

interface SidebarProps {
  currentScreen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  appInfo: AppInfo | null;
  activeJobsCount: number;
}

export function Sidebar({
  currentScreen,
  onNavigate,
  appInfo,
  activeJobsCount,
}: SidebarProps): React.JSX.Element {
  const isAdmin = appInfo?.isAdmin ?? false;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-title">
          <span>🎬</span>
          <span>{en.app.title}</span>
        </div>
      </div>
      <nav className="sidebar-nav" aria-label="Main Navigation">
        <button
          type="button"
          className={`nav-link ${currentScreen === 'create' ? 'active' : ''}`}
          onClick={() => onNavigate('create')}
        >
          <span>{en.nav.create}</span>
        </button>

        <button
          type="button"
          className={`nav-link ${currentScreen === 'queue' ? 'active' : ''}`}
          onClick={() => onNavigate('queue')}
        >
          <span>{en.nav.queue}</span>
          {activeJobsCount > 0 && <span className="nav-badge">{activeJobsCount}</span>}
        </button>

        <button
          type="button"
          className={`nav-link ${currentScreen === 'library' ? 'active' : ''}`}
          onClick={() => onNavigate('library')}
        >
          <span>{en.nav.library}</span>
        </button>

        {isAdmin && (
          <button
            type="button"
            className={`nav-link ${currentScreen === 'admin' ? 'active' : ''}`}
            onClick={() => onNavigate('admin')}
          >
            <span>{en.nav.admin}</span>
          </button>
        )}
      </nav>
      <div className="sidebar-footer">
        <span>v{appInfo?.version ?? '0.1.0'}</span>
        {appInfo?.providerMode && <span style={{ marginLeft: '0.5rem' }}>({appInfo.providerMode})</span>}
      </div>
    </aside>
  );
}
