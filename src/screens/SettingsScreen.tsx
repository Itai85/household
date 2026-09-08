import { useState, useEffect } from 'react';
import { eraseAll, getAiConfig, setAiConfig, getTokenUsage, resetTokenUsage, isUsingProxy, setProxyAvailable, isUsingDemoKey } from '../platform/storage';
import { PROVIDERS, COMPATIBLE_PRESETS, isProxyAvailable, type ProviderId, type AiConfig } from '../platform/ai-providers';
import { useAuth } from '../store/AuthContext';

interface Props {
  onBack: () => void;
}

export function SettingsScreen({ onBack }: Props) {
  const { user, isCloudMode, signOut, deleteAccount } = useAuth();
  const [showConfirm, setShowConfirm] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [proxyStatus, setProxyStatus] = useState<'checking' | 'available' | 'unavailable'>(
    isUsingProxy() ? 'available' : 'checking'
  );
  const existing = getAiConfig();

  // Check server-side AI proxy availability
  useEffect(() => {
    if (isCloudMode) {
      isProxyAvailable().then(ok => {
        setProxyStatus(ok ? 'available' : 'unavailable');
        setProxyAvailable(ok);
      });
    } else {
      setProxyStatus('unavailable');
    }
  }, [isCloudMode]);
  const [providerId, setProviderId] = useState<ProviderId>(existing?.providerId || 'anthropic');
  const [apiKey, setApiKey] = useState(existing?.apiKey || '');
  const [modelId, setModelId] = useState(existing?.modelId || 'auto');
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl || '');
  const [compatPreset, setCompatPreset] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const tokenUsage = getTokenUsage();

  const provider = PROVIDERS[providerId];

  const handleProviderChange = (id: ProviderId) => {
    setProviderId(id);
    setModelId('auto');
    setApiKey('');
    setBaseUrl('');
    setCompatPreset('');
  };

  const handlePresetChange = (presetId: string) => {
    setCompatPreset(presetId);
    const preset = COMPATIBLE_PRESETS.find(p => p.id === presetId);
    if (preset) {
      setBaseUrl(preset.baseUrl);
      setModelId(preset.models[0]?.id || 'custom');
    }
  };

  const handleSave = () => {
    const config: AiConfig = {
      providerId,
      apiKey: apiKey.trim(),
      modelId,
      baseUrl: provider.requiresBaseUrl ? baseUrl.trim() : undefined,
    };
    setAiConfig(config.apiKey ? config : null);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleDisconnect = () => {
    setAiConfig(null);
    setApiKey('');
    setModelId('auto');
    setBaseUrl('');
    setSaved(false);
  };

  const handleErase = async () => {
    await eraseAll();
    window.location.reload();
  };

  const activePreset = COMPATIBLE_PRESETS.find(p => p.id === compatPreset);
  const modelOptions = activePreset ? activePreset.models : provider.models;
  const docsLink = activePreset ? activePreset.docs : provider.docs;
  const keyPlaceholder = activePreset ? activePreset.keyPlaceholder : provider.apiKeyPlaceholder;

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Settings</h2>
        <button className="btn" onClick={onBack}>← Back</button>
      </div>

      {/* ─── AI Provider ──────────────────────────────────── */}
      <div className="card">
        <h3>🤖 AI Provider</h3>

        {/* Server-side AI proxy status */}
        {isCloudMode && proxyStatus === 'available' && !existing?.apiKey && (
          <div style={{
            padding: '12px 16px',
            borderRadius: 'var(--radius-sm)',
            background: 'color-mix(in srgb, var(--ok) 8%, var(--surface))',
            border: '1px solid color-mix(in srgb, var(--ok) 25%, transparent)',
            marginBottom: '16px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          }}>
            <span style={{ fontSize: '1.2rem' }}>✨</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                <span style={{ color: 'var(--ok)' }}>● AI is ready</span> — server-side provider configured
              </div>
              <div className="muted" style={{ fontSize: '0.78rem', marginTop: '2px' }}>
                Smart document parsing works automatically. No API key needed on your end.
              </div>
            </div>
          </div>
        )}

        {isCloudMode && proxyStatus === 'available' && existing?.apiKey && (
          <div style={{
            padding: '10px 14px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--surface-2)',
            marginBottom: '12px',
            fontSize: '0.82rem',
            color: 'var(--muted)',
          }}>
            💡 A server-side AI provider is available. Your personal API key below takes priority — remove it to use the built-in AI instead.
          </div>
        )}

        {/* Demo mode badge */}
        {isUsingDemoKey() && (
          <div style={{
            padding: '12px 16px',
            borderRadius: 'var(--radius-sm)',
            background: 'color-mix(in srgb, var(--accent) 8%, var(--surface))',
            border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)',
            marginBottom: '16px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          }}>
            <span style={{ fontSize: '1.2rem' }}>🎁</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                <span style={{ color: 'var(--accent)' }}>● Demo mode</span> — free AI parsing active
              </div>
              <div className="muted" style={{ fontSize: '0.78rem', marginTop: '2px' }}>
                You can try AI document parsing right now. Add your own API key below to use your preferred provider.
              </div>
            </div>
          </div>
        )}

        <p className="muted" style={{ marginBottom: '12px' }}>
          {proxyStatus === 'available' && !existing?.apiKey
            ? 'AI is already connected via the server. You can optionally override it with your own API key below.'
            : isUsingDemoKey()
            ? 'AI parsing is available in demo mode. Add your own API key to use your preferred provider and model.'
            : 'Connect your AI to enable smart document parsing. Upload a bill or contract and AI will extract provider, amount, dates, and category automatically.'}
        </p>

        {/* Provider selector */}
        <div className="chips" style={{ gap: '8px', marginBottom: '16px' }}>
          {Object.values(PROVIDERS).map(p => (
            <button
              key={p.id}
              className="chip"
              aria-selected={providerId === p.id}
              onClick={() => handleProviderChange(p.id)}
            >
              {p.icon} {p.label.split(' (')[0]}
            </button>
          ))}
        </div>

        {/* How to get an API key — provider-specific guide */}
        {!existing?.apiKey && providerId !== 'openai-compatible' && (
          <div style={{
            padding: '14px 16px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--surface-2)',
            border: '1px solid var(--line)',
            marginBottom: '16px',
            fontSize: '0.85rem',
            lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 600, marginBottom: '8px' }}>
              📋 How to get a {provider.label.split(' (')[0]} API key
              {providerId === 'gemini' && <span style={{ marginLeft: '8px', fontSize: '0.75rem', padding: '2px 8px', borderRadius: '12px', background: 'color-mix(in srgb, var(--ok) 12%, transparent)', color: 'var(--ok)' }}>Free</span>}
            </div>
            {providerId === 'anthropic' && (
              <ol style={{ paddingLeft: '18px', margin: 0, color: 'var(--text)' }}>
                <li>Go to <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>console.anthropic.com</a></li>
                <li>Sign up or log in</li>
                <li>Click <strong>Create Key</strong> and copy it (starts with <code style={{ fontSize: '0.8rem' }}>sk-ant-</code>)</li>
                <li>Paste below</li>
              </ol>
            )}
            {providerId === 'openai' && (
              <ol style={{ paddingLeft: '18px', margin: 0, color: 'var(--text)' }}>
                <li>Go to <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>platform.openai.com/api-keys</a></li>
                <li>Sign up or log in</li>
                <li>Click <strong>Create new secret key</strong> and copy it (starts with <code style={{ fontSize: '0.8rem' }}>sk-</code>)</li>
                <li>Paste below</li>
              </ol>
            )}
            {providerId === 'gemini' && (
              <ol style={{ paddingLeft: '18px', margin: 0, color: 'var(--text)' }}>
                <li>Go to <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>aistudio.google.com/apikey</a></li>
                <li>Sign in with your Google account</li>
                <li>Click <strong>Create API key</strong> — no credit card needed</li>
                <li>Copy the key (starts with <code style={{ fontSize: '0.8rem' }}>AIza</code>) and paste below</li>
              </ol>
            )}
            <p className="muted" style={{ marginTop: '8px', fontSize: '0.78rem' }}>
              {providerId === 'gemini'
                ? 'Google Gemini offers a generous free tier (15 requests/minute). No payment required.'
                : `Typical cost: ~$0.001–0.005 per document parsed.`}
            </p>
          </div>
        )}

        {/* Compatible presets (only for openai-compatible) */}
        {providerId === 'openai-compatible' && (
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '6px' }}>
              Quick setup:
            </label>
            <div className="chips" style={{ gap: '6px' }}>
              {COMPATIBLE_PRESETS.map(preset => (
                <button
                  key={preset.id}
                  className="chip"
                  aria-selected={compatPreset === preset.id}
                  onClick={() => handlePresetChange(preset.id)}
                >
                  {preset.icon} {preset.label}
                </button>
              ))}
              <button
                className="chip"
                aria-selected={compatPreset === ''}
                onClick={() => { setCompatPreset(''); setBaseUrl(''); }}
              >
                🔧 Custom
              </button>
            </div>
          </div>
        )}

        {/* Base URL (for compatible providers) */}
        {provider.requiresBaseUrl && (
          <div className="field" style={{ marginBottom: '12px' }}>
            <label>API Base URL</label>
            <input
              className="input"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder={provider.defaultBaseUrl}
            />
          </div>
        )}

        {/* API Key */}
        <div className="field" style={{ marginBottom: '12px' }}>
          <label>API Key</label>
          <div className="row" style={{ gap: '8px', flexWrap: 'wrap' }}>
            <input
              className="input"
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={keyPlaceholder}
              style={{ flex: 1, minWidth: '200px' }}
            />
            <button className="btn btn--outline" onClick={() => setShowKey(!showKey)}>
              {showKey ? '🙈' : '👁️'}
            </button>
          </div>
        </div>

        {/* Model selection */}
        <div className="field" style={{ marginBottom: '12px' }}>
          <label>Model</label>
          <div className="chips" style={{ gap: '6px' }}>
            <button
              className="chip"
              aria-selected={modelId === 'auto'}
              onClick={() => setModelId('auto')}
            >
              🔄 Auto
            </button>
            {modelOptions.map(m => (
              <button
                key={m.id}
                className="chip"
                aria-selected={modelId === m.id}
                onClick={() => setModelId(m.id)}
                title={m.description}
              >
                {m.tier === 'fast' ? '⚡' : '🧠'} {m.label}
              </button>
            ))}
            {providerId === 'openai-compatible' && (
              <input
                className="input"
                placeholder="Custom model name"
                value={modelId !== 'auto' && !modelOptions.find(m => m.id === modelId) ? modelId : ''}
                onChange={e => setModelId(e.target.value || 'auto')}
                style={{ maxWidth: '200px' }}
              />
            )}
          </div>
          <p className="muted" style={{ marginTop: '6px', fontSize: '0.78rem' }}>
            {modelId === 'auto'
              ? 'Auto: uses a fast model for simple bills, a smarter model for insurance/complex docs'
              : modelOptions.find(m => m.id === modelId)?.description || modelId}
          </p>
        </div>

        {/* Action buttons */}
        <div className="row" style={{ gap: '8px', marginTop: '12px' }}>
          <button className="btn btn--primary" onClick={handleSave}>
            {saved ? '✅ Saved' : '💾 Save'}
          </button>
          {existing?.apiKey && (
            <button className="btn btn--outline" onClick={handleDisconnect}>
              Disconnect
            </button>
          )}
        </div>

        {/* Status */}
        {apiKey && (
          <p style={{ marginTop: '10px', fontSize: '0.85rem' }}>
            <span style={{ color: 'var(--ok)' }}>● Connected</span> — {provider.icon} {provider.label}
          </p>
        )}
        {!apiKey && !isUsingDemoKey() && (
          <p style={{ marginTop: '10px', fontSize: '0.85rem' }}>
            <span style={{ color: 'var(--muted)' }}>○ Not configured</span> — Using basic regex extraction (less accurate)
          </p>
        )}
        {!apiKey && isUsingDemoKey() && (
          <p style={{ marginTop: '10px', fontSize: '0.85rem' }}>
            <span style={{ color: 'var(--accent)' }}>● Demo mode</span> — AI parsing available. Add your own key for full control.
          </p>
        )}

        {/* Docs link */}
        {docsLink && (
          <p className="muted" style={{ marginTop: '6px', fontSize: '0.78rem' }}>
            Your API key stays in this browser's localStorage only. Nothing is sent to our servers.
            {' '}Get a key at <a href={docsLink} target="_blank" rel="noopener" style={{ color: 'var(--accent)' }}>{docsLink.replace(/^https?:\/\//, '')}</a>
          </p>
        )}
      </div>

      {/* ─── Token usage ──────────────────────────────────── */}
      {tokenUsage.callCount > 0 && (
        <div className="card">
          <h3>📊 Token Usage</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', margin: '8px 0' }}>
            <div style={{ textAlign: 'center', padding: '12px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)' }}>
              <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--accent)' }}>{tokenUsage.callCount}</div>
              <div className="muted" style={{ fontSize: '0.8rem' }}>API calls</div>
            </div>
            <div style={{ textAlign: 'center', padding: '12px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)' }}>
              <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--accent)' }}>
                {((tokenUsage.totalInputTokens + tokenUsage.totalOutputTokens) / 1000).toFixed(1)}k
              </div>
              <div className="muted" style={{ fontSize: '0.8rem' }}>total tokens</div>
            </div>
            <div style={{ textAlign: 'center', padding: '12px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)' }}>
              <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--ok)' }}>
                ${tokenUsage.totalCostUSD.toFixed(4)}
              </div>
              <div className="muted" style={{ fontSize: '0.8rem' }}>estimated cost</div>
            </div>
            <div style={{ textAlign: 'center', padding: '12px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)' }}>
              <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--muted)' }}>
                ${(tokenUsage.totalCostUSD / tokenUsage.callCount).toFixed(4)}
              </div>
              <div className="muted" style={{ fontSize: '0.8rem' }}>avg per doc</div>
            </div>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' }}>
            <span className="muted" style={{ fontSize: '0.78rem' }}>
              Last used: {tokenUsage.lastUsed || 'never'}
            </span>
            <button className="btn btn--outline btn--small" onClick={() => { resetTokenUsage(); window.location.reload(); }}>
              Reset counter
            </button>
          </div>
        </div>
      )}

      {/* ─── Account ──────────────────────────────────────── */}
      {isCloudMode && user && (
        <div className="card">
          <h3>👤 Account</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
            {user.user_metadata?.avatar_url ? (
              <img src={user.user_metadata.avatar_url} alt="" className="user-avatar" style={{ width: 40, height: 40 }} />
            ) : (
              <span className="user-avatar user-avatar--text" style={{ width: 40, height: 40, fontSize: '1rem' }}>
                {(user.email?.[0] || '?').toUpperCase()}
              </span>
            )}
            <div>
              <div style={{ fontWeight: 600 }}>{user.user_metadata?.full_name || user.email}</div>
              {user.user_metadata?.full_name && (
                <div className="muted" style={{ fontSize: '0.85rem' }}>{user.email}</div>
              )}
            </div>
          </div>
          <div className="row" style={{ gap: '8px' }}>
            <button className="btn btn--outline" onClick={() => signOut()}>Sign Out</button>
          </div>
        </div>
      )}

      {/* ─── Data Storage ──────────────────────────────────── */}
      <div className="card">
        <h3>🔒 Data Storage</h3>
        {isCloudMode ? (
          <>
            <p>Your data is stored securely in the cloud with encryption at rest. Each user's data is fully isolated — no one else can see your bills or services.</p>
            <p className="muted">When AI parsing is enabled, only the cleaned document text (boilerplate stripped) is sent to your configured AI provider. Raw files are stored encrypted in the cloud.</p>
          </>
        ) : (
          <>
            <p>All your data is stored locally in your browser using IndexedDB. Nothing is sent to any server.</p>
            <p className="muted">When AI parsing is enabled, only the cleaned document text (boilerplate stripped) is sent to your configured AI provider. Raw files stay local.</p>
          </>
        )}
      </div>

      {/* ─── Danger Zone ──────────────────────────────────── */}
      <div className="card card--warn">
        <h3>⚠️ Danger Zone</h3>
        <p>Permanently delete all {isCloudMode ? 'your' : ''} data, including all services, bills, documents, and uploaded files.</p>
        {!showConfirm ? (
          <button className="btn btn--danger" onClick={() => setShowConfirm(true)}>Erase All Data</button>
        ) : (
          <div className="stack">
            <p><strong>Are you sure?</strong> This cannot be undone.</p>
            <div className="row">
              <button className="btn btn--danger" onClick={handleErase}>Yes, Erase Everything</button>
              <button className="btn" onClick={() => setShowConfirm(false)}>Cancel</button>
            </div>
          </div>
        )}
        {isCloudMode && user && (
          <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--line)' }}>
            <p style={{ marginBottom: '8px' }}>Delete your account and all associated data permanently.</p>
            {!showDeleteAccount ? (
              <button className="btn btn--danger btn--outline" onClick={() => setShowDeleteAccount(true)}>
                Delete My Account
              </button>
            ) : (
              <div className="stack">
                <p><strong>This will permanently delete your account and ALL your data.</strong> You'll need to create a new account to use the app again.</p>
                <div className="row">
                  <button className="btn btn--danger" onClick={async () => { await deleteAccount(); }}>
                    Yes, Delete My Account
                  </button>
                  <button className="btn" onClick={() => setShowDeleteAccount(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
