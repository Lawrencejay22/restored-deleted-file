import { LogIn, HelpCircle, Shield, RefreshCw, Trash2 } from 'lucide-react';

function Login({ onLogin }) {
  return (
    <div className="login-container" style={{ display: 'flex', flexDirection: 'column', gap: '24px', alignItems: 'center' }}>
      <div className="glass-panel login-card" style={{ maxWidth: '520px', width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', marginBottom: '8px', flexWrap: 'wrap' }}>
          <Trash2 size={32} color="var(--accent-color)" />
          <h1 style={{ fontSize: '26px', margin: 0 }}>Google Drive Trash Manager</h1>
        </div>
        <p style={{ margin: '16px 0 24px', lineHeight: '1.6' }}>
          View, download, and recover files from your Drive Trash. Back up your active files locally so you can restore them even if they are permanently deleted from Google Drive.
        </p>

        <button className="btn" onClick={onLogin} style={{ width: '100%', justifyContent: 'center', padding: '14px', fontSize: '16px' }}>
          <LogIn size={20} />
          Sign In with Google
        </button>

        <p style={{ marginTop: '16px', fontSize: '12px', color: 'var(--text-secondary)', textAlign: 'center' }}>
          You will be asked to grant access to view and manage your Google Drive files.
        </p>
      </div>

      <div className="glass-panel" style={{ maxWidth: '520px', width: '100%', padding: '24px', animation: 'fadeIn 0.5s ease-out' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', color: 'var(--accent-color)' }}>
          <HelpCircle size={20} />
          How Permanent Recovery Works
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '14px', lineHeight: '1.6', color: 'var(--text-secondary)' }}>
          <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{ color: 'var(--accent-color)', flexShrink: 0 }}><RefreshCw size={18} /></div>
            <div>
              <strong style={{ color: 'var(--text-primary)' }}>1. Sync Your Files:</strong> Log in and let the app run a background sync. This securely caches your Drive files (under 25MB) inside your browser's private database (IndexedDB). Only you can access this data.
            </div>
          </div>

          <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{ color: 'var(--success-color)', flexShrink: 0 }}><Shield size={18} /></div>
            <div>
              <strong style={{ color: 'var(--text-primary)' }}>2. Safe Recovery:</strong> If a backed-up file is later "Deleted Forever" from Google Drive, it will appear here as{' '}
              <span className="badge badge-warning" style={{ fontSize: '11px', padding: '2px 6px' }}>Deleted Forever (Recoverable)</span>. You can restore it back to Drive with one click!
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--surface-border)', paddingTop: '12px', marginTop: '4px', fontSize: '12px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
            Note: Files that were already permanently deleted from Google Drive before you ran a sync cannot be recovered, as Google's servers have already purged them. This app only recovers files it has previously backed up.
          </div>
        </div>
      </div>
    </div>
  );
}

export default Login;
