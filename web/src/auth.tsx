import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getAccessToken, setTokens, type AuthUser } from './api';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  /** True when the API is reachable but nobody is signed in. */
  signedOut: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  isStaff: boolean;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!getAccessToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const response = await api.me();
      setUser(response.user);
      setError(null);
    } catch {
      // A stale token must not strand the console on a spinner.
      setTokens(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    const result = await api.login(email.trim(), password);
    if (result.user.role !== 'admin' && result.user.role !== 'moderator') {
      setTokens(null);
      setError('This account does not have access to the console.');
      return;
    }
    setTokens({ accessToken: result.accessToken, refreshToken: result.refreshToken });
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    const refreshToken = sessionStorage.getItem('aether.console.refresh');
    try {
      if (refreshToken) await api.logout(refreshToken);
    } catch {
      // Signing out locally is what matters; the server token expires anyway.
    } finally {
      setTokens(null);
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      signedOut: !user && !loading,
      error,
      login,
      logout,
      reload,
      isStaff: user?.role === 'admin' || user?.role === 'moderator',
      isAdmin: user?.role === 'admin',
    }),
    [user, loading, error, login, logout, reload]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
