import { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './store/AuthContext';
import { AppProvider } from './store/AppContext';
import { HomeScreen } from './screens/HomeScreen';
import { AddServiceScreen } from './screens/AddServiceScreen';
import { ServiceDetailScreen } from './screens/ServiceDetailScreen';
import { ImportDocumentScreen } from './screens/ImportDocumentScreen';
import { DocDetailScreen } from './screens/DocDetailScreen';
import { AddBillScreen } from './screens/AddBillScreen';
import { DashboardScreen } from './screens/DashboardScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { LoginScreen } from './screens/LoginScreen';
import { setCloudMode } from './platform/storage';
import './styles.css';

type Route =
  | { page: 'home' }
  | { page: 'add-service' }
  | { page: 'edit-service'; id: string }
  | { page: 'service'; id: string }
  | { page: 'import-doc'; serviceId?: string }
  | { page: 'doc-detail'; serviceId: string; docId: string }
  | { page: 'add-bill'; serviceId: string }
  | { page: 'dashboard' }
  | { page: 'settings' };

function AppContent() {
  const { user, isCloudMode, signOut } = useAuth();
  const [route, setRoute] = useState<Route>({ page: 'home' });
  const [history, setHistory] = useState<Route[]>([]);

  const navigate = (page: string, params: Record<string, string> = {}) => {
    setHistory(prev => [...prev, route]);
    setRoute({ page, ...params } as Route);
  };

  const goBack = () => {
    const prev = history[history.length - 1];
    if (prev) {
      setHistory(h => h.slice(0, -1));
      setRoute(prev);
    } else {
      setRoute({ page: 'home' });
    }
  };

  const goHome = () => {
    setHistory([]);
    setRoute({ page: 'home' });
  };

  let content: React.ReactNode;

  switch (route.page) {
    case 'home':
      content = <HomeScreen onNavigate={navigate} />;
      break;
    case 'add-service':
      content = <AddServiceScreen onDone={goBack} />;
      break;
    case 'edit-service':
      content = <AddServiceScreen editId={(route as any).id} onDone={goBack} />;
      break;
    case 'service':
      content = (
        <ServiceDetailScreen
          serviceId={(route as any).id}
          onNavigate={navigate}
          onBack={goBack}
        />
      );
      break;
    case 'import-doc':
      content = (
        <ImportDocumentScreen
          serviceId={(route as any).serviceId}
          onDone={goBack}
        />
      );
      break;
    case 'doc-detail':
      content = (
        <DocDetailScreen
          serviceId={(route as any).serviceId}
          docId={(route as any).docId}
          onBack={goBack}
        />
      );
      break;
    case 'add-bill':
      content = (
        <AddBillScreen
          serviceId={(route as any).serviceId}
          onDone={goBack}
        />
      );
      break;
    case 'dashboard':
      content = <DashboardScreen onBack={goBack} onNavigate={navigate} />;
      break;
    case 'settings':
      content = <SettingsScreen onBack={goBack} />;
      break;
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1 onClick={goHome} style={{ cursor: 'pointer' }}>🏠 Household</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {isCloudMode && user && (
            <span className="user-badge" title={user.email || ''}>
              {user.user_metadata?.avatar_url ? (
                <img src={user.user_metadata.avatar_url} alt="" className="user-avatar" />
              ) : (
                <span className="user-avatar user-avatar--text">
                  {(user.email?.[0] || '?').toUpperCase()}
                </span>
              )}
            </span>
          )}
          <button className="btn-icon" onClick={() => navigate('settings')} title="Settings">⚙️</button>
        </div>
      </header>
      <main className="app-main">{content}</main>
      <footer className="app-footer">
        <p>
          {isCloudMode
            ? 'Data stored securely in the cloud. Each user sees only their own data.'
            : 'All data stored locally in your browser. Nothing leaves this device.'}
        </p>
      </footer>
    </div>
  );
}

/** Gate: shows login screen when in cloud mode and not authenticated */
function AuthGate() {
  const { user, loading, isCloudMode } = useAuth();

  // Sync cloud mode to storage layer
  useEffect(() => {
    setCloudMode(isCloudMode && !!user);
  }, [isCloudMode, user]);

  if (loading) {
    return (
      <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div className="spinner" />
      </div>
    );
  }

  // Cloud mode but not logged in → show login
  if (isCloudMode && !user) {
    return <LoginScreen />;
  }

  // Local mode or logged in → show app
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}
