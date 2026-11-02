import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from './auth';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Moderation } from './pages/Moderation';
import { Reports } from './pages/Reports';
import { Providers } from './pages/Providers';
import { Uploads } from './pages/Uploads';
import { Users } from './pages/Users';
import { Audit } from './pages/Audit';
import { Settings } from './pages/Settings';

interface RouteDefinition {
  id: string;
  label: string;
  description: string;
  adminOnly: boolean;
}

const ROUTES: RouteDefinition[] = [
  { id: 'overview', label: 'Overview', description: 'Catalogue, users, storage and failures at a glance.', adminOnly: false },
  { id: 'review', label: 'Review queue', description: 'Approve, reject or remove uploads before they reach the library.', adminOnly: false },
  { id: 'reports', label: 'Reports', description: 'Listener reports and their resolution.', adminOnly: false },
  { id: 'uploads', label: 'Uploads & errors', description: 'Failed uploads and playback errors reported by clients.', adminOnly: false },
  { id: 'storage', label: 'Storage', description: 'Providers, health probes, capacity and integrity.', adminOnly: true },
  { id: 'users', label: 'Users', description: 'Roles, suspensions and per-user upload quotas.', adminOnly: true },
  { id: 'settings', label: 'Settings', description: 'Upload limits, streaming TTLs and publishing policy.', adminOnly: true },
  { id: 'audit', label: 'Audit log', description: 'Every privileged action, with actor and target.', adminOnly: true },
];

function readHash(): string {
  const raw = window.location.hash.replace(/^#\/?/, '').trim();
  return raw || 'overview';
}

function useHashRoute(): [string, (route: string) => void] {
  const [route, setRoute] = useState(readHash);

  useEffect(() => {
    const onChange = () => setRoute(readHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((next: string) => {
    window.location.hash = `#/${next}`;
    setRoute(next);
  }, []);

  return [route, navigate];
}

export function App() {
  const { user, loading, signedOut, isAdmin, isStaff, logout } = useAuth();
  const [route, navigate] = useHashRoute();

  const visibleRoutes = useMemo(() => ROUTES.filter((entry) => isAdmin || !entry.adminOnly), [isAdmin]);

  useEffect(() => {
    if (!isStaff) return;
    const allowed = ROUTES.filter((entry) => isAdmin || !entry.adminOnly).map((entry) => entry.id);
    if (!allowed.includes(route)) navigate(allowed[0] ?? 'overview');
  }, [route, isAdmin, isStaff, navigate]);

  if (loading) {
    return (
      <div className="login-wrap">
        <div className="muted">Checking your session…</div>
      </div>
    );
  }

  if (signedOut || !user || !isStaff) return <Login />;

  const active = ROUTES.find((entry) => entry.id === route) ?? ROUTES[0]!;
  const canViewActive = isAdmin || !active.adminOnly;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true" />
          <div>
            <div className="brand-name">AETHER</div>
            <span className="brand-sub">Cloud console</span>
          </div>
        </div>

        <nav className="nav" aria-label="Console sections">
          {visibleRoutes.map((entry) => (
            <a
              key={entry.id}
              href={`#/${entry.id}`}
              className={`nav-item ${entry.id === route ? 'active' : ''}`}
              aria-current={entry.id === route ? 'page' : undefined}
            >
              {entry.label}
            </a>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span>
            Signed in as <strong>{user.role}</strong>
          </span>
          <span className="mono">{user.email}</span>
          <a
            href="#/overview"
            onClick={(event) => {
              event.preventDefault();
              void logout();
            }}
          >
            Sign out
          </a>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div>
            <h1 className="page-title">{active.label}</h1>
            <p className="page-subtitle">{active.description}</p>
          </div>
          <div className="user-chip">
            <div className="avatar" aria-hidden="true">
              {(user.displayName || user.email).slice(0, 1).toUpperCase()}
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{user.displayName || user.email}</div>
              <div className="small muted">{user.role}</div>
            </div>
          </div>
        </div>

        {!canViewActive ? (
          <div className="banner">This section requires the administrator role.</div>
        ) : (
          <PageFor route={route} navigate={navigate} />
        )}
      </main>
    </div>
  );
}

function PageFor({ route, navigate }: { route: string; navigate: (route: string) => void }) {
  switch (route) {
    case 'review':
      return <Moderation />;
    case 'reports':
      return <Reports />;
    case 'uploads':
      return <Uploads />;
    case 'storage':
      return <Providers />;
    case 'users':
      return <Users />;
    case 'settings':
      return <Settings />;
    case 'audit':
      return <Audit />;
    case 'overview':
    default:
      return <Overview onNavigate={navigate} />;
  }
}
