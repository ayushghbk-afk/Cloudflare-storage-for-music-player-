import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { describeError } from '../ui';

export function Login() {
  const { login, error } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      await login(email, password);
    } catch (caught) {
      setFailure(describeError(caught, 'Sign-in failed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="brand" style={{ padding: 0, marginBottom: 18 }}>
          <div className="brand-mark" aria-hidden="true" />
          <div>
            <div className="brand-name">AETHER</div>
            <span className="brand-sub">Cloud console</span>
          </div>
        </div>

        <h1>Sign in</h1>
        <p className="small muted" style={{ marginTop: 0, marginBottom: 18 }}>
          Administrator and moderator accounts only. Listener accounts are refused here.
        </p>

        {error ? <div className="banner" style={{ marginBottom: 14 }}>{error}</div> : null}
        {failure ? <div className="banner" style={{ marginBottom: 14 }}>{failure}</div> : null}

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="owner@example.com"
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            minLength={12}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: 6 }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="small muted" style={{ marginTop: 16, marginBottom: 0 }}>
          If no administrator exists yet, the API creates one for the address in{' '}
          <span className="mono">BOOTSTRAP_ADMIN_EMAIL</span> on first registration.
        </p>
      </form>
    </div>
  );
}
