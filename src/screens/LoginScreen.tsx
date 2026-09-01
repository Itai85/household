import { useState } from 'react';
import { useAuth } from '../store/AuthContext';

export function LoginScreen() {
  const { signInWithGoogle, signInWithEmail } = useAuth();
  const [email, setEmail] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleGoogle = async () => {
    setLoading(true);
    setError('');
    try {
      await signInWithGoogle();
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  };

  const handleEmail = async () => {
    if (!email.trim()) return;
    setLoading(true);
    setError('');
    const result = await signInWithEmail(email.trim());
    setLoading(false);
    if (result.error) {
      setError(result.error);
    } else {
      setEmailSent(true);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">🏠</div>
        <h1 className="login-title">Household</h1>
        <p className="login-subtitle">
          Track your bills, contracts, and household expenses — all in one place.
        </p>

        {emailSent ? (
          <div className="login-sent">
            <p style={{ fontSize: '2rem', marginBottom: '8px' }}>✉️</p>
            <p><strong>Check your email!</strong></p>
            <p className="muted" style={{ marginTop: '4px' }}>
              We sent a login link to <strong>{email}</strong>. Click it to sign in.
            </p>
            <button
              className="btn btn--outline"
              style={{ marginTop: '16px' }}
              onClick={() => { setEmailSent(false); setEmail(''); }}
            >
              Try another email
            </button>
          </div>
        ) : (
          <>
            <button
              className="btn btn--google"
              onClick={handleGoogle}
              disabled={loading}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" style={{ marginRight: '8px' }}>
                <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
                <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
                <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
                <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>
              </svg>
              Continue with Google
            </button>

            <div className="login-divider">
              <span>or</span>
            </div>

            <div className="login-email-form">
              <input
                className="input"
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleEmail(); }}
                disabled={loading}
              />
              <button
                className="btn btn--primary"
                onClick={handleEmail}
                disabled={loading || !email.trim()}
              >
                {loading ? 'Sending...' : 'Send Magic Link'}
              </button>
            </div>

            {error && (
              <p className="login-error">{error}</p>
            )}
          </>
        )}

        <p className="login-footer">
          Your data stays private. Each user sees only their own bills and services.
        </p>
      </div>
    </div>
  );
}
